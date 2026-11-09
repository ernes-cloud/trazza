/**
 * Informe semanal de cartera por correo — la parte PURA (fechas, cálculo,
 * render). El job que lee Supabase y envía vive en jobs/weeklyReport.js.
 *
 * Sustituye al flujo "Informe Semanal PDF — Cartera (Beta)" de n8n, que llamaba
 * a una ruta /api/internal/send-all-weekly-reports que ya no existía (404, y
 * además sin credenciales): el informe no salió nunca.
 *
 * Se construye sobre `portfolio_snapshots`, que el cron de snapshots escribe a
 * diario (valor total, efectivo y desglose por ticker en EUR). No recalcula
 * nada de la cartera: compara dos fotos ya hechas.
 *
 * "Mercado" se mide SOLO sobre las posiciones en las que no hubo operaciones esa
 * semana. Separar aportaciones del valor total no es fiable con los datos que
 * hay (un TRANSFER no dice si entra o sale, y una compra solo mueve el total si
 * el broker no registra liquidez), así que no se estima: se acota.
 */

import { madridDayStartUtc } from './emailQuota.js';
import { escapeHtml } from './escapeHtml.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const REPORT_WEEKDAY = 1;   // lunes
export const REPORT_HOUR = 8;      // desde las 08:00 de Madrid
export const EVENTS_DAYS_AHEAD = 7;

/**
 * Primera fecha con fotos valoradas a precio de MERCADO. Hasta el 2026-10-02
 * el cron de snapshots no conseguía ninguna cotización (las claves de DeGiro se
 * descartaban por llevar espacios y Yahoo devolvía 429) y valoraba con el precio
 * guardado en la BD, que solo refresca el cliente al abrir la app: esas fotos se
 * movían mucho menos que el mercado (+0,82 % en una semana en la que la cartera
 * cayó ~1 %). Nunca se comparan contra una foto anterior a esta fecha.
 *
 * Del 24-sep al 1-oct-2026 se RECONSTRUYERON con cierres oficiales
 * (scripts/backfillSnapshots.mjs), así que el corte empieza ahí. Lo anterior
 * sigue valorado con precios guardados.
 */
export const SNAPSHOTS_LIVE_SINCE = '2026-09-24';

const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}\d/;

/**
 * Clave de agrupación de una entrada del `breakdown`. La foto agrupa por
 * `assets.ticker` tal cual, que para DeGiro es "ISIN (DIVISA)": la misma acción
 * comprada en dos mercados sale dos veces ("US0231351067 (USD)" y
 * "US0231351067 (EUR)"). Se juntan por ISIN, igual que la vista general de la app.
 */
export function positionGroupKey(t) {
  const s = String(t || '').trim();
  const m = s.match(ISIN_RE);
  return m ? m[0] : s;
}

// "CONSTELLATION SOFTWARE INC" → "Constellation Software Inc". Solo nombres
// enteramente en mayúsculas y de varias palabras: "MSFT" o "iShares" se dejan.
function prettyName(name) {
  const s = String(name || '').trim();
  if (!s.includes(' ') || s !== s.toUpperCase() || !/[A-Z]/.test(s)) return s;
  return s.toLowerCase().replace(/(^|[\s\-./(])(\p{L})/gu, (_, sep, c) => sep + c.toUpperCase());
}

/**
 * Elige el nombre más legible entre los que tiene un grupo: el que parece un
 * nombre de empresa (lleva espacios) antes que un símbolo suelto ("MSFT"), y
 * entre ellos el más largo.
 */
function bestName(candidates, fallback) {
  const names = [...new Set((candidates || []).map((n) => String(n || '').trim()).filter(Boolean))];
  if (!names.length) return fallback;
  names.sort((a, b) => (b.includes(' ') - a.includes(' ')) || (b.length - a.length));
  return prettyName(names[0]);
}

/** Partes de la fecha en Madrid: { y, m, d, weekday (1=lun…7=dom), hour }. */
export function madridParts(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', hourCycle: 'h23', weekday: 'short',
    }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  const weekdays = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    y: Number(parts.year), m: Number(parts.month), d: Number(parts.day),
    weekday: weekdays[parts.weekday], hour: Number(parts.hour),
  };
}

