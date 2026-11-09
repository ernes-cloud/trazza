/**
 * Server-side notification cron job.
 *
 * ÚNICA fuente de avisos de dividendos, resultados y alertas de precio. Hasta el
 * 2026-10-02 convivía con tres monitores del navegador (Dividend/Earnings/
 * WatchlistMonitor) que escribían LOS MISMOS avisos: cada aviso salía dos o tres
 * veces (y otros tantos correos), y el de "dividendo cobrado" se repetía durante
 * 30 días. No vuelvas a generar notificaciones desde el cliente.
 *
 * Los textos, el idioma y las cuentas de calendario viven en
 * lib/notificationText.js (puro, testeado); la decisión de cada alerta de
 * Favoritos en lib/watchlistAlerts.js. Aquí solo se leen datos y se escribe.
 *
 * Schedule:
 *   - Dividends + Earnings: on startup, then every 6 hours
 *   - Watchlist price alerts: on startup, then every 5 minutes
 *
 * Once a notification is inserted into Supabase the existing webhook
 * (/webhooks/notify → emailNotify.js) delivers the email automatically.
 */

import { supabaseAdmin } from '../lib/adminSupabase.js';
// Ticker map, pence handling and quote fetching live in the shared module
// (also used by the portfolio snapshots cron).
import { resolveTicker, getYahooQuotes } from '../lib/marketQuotes.js';
import { wantsEmail } from '../lib/emailPrefs.js';
import { madridDayStartUtc } from '../lib/emailQuota.js';
import { fetchAllRows } from '../lib/fetchAllRows.js';
import { evaluateWatchlistAlert } from '../lib/watchlistAlerts.js';
import {
  langOf, exDividendNotice, dividendPaidNotice, earningsUpcomingNotice, earningsResultNotice,
  priceTargetNotice, percentMoveNotice, portfolioMoveNotice,
} from '../lib/notificationText.js';
import {
  getDividendFromYahoo, getEarningsFromYahoo, fetchDividendCalendar, fetchEarningsCalendar,
} from '../lib/marketCalendar.js';
import { isCashPosition } from '../../src/lib/positionKind.js';

export const includesInvestedNotificationPosition = (position) => !isCashPosition(position);

// Cada mercado tiene su propio horario: NYSE abre a las 9:30 ET, BME a las 9:00 CET,
// LSE a las 8:00 GMT, TSE a las 9:00 JST... Un guard global por zona horaria falla
// en carteras multi-mercado.
//
// Yahoo devuelve `regularMarketTime` (Unix seconds) indicando cuándo fue el último
// tick. Si ese timestamp no corresponde al día UTC de hoy, el percentChange que
// Yahoo muestra es del cierre de la sesión anterior — disparar una alerta con esos
// datos generaría notificaciones fantasma (ej. "AMZN subió 15% hoy" el lunes por
// la mañana cuando el movimiento fue el viernes por earnings).
function isQuoteFresh(regularMarketTime) {
  if (!regularMarketTime) return false;
  const tradeDay = new Date(regularMarketTime * 1000).toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const todayUTC = new Date().toISOString().slice(0, 10);
  return tradeDay === todayUTC;
}

// Fecha local de Madrid en 'YYYY-MM-DD'. El servidor corre en UTC y los avisos
// son de calendario: con toISOString() una pasada a las 00:30 de Madrid
// avisaría con la fecha de ayer.
function madridToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Built once per cron run, cleared before the next run
let _divCalCache = null;
let _earnCalCache = null;

async function buildDivCalendar() {
  if (!_divCalCache) _divCalCache = await fetchDividendCalendar(30, 90);
  return _divCalCache;
}

async function buildEarnCalendar() {
  if (!_earnCalCache) _earnCalCache = await fetchEarningsCalendar(14, 45);
  return _earnCalCache;
}

// Posiciones con cantidad, paginadas (PostgREST corta en 1.000 filas: ver fetchAllRows).
const loadActivePositions = (select, extra = (q) => q) =>
  fetchAllRows(() => extra(supabaseAdmin.from('positions').select(select).gt('quantity', 0)).order('id'));

// ─── Notification helpers ─────────────────────────────────────────────────────

