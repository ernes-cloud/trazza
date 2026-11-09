// Earnings data via Nasdaq public calendar API (no auth required).
// Covers US-listed stocks. For non-US stocks, falls back to EODHD calendar API
// (routed through the secure proxy — works with per-user key OR platform EODHD_PLATFORM_KEY).
// Final fallback: Yahoo Finance quoteSummary calendarEvents (works for any YF ticker).

import { authHeaders } from '@/lib/authHeaders';
import { coalesce } from '@/lib/inflight';
import { fetchServerCalendar } from '@/lib/serverCalendar';

const CACHE_TTL   = 6 * 60 * 60 * 1000; // 6 hours
const CONCURRENCY = 12; // max parallel Nasdaq requests (avoids rate limiting)

let calendarCache = null;
let cacheTime = 0;
let buildPromise = null;

// EODHD fallback state — key kept for backward compat; proxy no longer needs it directly
let eodhdKey = null;
let eodhdCache = null;
let eodhdCacheTime = 0;
let eodhdBuildPromise = null;

/**
 * Sin API key de EODHD el calendario responde 403 SIEMPRE. El código reseteaba
 * la promesa en cada fallo, así que se reintentaba por CADA ticker: en la
 * consola del owner salían DOCE 403 idénticos en una sola carga, cada uno
 * consumiendo cuota del limitador de 300/min que comparten los datos de
 * mercado de verdad. Un 403 aquí es una CONFIGURACIÓN, no un fallo transitorio:
 * se aprende una vez y no se vuelve a preguntar mientras dure la sesión.
 */
let eodhdUnavailable = false;



// Parse Nasdaq dollar strings like '$1.24', '-$0.05', 'N/A' → number or null
function parseDollar(str) {
    if (!str || str === 'N/A' || str === '--') return null;
    const n = parseFloat(str.replace(/[$,]/g, ''));
    return isNaN(n) ? null : n;
}

// Fetch one calendar day; returns array of {symbol, name, date, ...}
async function fetchDay(dateStr) {
    try {
        const r = await fetch(`/api/nasdaq/api/calendar/earnings?date=${dateStr}`, {
            signal: AbortSignal.timeout(8_000),
        });
        if (!r.ok) return [];
        const json = await r.json();
        return (json.data?.rows || []).map(row => ({
            symbol: row.symbol,
            name: row.name,
            date: dateStr,
            epsActual: parseDollar(row.eps),
            epsForecast: parseDollar(row.epsForecast),
            surprisePct: row.surprise ? parseFloat(row.surprise) : null,
            time: row.time || null,         // 'time-after-hours' | 'time-before-hours'
            fiscalQuarter: row.fiscalQuarterEnding || null,
        }));
    } catch {
        return [];
    }
}

// Process dates in chunks to prevent Nasdaq rate-limiting from 40+ parallel requests
async function fetchAllDays(dates) {
    const results = [];
    for (let i = 0; i < dates.length; i += CONCURRENCY) {
        const chunk = dates.slice(i, i + CONCURRENCY);
        const rows = (await Promise.all(chunk.map(fetchDay))).flat();
        results.push(...rows);
    }
    return results;
}