/** ¿Toca enviar ahora? Lunes a partir de las 08:00 de Madrid (el job se repite cada hora). */
export function isWeeklyReportWindow(now = new Date()) {
  const { weekday, hour } = madridParts(now);
  return weekday === REPORT_WEEKDAY && hour >= REPORT_HOUR;
}

/**
 * Lunes 00:00 de Madrid de la semana de `now`, en UTC. Sirve de clave de
 * deduplicación: un usuario recibe un informe por semana aunque el job corra
 * cada hora o el server se reinicie.
 *
 * Se ancla a mediodía UTC de la fecha del lunes antes de pedir su medianoche:
 * restar 24 h × N a `now` puede cruzar un cambio de hora y caer en otro día.
 */
export function madridWeekStartUtc(now = new Date()) {
  const { y, m, d, weekday } = madridParts(now);
  const mondayNoonUtc = new Date(Date.UTC(y, m - 1, d - (weekday - 1), 12));
  return madridDayStartUtc(mondayNoonUtc);
}

const isoDay = (s) => String(s).slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(isoDay(b)) - Date.parse(isoDay(a))) / DAY_MS);
const round2 = (n) => Math.round(n * 100) / 100;

/** Suma el `breakdown` de una foto por grupo (ISIN). */
function groupBreakdown(snapshot) {
  const groups = new Map();
  for (const p of Array.isArray(snapshot?.breakdown) ? snapshot.breakdown : []) {
    if (!p || !p.t || !(Number(p.v) > 0)) continue;
    const key = positionGroupKey(p.t);
    const g = groups.get(key) || { key, value: 0, tickers: [] };
    g.value += Number(p.v);
    g.tickers.push(p.t);
    groups.set(key, g);
  }
  return groups;
}

const TRADE_TAG = (sides) => (sides.has('BUY') && sides.has('SELL') ? 'trade' : sides.has('SELL') ? 'sell' : 'buy');

/**
 * @param {Array<{snapshot_date:string,total_value_eur:number|string,cash_eur?:number|string,
 *   breakdown?:Array<{t:string,v:number}>}>} snapshots  del usuario, en cualquier orden
 * @param {object} [opts]
 * @param {Map<string,string>|Record<string,string>} [opts.names]
 *   `assets.ticker` → `assets.company_name` ("Microsoft Corp" en vez de
 *   "US5949181045 (USD)"). Sin nombre se enseña el ISIN/ticker.
 * @param {Map<string,Set<'BUY'|'SELL'>>|null} [opts.trades]
 *   `assets.ticker` → lados operados ENTRE las dos fotos. `null` = no se sabe
 *   (la consulta falló): entonces no se separa el mercado y se avisa como antes.
 * @param {boolean} [opts.cashMoved]  hubo ingresos/retiradas de efectivo en la semana
 * @param {Array<{t:string,type:string,date:string}>|null} [opts.transactions]
 *   Alternativa a trades/cashMoved: las operaciones en bruto. Se filtran aquí a
 *   la ventana EXACTA entre las dos fotos (posterior a la anterior, hasta la
 *   actual), que el llamante no conoce de antemano. BUY/SELL → trades;
 *   TRANSFER/CASH → cashMoved.
 * @param {string} [opts.liveSince]  fotos anteriores a esta fecha no sirven de comparación
 *   (por defecto SNAPSHOTS_LIVE_SINCE)
 * @param {Array<{date:string,kind:'earnings'|'exdiv',t:string,estimated?:boolean}>|null} [opts.events]
 *   eventos de las posiciones; se quedan los de los próximos 7 días. `null` = no se pudo consultar.
 * @returns {null | object}  null si no hay foto o la cartera vale 0.
 */
