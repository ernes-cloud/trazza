// Upcoming dividend data via Nasdaq public calendar API (no auth required).
// Covers US-listed stocks. For non-US stocks, falls back to EODHD calendar
// (routed through the secure proxy — works with per-user key OR platform EODHD_PLATFORM_KEY).
// Final fallback: Yahoo historical pattern prediction.

import { authHeaders } from '@/lib/authHeaders';
import { coalesce } from '@/lib/inflight';
import { fetchServerCalendar } from '@/lib/serverCalendar';

const CACHE_TTL    = 6 * 60 * 60 * 1000; // 6 hours
const CONCURRENCY  = 12; // max parallel Nasdaq requests (avoids rate limiting)


let calendarCache = null;
let cacheTime = 0;
let buildPromise = null;

// Parse Nasdaq date strings: 'M/DD/YYYY' → 'YYYY-MM-DD'
function parseNasdaqDate(str) {
    if (!str) return null;
    const parts = str.split('/');
    if (parts.length !== 3) return null;
    const [m, d, y] = parts;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

async function fetchDay(dateStr) {
    try {
        const r = await fetch(`/api/nasdaq/api/calendar/dividends?date=${dateStr}`, {
            signal: AbortSignal.timeout(8_000),
        });
        if (!r.ok) return [];
        const json = await r.json();
        const rows = json.data?.calendar?.rows || [];
        return rows.map(row => ({
            symbol: row.symbol,
            name: row.companyName,
            exDate: parseNasdaqDate(row.dividend_Ex_Date),
            paymentDate: parseNasdaqDate(row.payment_Date),
            recordDate: parseNasdaqDate(row.record_Date),
            amount: typeof row.dividend_Rate === 'number' ? row.dividend_Rate : null,
            annualDividend: typeof row.indicated_Annual_Dividend === 'number' ? row.indicated_Annual_Dividend : null,
        })).filter(r => r.symbol && r.exDate);
    } catch {
        return [];
    }
}

// Process dates in chunks to prevent Nasdaq rate-limiting from 80+ parallel requests
async function fetchAllDays(dates) {
    const results = [];
    for (let i = 0; i < dates.length; i += CONCURRENCY) {
        const chunk = dates.slice(i, i + CONCURRENCY);
        const rows = (await Promise.all(chunk.map(fetchDay))).flat();
        results.push(...rows);
    }
    return results;
}

async function buildCalendar(daysBack = 30, daysAhead = 90) {
    if (calendarCache && Date.now() - cacheTime < CACHE_TTL) return calendarCache;
    if (buildPromise) return buildPromise;

    buildPromise = (async () => {
        const today = new Date();
        const dates = [];
        for (let i = -daysBack; i <= daysAhead; i++) {
            const d = new Date(today);
            d.setDate(d.getDate() + i);
            const dow = d.getDay();
            if (dow === 0 || dow === 6) continue; // skip weekends
            dates.push(d.toISOString().split('T')[0]);
        }

        // Primero el calendario que monta el server (UNA petición, compartida por
        // todos los usuarios); el día a día queda solo como respaldo.
        const allRows = (await fetchServerCalendar('dividends')) ?? await fetchAllDays(dates);

        // Build map: symbol → entry with the nearest upcoming ex-date
        // If multiple ex-dates exist (quarterly payer), prefer the soonest future one
        const map = {};
        const now = new Date();
        allRows.forEach(row => {
            const exDate = new Date(row.exDate);
            if (!map[row.symbol]) {
                map[row.symbol] = row;
                return;
            }
            const existing = new Date(map[row.symbol].exDate);
            // Prefer future over past; among futures prefer earliest; among past prefer most recent
            const rowFuture = exDate >= now;
            const existingFuture = existing >= now;
            if (rowFuture && !existingFuture) { map[row.symbol] = row; return; }
            if (!rowFuture && existingFuture) return;
            if (rowFuture && rowFuture && exDate < existing) { map[row.symbol] = row; return; }
            if (!rowFuture && !existingFuture && exDate > existing) { map[row.symbol] = row; }
        });

        calendarCache = map;
        cacheTime = Date.now();
        buildPromise = null;
        return map;
    })();

    return buildPromise;
}

// EODHD dividend calendar: 30 days back + 120 days ahead, cached 6 hours.
// Routed through the secure proxy — works with per-user key or platform EODHD_PLATFORM_KEY.
let eodhdDivCache = null;
let eodhdDivCacheTime = 0;
let eodhdDivBuildPromise = null;

/**
 * Sin API key de EODHD el calendario responde 403 SIEMPRE. El código reseteaba
 * la promesa en cada fallo, así que se reintentaba por CADA ticker: en la
 * consola del owner salían DOCE 403 idénticos en una sola carga, cada uno
 * consumiendo cuota del limitador de 300/min que comparten los datos de
 * mercado de verdad. Un 403 aquí es una CONFIGURACIÓN, no un fallo transitorio:
 * se aprende una vez y no se vuelve a preguntar mientras dure la sesión.
 */
let eodhdDivUnavailable = false;

async function buildEodhdDividendCalendar() {
    if (eodhdDivUnavailable) return {};
    if (eodhdDivCache && Date.now() - eodhdDivCacheTime < CACHE_TTL) return eodhdDivCache;
    if (eodhdDivBuildPromise) return eodhdDivBuildPromise;

    eodhdDivBuildPromise = (async () => {
        const today = new Date();
        const from = new Date(today); from.setDate(from.getDate() - 30);
        const to   = new Date(today); to.setDate(to.getDate() + 120);
        const fromStr = from.toISOString().split('T')[0];
        const toStr   = to.toISOString().split('T')[0];

        try {
            // Sin sesión (modo demo) el proxy responde 401 seguro: ni se pregunta.
            // No se marca como "no disponible": al iniciar sesión sí funcionará.
            const headers = await authHeaders();
            if (!headers.Authorization) {
                eodhdDivBuildPromise = null;
                return {};
            }
            const r = await fetch(`/api/eodhd-secure/calendar/dividends?fmt=json&from=${fromStr}&to=${toStr}`, {
                headers,
                signal: AbortSignal.timeout(15_000),
            });
            if (!r.ok) {
                // 403/401 = no hay key configurada: es permanente, no se reintenta.
                if (r.status === 403 || r.status === 401) eodhdDivUnavailable = true;
                eodhdDivBuildPromise = null;
                return {};
            }
            const json = await r.json();
            const rows = json.dividends || [];
            const map = {};
            const now = new Date();

            rows.forEach(row => {
                if (!row.code) return;
                const dotIdx = row.code.lastIndexOf('.');
                const base = dotIdx > 0 ? row.code.slice(0, dotIdx) : row.code;
                const exDate = row.ex_dividend_date || row.date;
                const entry = {
                    symbol:        row.code,
                    name:          null,
                    exDate,
                    paymentDate:   row.payment_date || null,
                    recordDate:    row.record_date || null,
                    amount:        typeof row.value === 'number' ? row.value : null,
                    annualDividend: null,
                    isPredicted:   false,
                };
                [row.code, base].forEach(key => {
                    if (!key) return;
                    if (!map[key]) { map[key] = entry; return; }
                    // Prefer nearest future ex-date
                    const existingFuture = new Date(map[key].exDate) >= now;
                    const candidateFuture = exDate ? new Date(exDate) >= now : false;
                    if (candidateFuture && !existingFuture) map[key] = entry;
                });
            });

            eodhdDivCache = map;
            eodhdDivCacheTime = Date.now();
            eodhdDivBuildPromise = null;
            return map;
        } catch {
            eodhdDivBuildPromise = null;
            return {};
        }
    })();

    return eodhdDivBuildPromise;
}

// Yahoo v8/chart fallback: predict next dividend from 2-year historical pattern.
// Used for non-US stocks not covered by Nasdaq or EODHD dividend calendar.
async function predictFromYahoo(ticker) {
    try {
        const r = await fetch(`/api/yahoo/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1mo&events=div`, {
            signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) return null;
        const json = await r.json();
        const divEvents = json.chart?.result?.[0]?.events?.dividends;
        if (!divEvents) return null;

        const divs = Object.values(divEvents).sort((a, b) => a.date - b.date);
        if (divs.length < 2) return null;

        const intervals = [];
        for (let i = 1; i < divs.length; i++) {
            intervals.push((divs[i].date - divs[i - 1].date) / 86400);
        }
        const avgInterval = intervals.reduce((s, v) => s + v, 0) / intervals.length;

        // Map average interval → payment period in days
        let period;
        if (avgInterval < 45) period = 30;           // monthly
        else if (avgInterval < 120) period = 91;     // quarterly
        else if (avgInterval < 240) period = 182;    // semi-annual
        else period = 365;                           // annual

        const lastDiv = divs[divs.length - 1];
        const lastDate = new Date(lastDiv.date * 1000);
        const now = new Date();

        let nextDate = new Date(lastDate.getTime() + period * 86400 * 1000);
        while (nextDate < now) {
            nextDate = new Date(nextDate.getTime() + period * 86400 * 1000);
        }

        const toISO = (d) => d.toISOString().split('T')[0];
        return {
            symbol: ticker,
            name: null,
            exDate: toISO(nextDate),
            paymentDate: null,
            recordDate: null,
            amount: lastDiv.amount,
            annualDividend: lastDiv.amount * (365 / period),
            isPredicted: true,
        };
    } catch {
        return null;
    }
}

// Per-ticker cache for historical annual dividends paid per share
const histAnnualCache = {};

// Returns total dividend per share paid in the given calendar year for a ticker
async function getHistoricalAnnualPerShare(ticker, year) {
    const cached = histAnnualCache[ticker];
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
        return cached.data[year] ?? 0;
    }
    try {
        const r = await fetch(`/api/yahoo/v8/finance/chart/${encodeURIComponent(ticker)}?range=3y&interval=1mo&events=div`, {
            signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) return 0;
        const json = await r.json();
        const divEvents = json.chart?.result?.[0]?.events?.dividends;
        if (!divEvents) {
            histAnnualCache[ticker] = { ts: Date.now(), data: {} };
            return 0;
        }
        const byYear = {};
        Object.values(divEvents).forEach(d => {
            const yr = new Date(d.date * 1000).getFullYear();
            byYear[yr] = (byYear[yr] || 0) + d.amount;
        });
        histAnnualCache[ticker] = { ts: Date.now(), data: byYear };
        return byYear[year] ?? 0;
    } catch {
        return 0;
    }
}

export const dividendService = {
    // Returns { symbol, name, exDate, paymentDate, recordDate, amount, annualDividend, isPredicted? }
    // isPredicted=true means date is extrapolated from historical pattern (non-US stocks).
    async getDividend(ticker) {
        if (!ticker) return null;
        // Mismo motivo que en earningsService: calendario y monitor coinciden.
        return coalesce(`dividend:${ticker}`, () => this._getDividend(ticker));
    },

    async _getDividend(ticker) {
        if (!ticker) return null;
        const map = await buildCalendar();
        if (map[ticker]) return map[ticker];        // Nasdaq confirmed (US stock)

        // EODHD: covers non-US exchanges (LSE, XETRA, Euronext, BME, etc.)
        const eMap = await buildEodhdDividendCalendar();
        const dotIdx = ticker.lastIndexOf('.');
        const base = dotIdx > 0 ? ticker.slice(0, dotIdx) : ticker;
        const eResult = eMap[ticker] || eMap[base];
        if (eResult) return eResult;

        return predictFromYahoo(ticker);            // Final fallback: Yahoo historical pattern
    },

    // Returns total dividends per share paid in a given year for a ticker
    async getAnnualPerShare(ticker, year) {
        if (!ticker) return 0;
        return getHistoricalAnnualPerShare(ticker, year);
    },

    async prefetch() {
        return buildCalendar();
    },
};