// Build ticker→entry map for a rolling window (daysBack past + daysAhead future)
async function buildCalendar(daysBack = 14, daysAhead = 45) {
    if (calendarCache && Date.now() - cacheTime < CACHE_TTL) return calendarCache;
    // Deduplicate concurrent calls
    if (buildPromise) return buildPromise;

    buildPromise = (async () => {
        const today = new Date();
        const dates = [];
        for (let i = -daysBack; i <= daysAhead; i++) {
            const d = new Date(today);
            d.setDate(d.getDate() + i);
            // Skip weekends — Nasdaq returns empty arrays, saves requests
            const dow = d.getDay();
            if (dow === 0 || dow === 6) continue;
            dates.push(d.toISOString().split('T')[0]);
        }

        // Primero el calendario que monta el server (UNA petición, compartida por
        // todos los usuarios); el día a día queda solo como respaldo.
        const allRows = (await fetchServerCalendar('earnings')) ?? await fetchAllDays(dates);
        const map = {};
        allRows.forEach(row => {
            if (!row.symbol) return;
            // Keep the entry closest to today (prefer future over past when duplicate)
            if (!map[row.symbol]) {
                map[row.symbol] = row;
            } else {
                // Prefer the upcoming date over a past one
                const existing = new Date(map[row.symbol].date);
                const candidate = new Date(row.date);
                const now = new Date();
                const existingFuture = existing >= now;
                const candidateFuture = candidate >= now;
                if (!existingFuture && candidateFuture) map[row.symbol] = row;
            }
        });

        calendarCache = map;
        cacheTime = Date.now();
        buildPromise = null;
        return map;
    })();

    return buildPromise;
}

// Convert a Yahoo-format ticker to an EODHD exchange code.
// Tickers without a dot are assumed US (e.g. AAPL → AAPL.US).
// Tickers already carrying an exchange suffix are passed through (ASML.AS, VOD.L, etc.).
function toEodhdCode(ticker) {
    if (/\.[A-Z]{1,5}$/.test(ticker)) return ticker;
    return `${ticker}.US`;
}

// Build EODHD earnings calendar: 14 days back + 120 days ahead, cached for 6 hours.
// Uses the secure proxy — works with per-user key or platform EODHD_PLATFORM_KEY.
async function buildEodhdCalendar() {
    if (eodhdUnavailable) return {};
    if (eodhdCache && Date.now() - eodhdCacheTime < CACHE_TTL) return eodhdCache;
    if (eodhdBuildPromise) return eodhdBuildPromise;

    eodhdBuildPromise = (async () => {
        const today = new Date();
        const from = new Date(today); from.setDate(from.getDate() - 14);
        const to = new Date(today);   to.setDate(to.getDate() + 120);
        const fromStr = from.toISOString().split('T')[0];
        const toStr = to.toISOString().split('T')[0];

        try {
            // Sin sesión (modo demo) el proxy responde 401 seguro: ni se pregunta.
            // No se marca como "no disponible": al iniciar sesión sí funcionará.
            const headers = await authHeaders();
            if (!headers.Authorization) {
                eodhdBuildPromise = null;
                return {};
            }
            const r = await fetch(`/api/eodhd-secure/calendar/earnings?fmt=json&from=${fromStr}&to=${toStr}`, {
                headers,
                signal: AbortSignal.timeout(15_000),
            });
            if (!r.ok) {
                // 403/401 = no hay key configurada: es permanente, no se reintenta.
                if (r.status === 403 || r.status === 401) eodhdUnavailable = true;
                eodhdBuildPromise = null;
                return {};
            }
            const json = await r.json();
            const rows = json.earnings || [];
            const map = {};
            const now = new Date();

            rows.forEach(row => {
                if (!row.code) return;
                const dotIdx = row.code.lastIndexOf('.');
                const base = dotIdx > 0 ? row.code.slice(0, dotIdx) : row.code;
                const entry = {
                    symbol: row.code,
                    name: null,
                    date: row.report_date || row.date,
                    epsActual: typeof row.actual === 'number' ? row.actual : null,
                    epsForecast: typeof row.estimate === 'number' ? row.estimate : null,
                    surprisePct: typeof row.percent === 'number' ? row.percent : null,
                    time: row.before_after_market === 'BMO' ? 'time-before-hours'
                        : row.before_after_market === 'AMC' ? 'time-after-hours' : null,
                    fiscalQuarter: null,
                };
                // Index by full code (ASML.AS) and by base ticker (ASML) so both lookups work
                [row.code, base].forEach(key => {
                    if (!key) return;
                    if (!map[key]) { map[key] = entry; return; }
                    const existing = new Date(map[key].date);
                    const candidate = new Date(entry.date);
                    if (existing < now && candidate >= now) map[key] = entry;
                });
            });

            eodhdCache = map;
            eodhdCacheTime = Date.now();
            eodhdBuildPromise = null;
            return map;
        } catch {
            eodhdBuildPromise = null;
            return {};
        }
    })();

    return eodhdBuildPromise;
}