export function buildWeeklyReport(snapshots, {
  names, trades = null, cashMoved = false, transactions, events = null, liveSince = SNAPSHOTS_LIVE_SINCE,
} = {}) {
  const nameOf = (t) => (names instanceof Map ? names.get(t) : names?.[t]);
  const rows = (snapshots || [])
    .filter((s) => s && s.snapshot_date && Number.isFinite(Number(s.total_value_eur)))
    .sort((a, b) => isoDay(a.snapshot_date).localeCompare(isoDay(b.snapshot_date)));
  if (!rows.length) return null;

  const last = rows[rows.length - 1];
  const value = Number(last.total_value_eur);
  if (!(value > 0)) return null;

  // La foto de hace 7 días; si ese día no la hay (el server estuvo parado), la
  // más reciente ANTERIOR a esa fecha. Nunca una más cercana: compararía menos
  // de una semana y el número se presentaría como semanal sin serlo.
  const prev = [...rows].reverse().find((s) =>
    daysBetween(s.snapshot_date, last.snapshot_date) >= 7 && isoDay(s.snapshot_date) >= liveSince,
  ) || null;
  const prevValue = prev ? Number(prev.total_value_eur) : null;
  const change = prev ? round2(value - prevValue) : null;
  const changePct = prev && prevValue > 0 ? round2(((value - prevValue) / prevValue) * 100) : null;

  if (Array.isArray(transactions)) {
    trades = new Map();
    cashMoved = false;
    const from = prev ? isoDay(prev.snapshot_date) : null;
    const to = isoDay(last.snapshot_date);
    for (const tx of transactions) {
      const d = isoDay(tx?.date || '');
      if (!from || d <= from || d > to) continue;
      if (tx.type === 'BUY' || tx.type === 'SELL') {
        const sides = trades.get(tx.t) || new Set();
        sides.add(tx.type);
        trades.set(tx.t, sides);
      } else if (tx.type === 'TRANSFER' || tx.type === 'CASH') {
        cashMoved = true;
      }
    }
  }

  // Lados operados por grupo (ISIN): una compra de "US0231351067 (EUR)" marca a Amazon entero.
  const tradedByGroup = new Map();
  if (trades) {
    for (const [t, sides] of trades instanceof Map ? trades : Object.entries(trades)) {
      const key = positionGroupKey(t);
      const acc = tradedByGroup.get(key) || new Set();
      for (const s of sides) acc.add(s);
      tradedByGroup.set(key, acc);
    }
  }
  const tradesKnown = trades !== null;

  const nowGroups = groupBreakdown(last);
  const prevGroups = prev ? groupBreakdown(prev) : new Map();

  let marketChange = 0;
  let marketBase = 0;
  let marketCount = 0;
  const positions = [...nowGroups.values()]
    .sort((a, b) => b.value - a.value)
    .map((g) => {
      const before = prevGroups.get(g.key);
      const sides = tradedByGroup.get(g.key);
      let tag = null;
      let weekPct = null;
      if (prev && tradesKnown) {
        if (sides) tag = TRADE_TAG(sides);
        else if (!before) tag = 'new';
        else {
          weekPct = round2(((g.value - before.value) / before.value) * 100);
          marketChange += g.value - before.value;
          marketBase += before.value;
          marketCount++;
        }
      }
      return {
        name: bestName(g.tickers.map(nameOf), g.key),
        value: round2(g.value),
        weightPct: round2((g.value / value) * 100),
        weekPct,
        tag,
      };
    });

  // Lo que se tenía hace una semana y ya no está.
  const closed = prev && tradesKnown
    ? [...prevGroups.values()].filter((g) => !nowGroups.has(g.key)).map((g) => bestName(g.tickers.map(nameOf), g.key))
    : [];

  const market = marketCount && marketBase > 0
    ? { change: round2(marketChange), pct: round2((marketChange / marketBase) * 100), covers: marketCount }
    : null;
  const noActivity = Boolean(prev && tradesKnown && !cashMoved && tradedByGroup.size === 0 && !closed.length
    && positions.every((p) => p.tag === null));

  const moved = positions.filter((p) => p.weekPct !== null).sort((a, b) => b.weekPct - a.weekPct);
  const best = moved.length >= 2 ? { name: moved[0].name, pct: moved[0].weekPct } : null;
  const worst = moved.length >= 2 ? { name: moved[moved.length - 1].name, pct: moved[moved.length - 1].weekPct } : null;

  const reportDate = isoDay(last.snapshot_date);
  const horizon = new Date(Date.parse(reportDate) + EVENTS_DAYS_AHEAD * DAY_MS).toISOString().slice(0, 10);
  let upcoming = null;
  if (Array.isArray(events)) {
    const seen = new Set();
    upcoming = events
      .filter((e) => e && e.date > reportDate && e.date <= horizon && (e.kind === 'earnings' || e.kind === 'exdiv'))
      .map((e) => ({
        date: e.date, kind: e.kind, estimated: Boolean(e.estimated),
        name: bestName([nameOf(e.t)], positionGroupKey(e.t)), key: `${positionGroupKey(e.t)}|${e.kind}`,
      }))
      .filter((e) => (seen.has(e.key) ? false : seen.add(e.key)))
      .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name))
      .map(({ key, ...e }) => e);
  }

  return {
    date: reportDate,
    value: round2(value),
    cash: round2(Number(last.cash_eur) || 0),
    prevDate: prev ? isoDay(prev.snapshot_date) : null,
    change,
    changePct,
    tradesKnown,
    noActivity,
    market,
    best,
    worst,
    positions,
    closed,
    upcoming,
  };
}

