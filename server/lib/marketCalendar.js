/**
 * Calendarios de dividendos y resultados (Nasdaq directo + Yahoo como respaldo).
 *
 * Vivían privados en jobs/notificationCron.js. Se sacaron aquí cuando el informe
 * semanal (jobs/weeklyReport.js) necesitó "qué pasa la semana que viene" para
 * las posiciones de cada usuario: dos copias de este código se habrían separado
 * con el primer arreglo.
 */

import { yahooFetch, isPenceCurrency } from './marketQuotes.js';
import { fetchQuoteSummary } from './yahooCrumb.js';

// Predict next dividend date from 2-year Yahoo historical pattern.
// Returns { exDate, paymentDate, amount, estimated: true } or null.
// Es una PREDICCIÓN (último pago + periodo medio), no un anuncio: los avisos que
// salen de aquí lo dicen ("fecha estimada"). Antes se notificaba "Debes tener
// las acciones HOY" sobre una fecha calculada como si fuese un hecho.
export async function getDividendFromYahoo(ticker) {
  try {
    const json = await yahooFetch(
      `/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1mo&events=div`
    );
    const divEvents = json.chart?.result?.[0]?.events?.dividends;
    if (!divEvents) return null;

    const divs = Object.values(divEvents).sort((a, b) => a.date - b.date);
    if (divs.length < 2) return null;

    const intervals = [];
    for (let i = 1; i < divs.length; i++) {
      intervals.push((divs[i].date - divs[i - 1].date) / 86400);
    }
    const avgInterval = intervals.reduce((s, v) => s + v, 0) / intervals.length;
    const period =
      avgInterval < 45  ? 30  :   // monthly
      avgInterval < 120 ? 91  :   // quarterly
      avgInterval < 240 ? 182 :   // semi-annual
                          365;    // annual

    const lastDiv = divs[divs.length - 1];
    const now = new Date();
    let nextDate = new Date((lastDiv.date + period * 86400) * 1000);
    while (nextDate < now) nextDate = new Date(nextDate.getTime() + period * 86400 * 1000);

    const toISO = (d) => d.toISOString().split('T')[0];
    // La divisa del dividendo es la de cotización (meta.currency). En pence
    // (GBp/GBX) se pasa a libras, igual que los precios.
    const metaCur = json.chart?.result?.[0]?.meta?.currency || null;
    const pence = isPenceCurrency(metaCur);
    return {
      exDate: toISO(nextDate), paymentDate: null,
      amount: pence ? lastDiv.amount / 100 : lastDiv.amount,
      currency: pence ? 'GBP' : metaCur,
      estimated: true,
    };
  } catch {
    return null;
  }
}

// Get upcoming earnings from Yahoo quoteSummary. Va con crumb: sin él Yahoo
// responde SIEMPRE "Invalid Crumb", y este fallback —lo único que cubre lo que
// no está en el calendario de Nasdaq (ASML.AS, CSU.TO…)— no devolvía nada.
// Returns { date, epsActual, epsForecast, surprisePct } or null.
export async function getEarningsFromYahoo(ticker) {
  if (/^[A-Z0-9]+-[A-Z]{3}$/.test(ticker)) return null; // crypto pairs have no earnings
  try {
    const json = await fetchQuoteSummary(ticker, 'calendarEvents');
    const earnings = json.quoteSummary?.result?.[0]?.calendarEvents?.earnings;
    const dates = earnings?.earningsDate || [];
    if (!dates.length) return null;

    const now = Date.now();
    let bestMs = null;
    for (const d of dates) {
      const ms = d.raw * 1000;
      if (ms >= now && (bestMs === null || ms < bestMs)) bestMs = ms;
    }
    if (bestMs === null) bestMs = Math.max(...dates.map((d) => d.raw * 1000));

    return {
      date: new Date(bestMs).toISOString().split('T')[0],
      epsActual:   earnings.epsActual?.raw   ?? null,
      epsForecast: earnings.epsEstimate?.raw ?? null,
      surprisePct: null,
    };
  } catch {
    return null;
  }
}

// ─── Nasdaq calendar (direct — best coverage for US stocks) ──────────────────

const NASDAQ_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: 'https://www.nasdaq.com',
  Referer: 'https://www.nasdaq.com/',
};

function parseNasdaqDate(str) {
  if (!str) return null;
  const [m, d, y] = str.split('/');
  return y ? `${y}-${(m || '01').padStart(2, '0')}-${(d || '01').padStart(2, '0')}` : null;
}

function parseDollar(str) {
  if (!str || str === 'N/A' || str === '--') return null;
  const n = parseFloat(str.replace(/[$,]/g, ''));
  return isNaN(n) ? null : n;
}

