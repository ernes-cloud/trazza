/**
 * Unified market data service with automatic provider fallback.
 *
 * Default priority: Yahoo Finance (free) → EODHD
 * Set VITE_MARKET_DATA_PRIMARY=eodhd in .env to flip to: EODHD → Yahoo
 *
 * If a provider fails or returns no data, the next one is tried transparently.
 * Callers never need to know which provider succeeded.
 * (Finnhub was removed from the platform in 2026-07.)
 */
import { yahooFinanceService } from './yahooFinance';
import { eodhdService } from './eodhd';

const USE_EODHD_PRIMARY = import.meta.env.VITE_MARKET_DATA_PRIMARY === 'eodhd';

async function tryProvider(fn, providerName) {
  try {
    const result = await fn();
    if (result !== null && result !== undefined) return result;
  } catch (e) {
    // 403 = key not configured, expected; other errors are genuine failures
    if (!e?.message?.includes('API key not configured')) {
      console.warn(`[marketDataService] ${providerName} failed:`, e.message);
    }
  }
  return null;
}

export const marketDataService = {
  /**
   * Get a real-time quote. Returns { current, change, percentChange, currency, companyName, symbol }.
   */
  async getQuote(ticker) {
    const primary   = USE_EODHD_PRIMARY ? eodhdService           : yahooFinanceService;
    const secondary = USE_EODHD_PRIMARY ? yahooFinanceService    : eodhdService;
    const pName     = USE_EODHD_PRIMARY ? 'EODHD'               : 'Yahoo';
    const sName     = USE_EODHD_PRIMARY ? 'Yahoo'               : 'EODHD';

    const p = await tryProvider(() => primary.getQuote(ticker), pName);
    if (p) return p;

    const s = await tryProvider(() => secondary.getQuote(ticker), sName);
    if (s) return s;

    throw new Error(`Could not fetch quote for ${ticker} from any provider`);
  },

  /**
   * Get quotes for multiple tickers. Partial failures are tolerated.
   */
  async getQuotes(tickers) {
    if (!tickers?.length) return [];

    const primary = USE_EODHD_PRIMARY ? eodhdService : yahooFinanceService;
    const primaryResults = await Promise.allSettled(tickers.map(t => primary.getQuote(t)));

    const results = [];
    const failedTickers = [];

    primaryResults.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value) {
        results.push(r.value);
      } else {
        failedTickers.push(tickers[i]);
      }
    });

    if (failedTickers.length > 0) {
      const fallbacks = await Promise.allSettled(failedTickers.map(t => this.getQuote(t)));
      fallbacks.forEach(r => {
        if (r.status === 'fulfilled' && r.value) results.push(r.value);
      });
    }

    return results;
  },

  /**
   * Get full enriched data (news, fundamentals, metrics) for a ticker overlay.
   */
  async getEnrichedData(ticker) {
    if (USE_EODHD_PRIMARY) {
      return eodhdService.getEnrichedData(ticker);
    }
    const yahoo = await tryProvider(() => yahooFinanceService.getEnrichedData(ticker), 'Yahoo');
    if (yahoo) return yahoo;
    return eodhdService.getEnrichedData(ticker);
  },

  /**
   * Get historical OHLCV data for a ticker.
   */
  async getHistoricalData(ticker, range = '1mo', interval = '1d') {
    const primary   = USE_EODHD_PRIMARY ? eodhdService        : yahooFinanceService;
    const secondary = USE_EODHD_PRIMARY ? yahooFinanceService : eodhdService;
    const pName     = USE_EODHD_PRIMARY ? 'EODHD'            : 'Yahoo';
    const sName     = USE_EODHD_PRIMARY ? 'Yahoo'            : 'EODHD';

    const p = await tryProvider(
      () => USE_EODHD_PRIMARY ? primary.getHistoricalData(ticker, range) : primary.getHistoricalData(ticker, range, interval),
      pName
    );
    if (p?.length) return p;

    const s = await tryProvider(
      () => USE_EODHD_PRIMARY ? secondary.getHistoricalData(ticker, range, interval) : secondary.getHistoricalData(ticker, range),
      sName
    );
    if (s?.length) return s;

    return [];
  },

  /**
   * Search tickers across providers. Respects primary provider order.
   *
   * Lanza si el proveedor principal FALLÓ y el de respaldo no dio nada: eso es
   * "no se pudo buscar", no "no hay resultados" (antes la barra decía "sin
   * resultados" con Yahoo caído). EODHD sin clave devuelve [] y no puede
   * desempatar, por eso manda el principal. Una cancelación se propaga tal cual.
   */
  async searchTickers(query, signal) {
    const primary   = USE_EODHD_PRIMARY ? eodhdService        : yahooFinanceService;
    const secondary = USE_EODHD_PRIMARY ? yahooFinanceService : eodhdService;
    const pName     = USE_EODHD_PRIMARY ? 'EODHD'            : 'Yahoo';
    const sName     = USE_EODHD_PRIMARY ? 'Yahoo'            : 'EODHD';

    let primaryFailed = false;
    try {
      const p = await primary.searchTickers(query, signal, { strict: true });
      if (p?.length) return p;
    } catch (e) {
      if (signal?.aborted) throw e;
      primaryFailed = true;
      console.warn(`[marketDataService] ${pName} search failed:`, e.message);
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const s = await tryProvider(() => secondary.searchTickers(query, signal), sName);
    if (s?.length) return s;
    if (primaryFailed) throw new Error('Ticker search unavailable');
    return [];
  },
};