// ── Render (es / en) ─────────────────────────────────────────────────────────
// El informe se manda en el idioma del usuario (`user_preferences.language`,
// que la app guarda desde el 2026-10-02 con el idioma detectado del navegador).
// Cualquier valor que no sea 'en' cae a español.

export const REPORT_LANGS = ['es', 'en'];
const LOCALE = { es: 'es-ES', en: 'en-GB' };

const STRINGS = {
  es: {
    weekOf: (a, b) => `Semana del ${a} al ${b}`,
    weeklySummary: (d) => `Resumen semanal · ${d}`,
    thisWeek: 'esta semana',
    noHistory: 'Todavía no hay una semana de historial para comparar.',
    noActivity: 'No has operado esta semana: toda la variación viene del mercado.',
    market: (m) => `Mercado: ${m} en las posiciones en las que no operaste.`,
    withTrades: 'La variación total incluye tus compras, ventas y movimientos de efectivo de la semana.',
    generic: 'La variación incluye compras, ventas y aportaciones de la semana: mide cuánto ha cambiado el valor, no la rentabilidad.',
    movers: (b, w) => `Lo que más subió: ${b} · Lo que más bajó: ${w}`,
    subjValue: (v) => `📊 Tu cartera: ${v}`,
    subjPct: (p, v) => `📊 Tu cartera ${p} esta semana · ${v}`,
    subjMarket: (p, v) => `📊 Mercado ${p} esta semana · tu cartera ${v}`,
    subjChange: (v, c) => `📊 Tu semana en Trazza: ${v} (${c})`,
    portfolioValue: 'Valor de tu cartera',
    cash: 'Liquidez',
    positions: 'Tus posiciones',
    positionsText: 'Tus posiciones (valor · peso · semana)',
    cols: ['Posición', 'Valor', 'Peso', 'Semana'],
    closed: 'Ya no tienes',
    nextWeek: 'La semana que viene',
    noEvents: 'Sin resultados ni dividendos previstos en tus posiciones.',
    exdivNote: 'Para cobrar un dividendo hay que tener las acciones antes de su fecha ex-dividendo.',
    earnings: (n) => `${n} presenta resultados`,
    exdiv: (n, est) => `${n}: fecha ex-dividendo${est ? ' (estimada)' : ''}`,
    tags: { buy: 'Compra', sell: 'Venta', trade: 'Compra y venta', new: 'Nueva' },
    cta: 'Ver mi cartera',
    footer: 'Lo recibes porque tienes activadas las notificaciones por correo',
    manage: 'Gestionar notificaciones',
    manageText: 'Gestiona estos correos en',
  },
  en: {
    weekOf: (a, b) => `Week of ${a} – ${b}`,
    weeklySummary: (d) => `Weekly summary · ${d}`,
    thisWeek: 'this week',
    noHistory: 'There is not a full week of history to compare yet.',
    noActivity: 'You made no trades this week: the whole change comes from the market.',
    market: (m) => `Market: ${m} on the positions you did not trade.`,
    withTrades: 'The total change includes your buys, sells and cash movements this week.',
    generic: 'The change includes buys, sells and contributions this week: it measures how much the value moved, not your return.',
    movers: (b, w) => `Best: ${b} · Worst: ${w}`,
    subjValue: (v) => `📊 Your portfolio: ${v}`,
    subjPct: (p, v) => `📊 Your portfolio ${p} this week · ${v}`,
    subjMarket: (p, v) => `📊 Market ${p} this week · your portfolio ${v}`,
    subjChange: (v, c) => `📊 Your week on Trazza: ${v} (${c})`,
    portfolioValue: 'Portfolio value',
    cash: 'Cash',
    positions: 'Your positions',
    positionsText: 'Your positions (value · weight · week)',
    cols: ['Position', 'Value', 'Weight', 'Week'],
    closed: 'No longer held',
    nextWeek: 'Next week',
    noEvents: 'No earnings or dividends expected for your positions.',
    exdivNote: 'To receive a dividend you must hold the shares before the ex-dividend date.',
    earnings: (n) => `${n} reports earnings`,
    exdiv: (n, est) => `${n}: ex-dividend date${est ? ' (estimated)' : ''}`,
    tags: { buy: 'Buy', sell: 'Sell', trade: 'Buy & sell', new: 'New' },
    cta: 'Open my portfolio',
    footer: 'You receive this because email notifications are on',
    manage: 'Manage notifications',
    manageText: 'Manage these emails at',
  },
};

