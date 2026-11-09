/**
 * Informe semanal de cartera por correo (lunes desde las 08:00 de Madrid).
 *
 * Corre cada hora y solo actúa dentro de la ventana; la deduplicación persiste en
 * `report_sends` (una fila por usuario y semana de Madrid).
 *
 * Quién lo recibe: usuarios con foto en `portfolio_snapshots` (scope general),
 * cartera con valor > 0 y el correo permitido: `wantsEmail(prefs, 'weekly')`,
 * es decir, el interruptor general Y el de "Informe semanal" de Ajustes.
 *
 * Toda la lógica de fechas, cálculo y HTML vive en lib/weeklyReport.js (puro).
 */

import { supabaseAdmin } from '../lib/adminSupabase.js';
import { sendEmail } from '../lib/emailTransport.js';
import { addLog } from '../lib/logBuffer.js';
import { wantsEmail } from '../lib/emailPrefs.js';
import {
  isWeeklyReportWindow, madridWeekStartUtc, buildWeeklyReport, renderWeeklyReportEmail, EVENTS_DAYS_AHEAD,
} from '../lib/weeklyReport.js';
import { resolveTicker } from '../lib/marketQuotes.js';
import {
  fetchDividendCalendar, fetchEarningsCalendar, getDividendFromYahoo, getEarningsFromYahoo,
} from '../lib/marketCalendar.js';
import { isCashPosition } from '../../src/lib/positionKind.js';
import { claimReportSend } from '../lib/reportSends.js';

const RUN_EVERY_MS = 60 * 60 * 1000;
const STARTUP_DELAY_MS = 3 * 60 * 1000;   // detrás del cron de notificaciones y del de snapshots
const HISTORY_DAYS = 15;                   // margen para encontrar la foto de hace 7 días
const PAGE_SIZE = 1000;

let running = false;

async function loadSnapshotsByUser(sinceIso) {
  const byUser = new Map();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from('portfolio_snapshots')
      .select('user_id, snapshot_date, total_value_eur, cash_eur, breakdown')
      .eq('scope', 'general')
      .gte('snapshot_date', sinceIso)
      .order('user_id').order('snapshot_date')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`portfolio_snapshots: ${error.message}`);
    for (const row of data || []) {
      if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
      byUser.get(row.user_id).push(row);
    }
    if (!data || data.length < PAGE_SIZE) break;
  }
  return byUser;
}

export const isInvestedHoldingAsset = (asset) => {
  // Keep behavior explicit: rows without `assets` are excluded from "invertido".
  if (!asset) return false;
  return !isCashPosition({ assets: asset });
};

/**
 * Posiciones y operaciones de la semana de cada usuario.
 * @returns {{ txByUser: Map<string,Array>|null, holdingsByUser: Map<string,Set<string>> }}
 *   txByUser = null si no se pudieron leer: el informe no separará el mercado.
 */
async function loadActivity(userIds, sinceIso) {
  const holdingsByUser = new Map();
  const { data: positions, error: posErr } = await supabaseAdmin
    .from('positions')
    .select('id, quantity, assets(ticker, asset_class), brokers!inner(user_id)')
    .in('brokers.user_id', userIds);
  if (posErr) {
    addLog('warn', 'email', `Informe semanal: sin posiciones (${posErr.message})`);
    return { txByUser: null, holdingsByUser };
  }

  const posInfo = new Map();   // position id → { userId, ticker }
  for (const p of positions || []) {
    const userId = p.brokers?.user_id;
    const ticker = p.assets?.ticker;
    if (!userId || !ticker) continue;
    posInfo.set(p.id, { userId, ticker });
    if (Number(p.quantity) > 0 && isInvestedHoldingAsset(p.assets)) {
      if (!holdingsByUser.has(userId)) holdingsByUser.set(userId, new Set());
      holdingsByUser.get(userId).add(ticker);
    }
  }

  const txByUser = new Map(userIds.map((id) => [id, []]));
  const ids = [...posInfo.keys()];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabaseAdmin
      .from('transactions')
      .select('position_id, transaction_type, transaction_date')
      .in('position_id', ids.slice(i, i + 200))
      .in('transaction_type', ['BUY', 'SELL', 'TRANSFER', 'CASH'])
      .gte('transaction_date', sinceIso);
    if (error) {
      addLog('warn', 'email', `Informe semanal: sin operaciones (${error.message})`);
      return { txByUser: null, holdingsByUser };
    }
    for (const tx of data || []) {
      const info = posInfo.get(tx.position_id);
      if (!info) continue;
      txByUser.get(info.userId)?.push({ t: info.ticker, type: tx.transaction_type, date: tx.transaction_date });
    }
  }
  return { txByUser, holdingsByUser };
}