async function fetchNasdaqDivDay(dateStr) {
  try {
    const r = await fetch(`https://api.nasdaq.com/api/calendar/dividends?date=${dateStr}`, {
      headers: NASDAQ_HEADERS,
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return [];
    const json = await r.json();
    return (json.data?.calendar?.rows || [])
      .map((row) => ({
        symbol:      row.symbol,
        name:        row.companyName || null,
        exDate:      parseNasdaqDate(row.dividend_Ex_Date),
        paymentDate: parseNasdaqDate(row.payment_Date),
        recordDate:  parseNasdaqDate(row.record_Date),
        amount:      typeof row.dividend_Rate === 'number' ? row.dividend_Rate : null,
        annualDividend: typeof row.indicated_Annual_Dividend === 'number' ? row.indicated_Annual_Dividend : null,
        currency:    'USD',   // el calendario de Nasdaq es de valores de EE. UU.
      }))
      .filter((r) => r.symbol && r.exDate);
  } catch {
    return [];
  }
}

async function fetchNasdaqEarnDay(dateStr) {
  try {
    const r = await fetch(`https://api.nasdaq.com/api/calendar/earnings?date=${dateStr}`, {
      headers: NASDAQ_HEADERS,
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return [];
    const json = await r.json();
    return (json.data?.rows || []).map((row) => ({
      symbol:      row.symbol,
      name:        row.name || null,
      date:        dateStr,
      epsActual:   parseDollar(row.eps),
      epsForecast: parseDollar(row.epsForecast),
      surprisePct: row.surprise ? parseFloat(row.surprise) : null,
      time:        row.time || null,                 // 'time-after-hours' | 'time-before-hours'
      fiscalQuarter: row.fiscalQuarterEnding || null,
    }));
  } catch {
    return [];
  }
}

function calendarDates(daysBack, daysAhead) {
  const dates = [];
  const today = new Date();
  for (let i = -daysBack; i <= daysAhead; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue; // skip weekends
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

async function fetchAllDays(dates, fetchDay, chunkSize = 12) {
  const results = [];
  for (let i = 0; i < dates.length; i += chunkSize) {
    const chunk = dates.slice(i, i + chunkSize);
    const rows = (await Promise.all(chunk.map(fetchDay))).flat();
    results.push(...rows);
  }
  return results;
}

/**
 * Filas EN BRUTO del calendario de Nasdaq, un día hábil cada vez (de 12 en 12).
 * Las sirve tal cual `GET /api/market-calendar/:kind` (routes/marketCalendar.js)
 * para que el navegador haga UNA petición en vez de una por día; los mapas de
 * abajo (cron, informe semanal) se construyen sobre estas mismas filas.
 */
export function fetchDividendRows(daysBack = 30, daysAhead = 90) {
  return fetchAllDays(calendarDates(daysBack, daysAhead), fetchNasdaqDivDay);
}

export function fetchEarningsRows(daysBack = 14, daysAhead = 45) {
  return fetchAllDays(calendarDates(daysBack, daysAhead), fetchNasdaqEarnDay);
}

/**
 * Mapa símbolo Nasdaq → próximo ex-dividendo { symbol, exDate, paymentDate, amount }.
 * Se queda con la fecha futura más cercana; si no hay, con la última pasada.
 */
export async function fetchDividendCalendar(daysBack = 30, daysAhead = 90) {
  const rows = await fetchDividendRows(daysBack, daysAhead);
  const map = {};
  const now = new Date();
  for (const row of rows) {
    if (!map[row.symbol]) { map[row.symbol] = row; continue; }
    const cand = new Date(row.exDate);
    const exist = new Date(map[row.symbol].exDate);
    const candFuture = cand >= now;
    const existFuture = exist >= now;
    if (candFuture && !existFuture) { map[row.symbol] = row; continue; }
    if (candFuture && existFuture && cand < exist) map[row.symbol] = row;
  }
  return map;
}

/** Mapa símbolo Nasdaq → resultados { symbol, date, epsActual, epsForecast, surprisePct }. */
export async function fetchEarningsCalendar(daysBack = 14, daysAhead = 45) {
  const rows = await fetchEarningsRows(daysBack, daysAhead);
  const map = {};
  const now = new Date();
  for (const row of rows) {
    if (!row.symbol) continue;
    if (!map[row.symbol]) { map[row.symbol] = row; continue; }
    const cand = new Date(row.date);
    const exist = new Date(map[row.symbol].date);
    if (exist < now && cand >= now) map[row.symbol] = row;
  }
  return map;
}
