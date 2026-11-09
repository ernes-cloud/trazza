import { yahooFinanceService, barDateFromTimestamp } from './yahooFinance';
import { localTodayIso } from '@/lib/dates';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const EXCHANGE_RATE_CACHE = new Map();
const CACHE_DURATION = 600000; // 10 minutes
const LS_KEY = 'trazza_fx_rates';

function getLocalCache() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
}

function writeLocalCache(pair, rate) {
    try {
        const cache = getLocalCache();
        cache[pair] = { rate, timestamp: Date.now() };
        localStorage.setItem(LS_KEY, JSON.stringify(cache));
    } catch { /* localStorage full — ignore */ }
}

export const currencyService = {
    /**
     * Gets exchange rate from one currency to another.
     * Caches in memory (survives re-renders) and in localStorage (survives page reloads).
     * TTL: 10 minutes — short enough to pick up significant rate moves, long enough to prevent
     * jitter from multiple rapid reloads showing different portfolio values.
     */
    async getExchangeRate(from, to) {
        if (!from || !to || from === to) return 1;

        const pair = `${from}${to}=X`;

        // 1. In-memory cache (fastest)
        const memCached = EXCHANGE_RATE_CACHE.get(pair);
        if (memCached && Date.now() - memCached.timestamp < CACHE_DURATION) {
            return memCached.rate;
        }

        // 2. localStorage cache (survives page reload)
        const lsCached = getLocalCache()[pair];
        if (lsCached && Date.now() - lsCached.timestamp < CACHE_DURATION) {
            EXCHANGE_RATE_CACHE.set(pair, lsCached); // warm in-memory cache
            return lsCached.rate;
        }

        // 3. Fetch from API
        try {
            const quote = await yahooFinanceService.getQuote(pair);
            const rate = quote.current;

            if (rate) {
                const entry = { rate, timestamp: Date.now() };
                EXCHANGE_RATE_CACHE.set(pair, entry);
                writeLocalCache(pair, rate);
                return rate;
            }
        } catch (error) {
            console.error(`Error fetching exchange rate for ${pair}:`, error);

            // Return stale cached value if available rather than wrong fallback
            if (lsCached?.rate) return lsCached.rate;

            const fallbacks = {
                'EURUSD=X': 1.08, 'USDEUR=X': 0.92,
                'GBPUSD=X': 1.26, 'USDGBP=X': 0.79,
                'GBPEUR=X': 1.16, 'EURGBP=X': 0.86,
                'USDJPY=X': 150.0, 'JPYUSD=X': 0.0067
            };
            if (fallbacks[pair]) return fallbacks[pair];
        }

        return 1;
    },

    /**
     * Converts an amount from one currency to another.
     */
    async convert(amount, from, to) {
        if (from === to) return amount;
        const rate = await this.getExchangeRate(from, to);
        return amount * rate;
    },

    /**
     * Gets the exchange rate for a specific historical date.
     * Uses Yahoo Finance chart API with a narrow time window around the target date.
     * Results are cached permanently in localStorage (historical rates don't change).
     */
    async getHistoricalRate(from, to, dateStr) {
        if (!from || !to || from === to || !dateStr) return null;

        const cacheKey = `wf_hist_${from}_${to}_${dateStr}`;
        try {
            const raw = localStorage.getItem(cacheKey);
            if (raw) return parseFloat(raw);
        } catch {}

        const pair = `${from}${to}=X`;
        const target = new Date(dateStr);
        const period1 = Math.floor((target.getTime() - 5 * 86400000) / 1000);
        const period2 = Math.floor(Math.min(target.getTime() + 7 * 86400000, Date.now()) / 1000);

        // 1. Try Yahoo Finance (chart endpoint via Vite proxy)
        try {
            const url = `/api/yahoo/v8/finance/chart/${encodeURIComponent(pair)}?period1=${period1}&period2=${period2}&interval=1d`;
            const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
            if (resp.ok) {
                const data = await resp.json();
                const result = data?.chart?.result?.[0];
                if (result) {
                    const timestamps = result.timestamp || [];
                    const closes = result.indicators?.quote?.[0]?.close || [];
                    const targetTs = Math.floor(target.getTime() / 1000);
                    let bestIdx = -1, minDist = Infinity;
                    timestamps.forEach((ts, i) => {
                        if (closes[i] == null) return;
                        const dist = Math.abs(ts - targetTs);
                        if (dist < minDist) { minDist = dist; bestIdx = i; }
                    });
                    if (bestIdx !== -1) {
                        const rate = closes[bestIdx];
                        try { localStorage.setItem(cacheKey, String(rate)); } catch {}
                        return rate;
                    }
                }
            }
        } catch (e) {
            // Yahoo failed or rate-limited — fall through to Frankfurter
        }

        // 2. Fallback: Frankfurter ECB data (api.frankfurter.dev/v1) — routed through Vite proxy
        try {
            const fResp = await fetch(`/api/frankfurter/${dateStr}?from=${from}&to=${to}`, {
                signal: AbortSignal.timeout(10_000),
            });
            if (fResp.ok) {
                const fData = await fResp.json();
                const rate = fData?.rates?.[to];
                if (rate) {
                    try { localStorage.setItem(cacheKey, String(rate)); } catch {}
                    return rate;
                }
            }
        } catch (e2) {
            console.error(`getHistoricalRate ${from}→${to} @ ${dateStr}: both Yahoo and Frankfurter failed`, e2);
        }

        return null;
    },

    /**
     * Tipo `from`→`to` del día `dateStr` ('YYYY-MM-DD') o, si ese día no hubo
     * cotización (fin de semana, festivo), el del ÚLTIMO día hábil ANTERIOR.
     * Nunca devuelve un cierre posterior a la fecha.
     *
     * Por qué no getHistoricalRate: esa coge el cierre MÁS CERCANO, que para un
     * domingo es el lunes siguiente — válido para valorar una serie, no para
     * Hacienda (informe fiscal). Su caché tampoco sirve aquí (otra regla), así
     * que esta usa clave propia y no cambia nada para sus llamadores.
     *
     * @returns {Promise<{ rate: number, date: string } | null>} `date` = día
     *   real del tipo usado (≤ dateStr). null si ninguna fuente lo tiene.
     */
    async getHistoricalRateOnOrBefore(from, to, dateStr) {
        if (!from || !to || from === to || !dateStr || !ISO_DAY.test(dateStr)) return null;

        const cacheKey = `wf_hist_ob_${from}_${to}_${dateStr}`;
        try {
            const raw = localStorage.getItem(cacheKey);
            if (raw) {
                const hit = JSON.parse(raw);
                if (hit && Number.isFinite(hit.rate) && typeof hit.date === 'string' && hit.date <= dateStr) return hit;
            }
        } catch { /* caché ilegible: se vuelve a pedir */ }

        // El cierre de HOY todavía se mueve: no se cachea.
        const remember = (hit) => {
            if (dateStr < localTodayIso()) {
                try { localStorage.setItem(cacheKey, JSON.stringify(hit)); } catch { /* localStorage lleno */ }
            }
            return hit;
        };

        const pair = `${from}${to}=X`;
        const dayStartUtc = Date.parse(`${dateStr}T00:00:00Z`);
        const period1 = Math.floor((dayStartUtc - 10 * 86400000) / 1000);
        const period2 = Math.floor(Math.min(dayStartUtc + 2 * 86400000, Date.now()) / 1000);

        // 1. Yahoo: la barra con fecha (de su mercado) ≤ dateStr más reciente.
        //    Sin gmtoffset no se sabe la fecha real de la barra (la de FX está
        //    sellada a las 23:00Z del día ANTERIOR): mejor pasar a Frankfurter
        //    que arriesgarse a coger el tipo del día siguiente.
        try {
            const url = `/api/yahoo/v8/finance/chart/${encodeURIComponent(pair)}?period1=${period1}&period2=${period2}&interval=1d`;
            const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
            if (resp.ok) {
                const result = (await resp.json())?.chart?.result?.[0];
                const offset = result?.meta?.gmtoffset;
                if (result && Number.isFinite(offset)) {
                    const timestamps = result.timestamp || [];
                    const closes = result.indicators?.quote?.[0]?.close || [];
                    let best = null;
                    timestamps.forEach((ts, i) => {
                        const rate = closes[i];
                        if (!Number.isFinite(rate) || rate <= 0) return;
                        const day = barDateFromTimestamp(ts, offset);
                        if (day && day <= dateStr && (!best || day >= best.date)) best = { rate, date: day };
                    });
                    if (best) return remember(best);
                }
            }
        } catch (e) {
            console.warn(`getHistoricalRateOnOrBefore ${pair} @ ${dateStr}: Yahoo falló, pruebo Frankfurter`, e);
        }

        // 2. Frankfurter (BCE): para un día sin fixing ya devuelve el hábil anterior.
        try {
            const fResp = await fetch(`/api/frankfurter/${dateStr}?from=${from}&to=${to}`, {
                signal: AbortSignal.timeout(10_000),
            });
            if (fResp.ok) {
                const fData = await fResp.json();
                const rate = fData?.rates?.[to];
                const day = typeof fData?.date === 'string' ? fData.date : null;
                if (Number.isFinite(rate) && rate > 0 && day && day <= dateStr) return remember({ rate, date: day });
            }
        } catch (e2) {
            console.error(`getHistoricalRateOnOrBefore ${pair} @ ${dateStr}: Yahoo y Frankfurter fallaron`, e2);
        }

        return null;
    },
};