// Escribe una fila en `notifications` (el webhook de Supabase la convierte en
// correo). Dos cosas que antes no hacía:
//  - Comprueba el error. El insert se hacía a ciegas y un fallo (RLS, columna,
//    red) se perdía sin rastro mientras el log decía que se había notificado.
//  - `sendEmail: false` marca la fila para que emailNotify NO mande correo (el
//    interruptor de email de cada alerta de Favoritos no lo leía nadie). Si la
//    columna `send_email` aún no existe (migración 20261002 sin aplicar), se
//    reintenta sin ella: perder el matiz del correo es mejor que perder el aviso.
async function insertNotificationRow({ userId, title, message, type, sendEmail = true }) {
  const row = {
    user_id: userId,
    title,
    message,
    type,
    is_read: false,
    created_at: new Date().toISOString(),
  };
  let { error } = await supabaseAdmin
    .from('notifications')
    .insert(sendEmail ? row : { ...row, send_email: false });

  if (error && !sendEmail && (error.code === 'PGRST204' || error.code === '42703')) {
    console.warn('[notificationCron] notifications.send_email missing — apply migration 20261002');
    ({ error } = await supabaseAdmin.from('notifications').insert(row));
  }
  if (error) {
    console.error(`[notificationCron] Insert failed for ${userId.slice(0, 8)}…: ${error.message}`);
    return false;
  }
  return true;
}

// Preferencias por usuario, cacheadas 5 min (la pasada de alertas corre cada
// 5). select('*') a propósito: una columna nombrada que aún no exista tumbaría
// la consulta entera (ver CLAUDE.md).
const PREFS_TTL_MS = 5 * 60 * 1000;
const prefsCache = new Map();   // userId → { at, prefs }

async function userPrefs(userId) {
  const hit = prefsCache.get(userId);
  if (hit && Date.now() - hit.at < PREFS_TTL_MS) return hit.prefs;
  const { data, error } = await supabaseAdmin.from('user_preferences').select('*').eq('user_id', userId).maybeSingle();
  // Si no se puede leer, se deja pasar el correo: emailNotify vuelve a mirar el
  // interruptor general, y perder un aviso es peor que mandar uno de más.
  if (error) console.warn(`[notificationCron] prefs read failed for ${userId.slice(0, 8)}…: ${error.message}`);
  const prefs = error ? null : data;
  prefsCache.set(userId, { at: Date.now(), prefs });
  return prefs;
}

async function emailAllowedFor(userId, category) {
  return wantsEmail(await userPrefs(userId), category);
}

/** Idioma de los avisos de ese usuario: el que guarda la app (español por defecto). */
async function langFor(userId) {
  return langOf((await userPrefs(userId))?.language);
}

// `dedupKey` es un prefijo LITERAL: se escapan los comodines de ilike (un
// ticker como "BRK_B" casaría con "BRKAB").
const escapeLike = (v) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

// Insert a notification with dedup.
// permanent=false (default) → dedup window de 24 h (evita spam del cron en el mismo día).
// permanent=true            → sin límite de tiempo (notificación única de por vida).
// category → interruptor de correo de Ajustes que aplica ('dividends' | 'earnings' | 'alerts');
//            null = solo el interruptor general.
async function insertNotification(userId, title, message, type, dedupKey = null, permanent = false, category = null) {
  const matchKey = dedupKey ?? message;

  let query = supabaseAdmin
    .from('notifications')
    .select('id')
    .eq('user_id', userId)
    .ilike('message', `${escapeLike(matchKey)}%`);

  if (!permanent) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    query = query.gte('created_at', since);
  }

  const { data: existing, error } = await query.limit(1);
  // Sin poder comprobar el dedupe no se inserta: si la BD está caída el insert
  // fallaría igual, y si solo falla la lectura saldría un aviso repetido.
  if (error) {
    console.error(`[notificationCron] Dedup check failed for ${userId.slice(0, 8)}…: ${error.message}`);
    return false;
  }
  if (existing?.length > 0) return false;

  const sendEmail = await emailAllowedFor(userId, category);
  const ok = await insertNotificationRow({ userId, title, message, type, sendEmail });
  if (ok) console.log(`[notificationCron] → user ${userId.slice(0, 8)}…: "${title}"${sendEmail ? '' : ' (sin correo)'}`);
  return ok;
}