// Yahoo Finance quoteSummary fallback — works for any YF-listed ticker (global).
const yahooEarningsCache = {};
const YAHOO_TTL = 6 * 60 * 60 * 1000;

async function fetchYahooEarnings(ticker) {
    const cached = yahooEarningsCache[ticker];
    if (cached && Date.now() - cached.ts < YAHOO_TTL) return cached.data;

    try {
        // Vía crumb proxy: v10/quoteSummary exige cookie+crumb y el proxy plano
        // `/api/yahoo` devuelve "Invalid Crumb" SIEMPRE — este fallback nunca
        // llegó a dar una fecha hasta que se cambió la ruta (2026-07-26).
        const r = await fetch(`/api/yahoo-profile/${encodeURIComponent(ticker)}?modules=calendarEvents`, {
            signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) return null;
        const json = await r.json();
        const earnings = json.quoteSummary?.result?.[0]?.calendarEvents?.earnings;
        if (!earnings) return null;

        const dates = earnings.earningsDate || [];
        if (dates.length === 0) return null;

        const now = Date.now();
        let bestMs = null;
        for (const d of dates) {
            const ms = d.raw * 1000;
            if (ms >= now && (bestMs === null || ms < bestMs)) bestMs = ms;
        }
        if (bestMs === null) {
            // All past — pick most recent
            bestMs = Math.max(...dates.map(d => d.raw * 1000));
        }

        const data = {
            symbol: ticker,
            name: null,
            date: new Date(bestMs).toISOString().split('T')[0],
            epsActual: earnings.epsActual?.raw ?? null,
            epsForecast: earnings.epsEstimate?.raw ?? null,
            surprisePct: null,
            time: null,
            fiscalQuarter: earnings.currentQuarterEstimateDate || null,
        };
        yahooEarningsCache[ticker] = { ts: Date.now(), data };
        return data;
    } catch {
        return null;
    }
}

export const earningsService = {
    // Must be called once (on Dashboard load) when user has an EODHD API key.
    setEodhdKey(key) {
        if (key && key !== eodhdKey) {
            eodhdKey = key;
            eodhdCache = null;
        }
    },

    // Returns { date, name, epsActual, epsForecast, surprisePct, time, fiscalQuarter }
    // Nasdaq → EODHD → Yahoo Finance fallback chain.
    async getEarnings(ticker) {
        if (!ticker) return null;
        // El widget de calendario y el monitor de avisos piden los mismos tickers
        // en el mismo instante: sin esto salían DOS peticiones por ticker.
        return coalesce(`earnings:${ticker}`, () => this._getEarnings(ticker));
    },

    async _getEarnings(ticker) {
        if (!ticker) return null;
        // Crypto pairs (BTC-USD, ETH-EUR, SOL-USD, etc.) have no earnings reports
        if (/^[A-Z0-9]+-[A-Z]{3}$/.test(ticker)) return null;
        const map = await buildCalendar();
        if (map[ticker]) return map[ticker];

        // EODHD fallback for non-US / non-Nasdaq stocks
        // Secure proxy handles auth — works with platform key or per-user key
        const eMap = await buildEodhdCalendar();
        const code = toEodhdCode(ticker);
        const result = eMap[code] || eMap[ticker];
        if (result) return result;

        // Yahoo Finance fallback — works for any YF-listed ticker without an API key
        return fetchYahooEarnings(ticker);
    },

    // Expose for pre-warming on dashboard load
    async prefetch() {
        return buildCalendar();
    },
};