/**
 * Resultados y ex-dividendos de los próximos días para un conjunto de tickers
 * (`assets.ticker`). Nasdaq primero (una pasada para todos); Yahoo para lo que
 * Nasdaq no cubre — su dividendo es una ESTIMACIÓN y se marca como tal.
 * @returns {Promise<Map<string, Array>|null>} ticker → eventos; null si falla todo.
 */
async function loadUpcomingEvents(tickers) {
  if (!tickers.size) return new Map();
  try {
    const [divCal, earnCal] = await Promise.all([
      fetchDividendCalendar(0, EVENTS_DAYS_AHEAD + 1).catch(() => ({})),
      fetchEarningsCalendar(0, EVENTS_DAYS_AHEAD + 1).catch(() => ({})),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    const byTicker = new Map();
    for (const raw of tickers) {
      const sym = resolveTicker(raw);
      const events = [];
      // Secuencial: Yahoo estrangula las ráfagas (ver asyncPool en el cliente).
      const earn = earnCal[sym] ?? await getEarningsFromYahoo(sym);
      if (earn?.date && earn.date >= today) events.push({ date: earn.date, kind: 'earnings', t: raw });
      const div = divCal[sym] ?? await getDividendFromYahoo(sym);
      if (div?.exDate && div.exDate >= today) {
        events.push({ date: div.exDate, kind: 'exdiv', t: raw, estimated: Boolean(div.estimated) });
      }
      byTicker.set(raw, events);
    }
    return byTicker;
  } catch (e) {
    addLog('warn', 'email', `Informe semanal: sin calendario (${e.message})`);
    return null;
  }
}

// `assets.ticker` → `assets.company_name` para los tickers que salen en las
// fotos. Un fallo aquí NO para el informe: sin nombre se enseña el ISIN.
async function loadAssetNames(tickers) {
  const names = new Map();
  const list = [...tickers];
  for (let i = 0; i < list.length; i += 200) {
    const { data, error } = await supabaseAdmin
      .from('assets').select('ticker, company_name').in('ticker', list.slice(i, i + 200));
    if (error) {
      addLog('warn', 'email', `Informe semanal: sin nombres de activos (${error.message})`);
      return names;
    }
    for (const a of data || []) if (a.company_name) names.set(a.ticker, a.company_name);
  }
  return names;
}

/**
 * @param {{ now?: Date, force?: boolean, onlyUserId?: string }} [opts]
 *   force: ignora la ventana del lunes (para lanzarlo a mano).
 *   onlyUserId: limita el envío a un usuario (pruebas).
 *   test: vista previa — se salta la deduplicación, sale con kind 'test' y
 *   "[Prueba]" en el asunto, y NO cuenta como el informe de esa semana.
 */
export async function runWeeklyReports({ now = new Date(), force = false, onlyUserId = null, test = false } = {}) {
  if (!supabaseAdmin) return { skipped: 'no supabase' };
  if (!force && !isWeeklyReportWindow(now)) return { skipped: 'outside window' };
  if (running) return { skipped: 'already running' };
  running = true;

  try {
    const weekStart = madridWeekStartUtc(now);
    const since = new Date(now.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const snapshotsByUser = await loadSnapshotsByUser(since);
    let userIds = [...snapshotsByUser.keys()];
    if (onlyUserId) userIds = userIds.filter((id) => id === onlyUserId);
    if (!userIds.length) return { users: 0 };

    const { data: prefs, error: prefErr } = await supabaseAdmin
      .from('user_preferences')
      .select('*')
      .in('user_id', userIds);
    if (prefErr) throw new Error(`user_preferences: ${prefErr.message}`);

    // Interruptor general Y el de "Informe semanal" de Ajustes (antes se ignoraba).
    const optedOut = new Set((prefs || []).filter((p) => !wantsEmail(p, 'weekly')).map((p) => p.user_id));
    // Idioma del informe: el que la app guarda en user_preferences.language.
    const langByUser = new Map((prefs || []).map((p) => [p.user_id, p.language === 'en' ? 'en' : 'es']));
    const weekKey = weekStart.toISOString();

    const summary = { users: userIds.length, sent: 0, skipped: 0, failed: 0 };
    // Primero se descarta a quien no toca: así no se consulta el calendario de
    // mercado para nadie que no vaya a recibir el correo.
    const pending = userIds.filter((id) => !optedOut.has(id));
    summary.skipped += userIds.length - pending.length;
    if (!pending.length) return summary;

    const { txByUser, holdingsByUser } = await loadActivity(pending, since);
    const holdingTickers = new Set(pending.flatMap((id) => [...(holdingsByUser.get(id) || [])]));
    const eventsByTicker = await loadUpcomingEvents(holdingTickers);

    const tickers = new Set(holdingTickers);
    for (const userId of pending) {
      for (const s of snapshotsByUser.get(userId)) {
        for (const p of Array.isArray(s.breakdown) ? s.breakdown : []) if (p?.t) tickers.add(p.t);
      }
    }
    const names = await loadAssetNames(tickers);

    for (const userId of pending) {
      const report = buildWeeklyReport(snapshotsByUser.get(userId), {
        names,
        transactions: txByUser ? txByUser.get(userId) || [] : null,
        events: eventsByTicker
          ? [...(holdingsByUser.get(userId) || [])].flatMap((t) => eventsByTicker.get(t) || [])
          : null,
      });
      if (!report) { summary.skipped++; continue; }

      const { data: userData, error: userErr } = await supabaseAdmin.auth.admin.getUserById(userId);
      const email = userData?.user?.email;
      if (userErr || !email) { summary.skipped++; continue; }

      if (!test) {
        const claim = await claimReportSend({ userId, kind: 'weekly_report', periodKey: weekKey });
        if (claim && !claim.claimed) {
          summary.skipped++;
          continue;
        }
      }

      const { subject, text, html } = renderWeeklyReportEmail(report, { lang: langByUser.get(userId) });
      const result = await sendEmail({
        kind: test ? 'test' : 'weekly_report',
        userId, to: email, subject: test ? `[Prueba] ${subject}` : subject, text, html,
      });
      if (result.ok) summary.sent++;
      else summary.failed++;
    }

    console.log('[weeklyReport]', JSON.stringify(summary));
    addLog(summary.failed ? 'warn' : 'info', 'email', `Informe semanal: ${summary.sent} enviados, ${summary.failed} fallidos`);
    return summary;
  } finally {
    running = false;
  }
}

export function startWeeklyReportCron() {
  if (!supabaseAdmin) {
    console.warn('[weeklyReport] Supabase admin client not configured — cron disabled.');
    return;
  }
  const run = () => runWeeklyReports()
    .catch((e) => {
      console.error('[weeklyReport] run error:', e.message);
      addLog('error', 'email', `Informe semanal: ${e.message}`);
    });
  setTimeout(run, STARTUP_DELAY_MS);
  setInterval(run, RUN_EVERY_MS);
  console.log('[weeklyReport] Cron scheduled (hourly check, Monday from 08:00 Madrid).');
}