// ─── Dividend + Earnings check ────────────────────────────────────────────────

export async function checkDividendsAndEarnings() {
  console.log('[notificationCron] Running dividends/earnings check…');

  const { data: positions, error } = await loadActivePositions('id, quantity, assets(ticker, asset_class), brokers(user_id)');

  if (error) {
    console.error('[notificationCron] Failed to load positions:', error.message);
    return false;   // pasada fallida: sin latido
  }
  if (!positions?.length) {
    console.log('[notificationCron] No active positions found.');
    return true;    // nada que vigilar no es un fallo
  }

  const invested = positions.filter(includesInvestedNotificationPosition);

  // Build Nasdaq calendars once for this run (US stocks)
  const [divCal, earnCal] = await Promise.all([
    buildDivCalendar().catch(() => ({})),
    buildEarnCalendar().catch(() => ({})),
  ]);

  const seen = new Set(); // "userId:ticker" — avoid duplicate work
  const now = new Date();
  const today = madridToday();

  for (const p of invested) {
    const userId = p.brokers?.user_id;
    const rawTicker = p.assets?.ticker;
    if (!userId || !rawTicker) continue;

    const ticker = resolveTicker(rawTicker);
    const key = `${userId}:${ticker}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lang = await langFor(userId);

    // ── Dividends ─────────────────────────────────────────────────────────
    try {
      const divData = divCal[ticker] ?? await getDividendFromYahoo(ticker);
      if (divData?.exDate) {
        // En la divisa del dividendo (CSU.TO paga en CAD), no "$" fijo.
        const common = { ticker, amount: divData.amount ?? null, currency: divData.currency || 'USD', lang };
        const ex = exDividendNotice({ ...common, exDate: divData.exDate, estimated: !!divData.estimated, today });
        if (ex) await insertNotification(userId, ex.title, ex.message, ex.type, ex.dedup, false, 'dividends');

        if (divData.paymentDate) {
          const paid = dividendPaidNotice({ ...common, paymentDate: divData.paymentDate, quantity: parseFloat(p.quantity || 0), today });
          if (paid) await insertNotification(userId, paid.title, paid.message, paid.type, paid.dedup, true, 'dividends');
        }
      }
    } catch (e) {
      console.warn(`[notificationCron] Dividend check failed for ${ticker}:`, e.message);
    }

    // ── Earnings ──────────────────────────────────────────────────────────
    try {
      const earnData = earnCal[ticker] ?? await getEarningsFromYahoo(ticker);
      if (earnData?.date) {
        const soon = earningsUpcomingNotice({ ticker, date: earnData.date, today, lang });
        if (soon) await insertNotification(userId, soon.title, soon.message, soon.type, soon.dedup, false, 'earnings');

        // Resultado: desde ~20 h después del día de publicación (los de EE. UU.
        // salen tras el cierre) y hasta una semana después.
        const daysUntil = (new Date(earnData.date) - now) / (1000 * 60 * 60 * 24);
        if (earnData.epsActual != null && daysUntil <= -(20 / 24) && daysUntil >= -7) {
          const r = earningsResultNotice({
            ticker, date: earnData.date, epsActual: earnData.epsActual,
            epsForecast: earnData.epsForecast ?? null, surprisePct: earnData.surprisePct ?? null, lang,
          });
          await insertNotification(userId, r.title, r.message, r.type, r.dedup, true, 'earnings');
        }
      }
    } catch (e) {
      console.warn(`[notificationCron] Earnings check failed for ${ticker}:`, e.message);
    }
  }

  console.log('[notificationCron] Dividends/earnings check done.');
  return true;
}

// ─── Watchlist alert check ────────────────────────────────────────────────────

async function checkWatchlistAlerts() {
  // PENDING + TRIGGERED: las de variación diaria siguen vivas tras saltar; las
  // de precio objetivo cumplidas las descarta evaluateWatchlistAlert.
  const { data: alerts, error } = await fetchAllRows(() => supabaseAdmin
    .from('watchlist_alerts')
    .select(`
      id, alert_type, target_value, initial_price, status, email_notify,
      watchlist_items!inner(
        ticker,
        watchlists!inner(user_id)
      )
    `)
    .in('status', ['PENDING', 'TRIGGERED'])
    .order('id'));

  if (error) {
    console.error('[notificationCron] Failed to load watchlist alerts:', error.message);
    return;
  }
  const live = (alerts || []).filter((a) => !(a.alert_type === 'PRICE_TARGET' && a.status === 'TRIGGERED'));
  if (!live.length) return;

  // Resolve tickers (e.g. CSU → CSU.TO) before fetching prices
  const rawToResolved = new Map(
    live.map((a) => [a.watchlist_items.ticker, resolveTicker(a.watchlist_items.ticker)])
  );
  const tickers = [...new Set(rawToResolved.values())];
  const priceMap = await getYahooQuotes(tickers);

  // "Un aviso al día" con el día de MADRID: con la medianoche del server (UTC)
  // el contador se reiniciaba a las 02:00 en España.
  const dayStart = madridDayStartUtc().toISOString();

  for (const alert of live) {
    const ticker = alert.watchlist_items.ticker;
    const resolvedTicker = rawToResolved.get(ticker) || ticker;
    const userId = alert.watchlist_items.watchlists.user_id;
    const quote = priceMap.get(resolvedTicker);
    if (!quote) continue;
    // Skip si el último tick de Yahoo no es de hoy en UTC — el percentChange sería del cierre anterior
    if (!isQuoteFresh(quote.regularMarketTime)) continue;

    const hit = evaluateWatchlistAlert(alert, quote);
    if (!hit) continue;

    const lang = await langFor(userId);
    const n = hit.kind === 'price'
      ? priceTargetNotice({ ticker: resolvedTicker, target: alert.target_value, currency: quote.currency || 'USD', upside: hit.upside, lang })
      : percentMoveNotice({ ticker: resolvedTicker, change: hit.change, target: hit.target, lang });

    if (hit.kind === 'price') {
      // Cumplida: no vuelve a avisar hasta que el usuario la reactive en Favoritos.
      const { error: upErr } = await supabaseAdmin
        .from('watchlist_alerts')
        .update({ status: hit.nextStatus })
        .eq('id', alert.id);
      if (upErr) {
        // Sin marcarla, cada pasada la dispararía otra vez: mejor no avisar ahora.
        console.error(`[notificationCron] Could not mark alert ${alert.id} as triggered: ${upErr.message}`);
        continue;
      }
    }

    // Dedup: un aviso por alerta y día. El patrón de variación lleva comodines a propósito.
    const { data: existing, error: dupErr } = await supabaseAdmin
      .from('notifications')
      .select('id')
      .eq('user_id', userId)
      .ilike('message', n.dedup)
      .gte('created_at', dayStart)
      .limit(1);

    if (dupErr) {
      console.error('[notificationCron] Alert dedup check failed:', dupErr.message);
      continue;
    }
    if (existing?.length > 0) continue;

    const ok = await insertNotificationRow({
      userId,
      title: n.title,
      message: n.message,
      type: n.type,
      sendEmail: alert.email_notify !== false && await emailAllowedFor(userId, 'alerts'),
    });
    if (ok) console.log(`[notificationCron] Watchlist alert fired: ${n.message}`);
  }
}

// ─── Portfolio-level alert check (cartera general) ─────────────────────────────

async function checkPortfolioAlerts() {
  // Each alert is scoped: scope === 'general' (all brokers) or a broker id.
  const { data: alerts, error } = await fetchAllRows(() => supabaseAdmin
    .from('portfolio_alerts')
    .select('user_id, scope, threshold_pct, direction')
    .eq('enabled', true)
    .order('user_id')
    .order('scope'));

  if (error) {
    console.error('[notificationCron] Failed to load portfolio alerts:', error.message);
    return;
  }
  if (!alerts?.length) return;

  const alertUsers = [...new Set(alerts.map((a) => a.user_id))];

  // Solo las posiciones de los usuarios con alguna alerta (antes, las de todos).
  const { data: positions, error: posErr } = await loadActivePositions(
    'id, quantity, broker_id, assets(ticker, asset_class), brokers!inner(user_id, name)',
    (q) => q.in('brokers.user_id', alertUsers),
  );

  if (posErr) {
    console.error('[notificationCron] Failed to load positions for portfolio alerts:', posErr.message);
    return;
  }

  const byUser = new Map();        // userId → [{ brokerId, ticker, qty }]
  const brokerName = new Map();    // brokerId → name
  const allTickers = new Set();
  for (const p of positions || []) {
    const userId = p.brokers?.user_id;
    if (!userId) continue;
    const raw = p.assets?.ticker;
    if (!raw) continue;
    if (isCashPosition(p)) continue;
    const qty = parseFloat(p.quantity || 0);
    if (qty <= 0) continue;
    const ticker = resolveTicker(raw);
    if (!byUser.has(userId)) byUser.set(userId, []);
    byUser.get(userId).push({ brokerId: p.broker_id, ticker, qty });
    if (p.broker_id) brokerName.set(p.broker_id, p.brokers?.name || '');
    allTickers.add(ticker);
  }
  if (!allTickers.size) return;

  const priceMap = await getYahooQuotes([...allTickers]);

  for (const alert of alerts) {
    const holdings = (byUser.get(alert.user_id) || [])
      .filter((h) => alert.scope === 'general' || h.brokerId === alert.scope);
    if (!holdings.length) continue;

    // Value-weighted daily change in native terms (intraday FX moves ignored —
    // a fair approximation of the scope's daily move).
    let valToday = 0;
    let valPrev = 0;
    for (const h of holdings) {
      const q = priceMap.get(h.ticker);
      // Solo contribuyen tickers con dato de hoy — excluye cierres de sesiones anteriores
      if (!q || !q.current || !isQuoteFresh(q.regularMarketTime)) continue;
      const v = h.qty * q.current;
      valToday += v;
      valPrev += v / (1 + (q.percentChange || 0) / 100);
    }
    if (valPrev <= 0) continue;

    const pct = ((valToday - valPrev) / valPrev) * 100;
    const thr = Math.abs(alert.threshold_pct);
    const hit =
      alert.direction === 'up'   ? pct >= thr :
      alert.direction === 'down' ? pct <= -thr :
                                   Math.abs(pct) >= thr;
    if (!hit) continue;

    const isGeneral = alert.scope === 'general';
    const n = portfolioMoveNotice({
      brokerName: isGeneral ? null : (brokerName.get(alert.scope) || null),
      pct, threshold: thr, lang: await langFor(alert.user_id),
    });
    await insertNotification(alert.user_id, n.title, n.message, n.type, n.dedup, false, 'alerts');
  }
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

// Una pasada lenta (Yahoo con 429, Supabase lento) no puede solaparse con la
// siguiente: las dos leerían "no hay aviso hoy" y lo insertarían dos veces.
function exclusive(name, fn) {
  let running = false;
  return () => {
    if (running) {
      console.warn(`[notificationCron] ${name}: la pasada anterior sigue en marcha, se salta`);
      return;
    }
    running = true;
    Promise.resolve()
      .then(fn)
      .catch((e) => console.error(`[notificationCron] ${name} error:`, e.message))
      .finally(() => { running = false; });
  };
}

export function startNotificationCron() {
  if (!supabaseAdmin) {
    console.warn('[notificationCron] Supabase admin client not configured — cron disabled.');
    return;
  }

  console.log('[notificationCron] Starting…');

  const runDivEarn = exclusive('dividends/earnings', async () => {
    _divCalCache = null;  // fresh Nasdaq data each run
    _earnCalCache = null;
    await checkDividendsAndEarnings();
  });
  const runWatchlist = exclusive('watchlist', checkWatchlistAlerts);
  const runPortfolio = exclusive('portfolio', checkPortfolioAlerts);

  // Run immediately on startup
  runDivEarn();
  runWatchlist();
  runPortfolio();

  // Dividends/earnings every 6 hours
  setInterval(runDivEarn, 6 * 60 * 60 * 1000);

  // Watchlist price alerts every 5 minutes
  setInterval(runWatchlist, 5 * 60 * 1000);

  // Portfolio-level alert every 15 minutes
  setInterval(runPortfolio, 15 * 60 * 1000);
}