function formatters(lang) {
  const loc = LOCALE[lang];
  // useGrouping 'always': en es-ES los números de 4 cifras salen sin punto de
  // miles por defecto ("9752,87 €"), al lado de "35.150,46 €".
  const eur = (n) => new Intl.NumberFormat(loc, { style: 'currency', currency: 'EUR', useGrouping: 'always' }).format(n);
  const num = (n, d) => new Intl.NumberFormat(loc, { maximumFractionDigits: d, useGrouping: 'always' }).format(n);
  const sp = lang === 'es' ? ' ' : '';   // "27,7 %" en español, "27.7%" en inglés
  const pct = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${num(Math.abs(n), 2)}${sp}%`;
  const weight = (n) => `${num(n, 1)}${sp}%`;
  const date = (iso, opts) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(loc, { ...opts, timeZone: 'Europe/Madrid' });
  return {
    eur, pct, weight,
    longDate: (iso) => date(iso, { day: 'numeric', month: 'long' }),
    shortDate: (iso) => date(iso, { day: 'numeric', month: 'short' }).replace('.', ''),
    dayLabel: (iso) => date(iso, { weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, ''),
  };
}

const GREEN = '#059669';
const RED = '#dc2626';
const GREY = '#64748b';

/**
 * @param {object} report  salida de buildWeeklyReport
 * @param {{ lang?: 'es'|'en' }} [opts]
 * @returns {{ subject: string, text: string, html: string }}
 */
export function renderWeeklyReportEmail(report, { lang = 'es' } = {}) {
  const L = REPORT_LANGS.includes(lang) ? lang : 'es';
  const S = STRINGS[L];
  const { eur, pct, weight, longDate, shortDate, dayLabel } = formatters(L);

  const hasChange = report.change !== null;
  const up = hasChange && report.change >= 0;
  const arrow = (n) => (n >= 0 ? '▲' : '▼');

  const period = report.prevDate ? S.weekOf(shortDate(report.prevDate), shortDate(report.date)) : S.weeklySummary(longDate(report.date));
  const changeLine = hasChange
    ? `${arrow(report.change)} ${eur(Math.abs(report.change))}${report.changePct !== null ? ` (${pct(report.changePct)})` : ''} ${S.thisWeek}`
    : S.noHistory;

  // Qué explica la variación. Tres casos, del más claro al menos:
  let explain = null;
  let marketLine = null;
  if (hasChange && report.noActivity) {
    explain = S.noActivity;
  } else if (hasChange && report.tradesKnown) {
    if (report.market) marketLine = S.market(`${arrow(report.market.change)} ${eur(Math.abs(report.market.change))} (${pct(report.market.pct)})`);
    explain = S.withTrades;
  } else if (hasChange) {
    explain = S.generic;
  }

  const movers = report.best && report.worst
    ? S.movers(`${report.best.name} (${pct(report.best.pct)})`, `${report.worst.name} (${pct(report.worst.pct)})`)
    : null;

  // Asunto: el dato que se quiere saber. Si toda la variación es de mercado, su
  // %; si no, el % de mercado de lo no operado; sin semana, solo el valor.
  let subject = S.subjValue(eur(report.value));
  if (hasChange && report.noActivity && report.changePct !== null) subject = S.subjPct(pct(report.changePct), eur(report.value));
  else if (hasChange && report.market) subject = S.subjMarket(pct(report.market.pct), eur(report.value));
  else if (hasChange) subject = S.subjChange(eur(report.value), `${up ? '+' : '−'}${eur(Math.abs(report.change))}`);

  const weekCell = (p) => (p.weekPct !== null ? pct(p.weekPct) : p.tag ? S.tags[p.tag] : '—');
  const weekColor = (p) => (p.weekPct === null ? GREY : p.weekPct >= 0 ? GREEN : RED);
  const eventText = (e) => (e.kind === 'earnings' ? S.earnings(e.name) : S.exdiv(e.name, e.estimated));

  // ── Texto plano ────────────────────────────────────────────────────────────
  const text = [
    period,
    `${S.portfolioValue}: ${eur(report.value)}`,
    changeLine,
    marketLine,
    explain,
    movers,
    `${S.cash}: ${eur(report.cash)}`,
    report.positions.length
      ? `\n${S.positionsText}:\n${report.positions.map((p) => `  · ${p.name}: ${eur(p.value)} · ${weight(p.weightPct)} · ${weekCell(p)}`).join('\n')}`
      : null,
    report.closed.length ? `${S.closed}: ${report.closed.join(', ')}` : null,
    report.upcoming
      ? `\n${S.nextWeek}:\n${report.upcoming.length ? report.upcoming.map((e) => `  · ${dayLabel(e.date)} — ${eventText(e)}`).join('\n') : `  ${S.noEvents}`}`
      : null,
    `\n${S.manageText} https://example.com/app/settings`,
  ].filter(Boolean).join('\n');

  // ── HTML ───────────────────────────────────────────────────────────────────
  const th = (label, align = 'left') =>
    `<td style="padding:0 0 6px;font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;text-align:${align};">${escapeHtml(label)}</td>`;
  const posRows = report.positions.map((p) => `
          <tr>
            <td style="padding:7px 8px 7px 0;font-size:14px;color:#0f172a;border-top:1px solid #f1f5f9;">${escapeHtml(p.name)}</td>
            <td style="padding:7px 0;font-size:14px;color:#0f172a;text-align:right;white-space:nowrap;border-top:1px solid #f1f5f9;">${escapeHtml(eur(p.value))}</td>
            <td style="padding:7px 0 7px 12px;font-size:13px;color:${GREY};text-align:right;white-space:nowrap;border-top:1px solid #f1f5f9;">${escapeHtml(weight(p.weightPct))}</td>
            <td style="padding:7px 0 7px 12px;font-size:13px;font-weight:600;color:${weekColor(p)};text-align:right;white-space:nowrap;border-top:1px solid #f1f5f9;">${escapeHtml(weekCell(p))}</td>
          </tr>`).join('');

  const changeColor = !hasChange ? GREY : up ? GREEN : RED;
  const eventRows = (report.upcoming || []).map((e) => `
          <tr>
            <td style="padding:5px 12px 5px 0;font-size:13px;color:${GREY};white-space:nowrap;vertical-align:top;">${escapeHtml(dayLabel(e.date))}</td>
            <td style="padding:5px 0;font-size:14px;color:#0f172a;">${escapeHtml(eventText(e))}</td>
          </tr>`).join('');
  const hasExdiv = (report.upcoming || []).some((e) => e.kind === 'exdiv');
  const [cPos, cVal, cWeight, cWeek] = S.cols;

  const html = `<!DOCTYPE html>
<html lang="${L}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
    <tr><td align="center">
      <table width="540" cellpadding="0" cellspacing="0" style="max-width:540px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
        <tr><td style="background:#0f172a;padding:24px 32px;">
          <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;">Trazza</p>
          <p style="margin:4px 0 0;font-size:13px;color:#94a3b8;">${escapeHtml(period)}</p>
        </td></tr>
        <tr><td style="padding:32px 32px 8px;">
          <p style="margin:0 0 4px;font-size:13px;color:${GREY};">${escapeHtml(S.portfolioValue)}</p>
          <p style="margin:0;font-size:30px;font-weight:700;color:#0f172a;">${escapeHtml(eur(report.value))}</p>
          <p style="margin:8px 0 0;font-size:15px;font-weight:600;color:${changeColor};">${escapeHtml(changeLine)}</p>
          ${marketLine ? `<p style="margin:6px 0 0;font-size:14px;color:#0f172a;">${escapeHtml(marketLine)}</p>` : ''}
          ${explain ? `<p style="margin:6px 0 0;font-size:12px;color:#94a3b8;line-height:1.5;">${escapeHtml(explain)}</p>` : ''}
          ${movers ? `<p style="margin:14px 0 0;font-size:13px;color:#475569;line-height:1.5;">${escapeHtml(movers)}</p>` : ''}
          <p style="margin:14px 0 0;font-size:13px;color:#475569;">${escapeHtml(S.cash)}: <strong>${escapeHtml(eur(report.cash))}</strong></p>
        </td></tr>
        ${report.positions.length ? `<tr><td style="padding:20px 32px 8px;">
          <p style="margin:0 0 10px;font-size:13px;font-weight:600;color:#0f172a;">${escapeHtml(S.positions)}</p>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>${th(cPos)}${th(cVal, 'right')}${th(cWeight, 'right')}${th(cWeek, 'right')}</tr>${posRows}
          </table>
          ${report.closed.length ? `<p style="margin:8px 0 0;font-size:12px;color:#94a3b8;">${escapeHtml(S.closed)}: ${escapeHtml(report.closed.join(', '))}</p>` : ''}
        </td></tr>` : ''}
        ${report.upcoming ? `<tr><td style="padding:20px 32px 8px;">
          <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#0f172a;">${escapeHtml(S.nextWeek)}</p>
          ${report.upcoming.length
            ? `<table cellpadding="0" cellspacing="0">${eventRows}</table>
          ${hasExdiv ? `<p style="margin:8px 0 0;font-size:12px;color:#94a3b8;line-height:1.5;">${escapeHtml(S.exdivNote)}</p>` : ''}`
            : `<p style="margin:0;font-size:13px;color:${GREY};">${escapeHtml(S.noEvents)}</p>`}
        </td></tr>` : ''}
        <tr><td style="padding:24px 32px;">
          <a href="https://example.com/app" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 18px;border-radius:8px;">${escapeHtml(S.cta)}</a>
        </td></tr>
        <tr><td style="padding:16px 32px 24px;border-top:1px solid #f1f5f9;">
          <p style="margin:0;font-size:12px;color:#94a3b8;">
            ${escapeHtml(S.footer)} ·
            <a href="https://example.com/app/settings" style="color:${GREY};text-decoration:underline;">${escapeHtml(S.manage)}</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}
