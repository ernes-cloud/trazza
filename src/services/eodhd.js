import { authHeaders } from '@/lib/authHeaders';
import { appLocale } from '@/lib/formatters';

// Requests go to the Vite secure-api-proxy plugin which injects the API key
// server-side. The key never travels through the browser.
const BASE_URL = '/api/eodhd-secure';

// ── Helpers shared with getEnrichedData ──────────────────────────────────────

const formatValue = (value, prefix = '', suffix = '') => {
  if (value === null || value === undefined || value === 0) return 'N/A';
  if (typeof value === 'number') {
    if (suffix === '%' && value < 100) return `${value.toFixed(2)}%`;
    if (value >= 1_000_000_000) return `${prefix}${(value / 1_000_000_000).toFixed(2)}B${suffix}`;
    if (value >= 1_000_000)     return `${prefix}${(value / 1_000_000).toFixed(2)}M${suffix}`;
    return `${prefix}${value.toLocaleString(appLocale())}${suffix}`;
  }
  return value;
};

const formatDate = (timestamp) => {
  if (!timestamp) return 'N/A';
  const date = new Date(typeof timestamp === 'string' ? timestamp : timestamp * 1000);
  if (isNaN(date.getTime())) return 'N/A';
  const diff = Math.floor((Date.now() - date) / 1000);
  if (diff < 60)    return 'Just now';
  if (diff < 3600)  return `Hace ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `Hace ${Math.floor(diff / 3600)} horas`;
  return date.toLocaleDateString(appLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
};

const getPillar = (type, marketCap, name = '', ticker = '') => {
  const n = (name || '').toLowerCase();
  const t = (ticker || '').toLowerCase();
  if (type === 'ETF' || n.includes('etf') || n.includes('fondo') || t.includes('etf')) return 'ETFs/Fondos';
  if (n.includes('bond') || n.includes('treasury') || n.includes('bono')) return 'Bonos';
  if (!marketCap || marketCap === 0) return 'Equity/Otros';
  const b = marketCap / 1_000_000_000;
  if (b < 2)  return 'Micro/Small Cap';
  if (b <= 10) return 'Mid Cap';
  return 'Large Caps';
};

const priceCache = new Map();
const historicalCache = new Map();
const fundamentalCache = new Map();
const newsCache = new Map();
const tickersCache = new Map();
const CACHE_DURATION = 5 * 60_000; // 5 minutes
const FETCH_TIMEOUT  = 10_000;    // 10 s


export const eodhdService = {
  async getQuote(ticker) {
    const cached = priceCache.get(ticker);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) return cached.data;

    const response = await fetch(`${BASE_URL}/real-time/${ticker}?fmt=json`, {
      headers: await authHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!response.ok) throw new Error('Failed to fetch quote');
    const data = await response.json();

    const result = {
      current: data.close || 0,
      change: data.change || 0,
      percentChange: data.change_p || 0,
      high: data.high || 0,
      low: data.low || 0,
      open: data.open || 0,
      prevClose: data.previousClose || 0,
      volume: data.volume || 0,
      // EODHD's real-time endpoint reports no currency. `.EUFUND` symbols are
      // only ever created by fundNavEnricher, which accepts EUR share classes
      // exclusively (verified against the search metadata) — that invariant is
      // what makes this label safe. Other symbols: let callers fall back.
      ...(ticker.toUpperCase().endsWith('.EUFUND') ? { currency: 'EUR' } : {}),
      symbol: ticker,
    };

    priceCache.set(ticker, { timestamp: Date.now(), data: result });
    return result;
  },

  async getHistoricalData(ticker, period) {
    const cacheKey = `${ticker}-${period}`;
    const cached = historicalCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) return cached.data;

    const today = new Date();
    const fromDate = new Date();
    switch (period) {
      case '1D': fromDate.setDate(today.getDate() - 1); break;
      case '1W': fromDate.setDate(today.getDate() - 7); break;
      case '1M': fromDate.setMonth(today.getMonth() - 1); break;
      case '3M': fromDate.setMonth(today.getMonth() - 3); break;
      case '6M': fromDate.setMonth(today.getMonth() - 6); break;
      case '1Y': case '1y': fromDate.setFullYear(today.getFullYear() - 1); break;
      case '2Y': case '2y': fromDate.setFullYear(today.getFullYear() - 2); break;
      case '5Y': case '5y': fromDate.setFullYear(today.getFullYear() - 5); break;
      case '10Y': case '10y': fromDate.setFullYear(today.getFullYear() - 10); break;
      default:   fromDate.setMonth(today.getMonth() - 1);
    }

    const from = fromDate.toISOString().split('T')[0];
    const to = today.toISOString().split('T')[0];

    const response = await fetch(
      `${BASE_URL}/eod/${ticker}?from=${from}&to=${to}&period=d&fmt=json`,
      { headers: await authHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT) }
    );
    if (!response.ok) return [];
    const data = await response.json();

    const result = data.map(item => ({
      time: new Date(item.date).toLocaleDateString(),
      timestamp: new Date(item.date).getTime() / 1000,
      open: item.open,
      high: item.high,
      low: item.low,
      close: item.close,
      volume: item.volume,
    }));

    historicalCache.set(cacheKey, { timestamp: Date.now(), data: result });
    return result;
  },

  async getFundamentalData(ticker) {
    const cached = fundamentalCache.get(ticker);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) return cached.data;

    const response = await fetch(`${BASE_URL}/fundamentals/${ticker}?fmt=json`, {
      headers: await authHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!response.ok) return null;
    const data = await response.json();

    const result = {
      profile: {
        name: data.General?.Name || '',
        ticker,
        exchange: data.General?.Exchange || '',
        sector: data.General?.Sector || '',
        industry: data.General?.Industry || '',
        description: data.General?.Description || '',
        weburl: data.General?.WebURL || '',
        ipo: data.General?.IPODate || '',
        marketCapitalization: data.Highlights?.MarketCapitalization || 0,
        currency: data.General?.CurrencyCode || '',
        type: data.General?.Type || '',
      },
      metric: {
        peTTM: data.Highlights?.PERatio || 0,
        dividendYieldIndicatedAnnual: data.Highlights?.DividendYield
          ? data.Highlights.DividendYield * 100 : 0,
        '52WeekHigh': data.Highlights?.['52WeekHigh'] || 0,
        '52WeekLow': data.Highlights?.['52WeekLow'] || 0,
        beta: data.Technicals?.Beta || 0,
        bookValue: data.Highlights?.BookValue || 0,
        epsEstimateCurrentYear: data.Highlights?.EarningsShare || 0,
      },
    };

    fundamentalCache.set(ticker, { timestamp: Date.now(), data: result });
    return result;
  },

  async searchTickers(query, signal) {
    const fetchSignal = signal ?? AbortSignal.timeout(FETCH_TIMEOUT);
    const response = await fetch(
      `${BASE_URL}/search/${encodeURIComponent(query)}?limit=15`,
      { headers: await authHeaders(), signal: fetchSignal }
    );
    if (!response.ok) return [];
    const data = await response.json();

    return data.map(item => ({
      symbol: item.Code,
      displaySymbol: `${item.Code}.${item.Exchange}`,
      description: item.Name,
      type: item.Type || 'EQUITY',
      // Needed by fundNavEnricher's ISIN resolution: EODHD's search is the
      // only provider that reports the share-class currency directly.
      exchange: item.Exchange || '',
      currency: item.Currency || null,
      isin: item.ISIN || null,
    }));
  },

  async getNews(ticker) {
    const cached = newsCache.get(ticker);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) return cached.data;

    const today = new Date();
    const fromDate = new Date();
    fromDate.setDate(today.getDate() - 7);

    const from = fromDate.toISOString().split('T')[0];
    const to = today.toISOString().split('T')[0];

    const response = await fetch(
      `${BASE_URL}/news?s=${ticker}&from=${from}&to=${to}&fmt=json&limit=20`,
      { headers: await authHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT) }
    );
    if (!response.ok) return [];
    const data = await response.json();

    const result = data.map(item => ({
      id: item.link || Math.random().toString(),
      headline: item.title,
      summary: item.content || item.title,
      url: item.link,
      source: item.source || 'News',
      datetime: new Date(item.date).getTime() / 1000,
      image: item.image || null,
    }));

    newsCache.set(ticker, { timestamp: Date.now(), data: result });
    return result;
  },

  async getSupportedTickers(exchange = 'US') {
    const cacheKey = `tickers-${exchange}`;
    const cached = tickersCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 3600000) return cached.data;

    const response = await fetch(
      `${BASE_URL}/exchange-symbol-list/${exchange}?fmt=json`,
      { headers: await authHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT) }
    );
    if (!response.ok) return [];
    const data = await response.json();

    const result = data.map(item => ({
      symbol: item.Code,
      name: item.Name,
      exchange: item.Exchange,
      type: item.Type,
    }));

    tickersCache.set(cacheKey, { timestamp: Date.now(), data: result });
    return result;
  },

  async getCompanyProfile(ticker) { return (await this.getFundamentalData(ticker))?.profile || null; },
  async getAnalystRecommendation(_ticker) { return []; },
  async getBasicFinancials(ticker) { return await this.getFundamentalData(ticker); },
  async getCandles(ticker, resolution) {
    return await this.getHistoricalData(ticker, this.mapResolutionToPeriod(resolution));
  },

  mapResolutionToPeriod(resolution) {
    return { '1': '1D', '5': '1D', '15': '1D', '30': '1D', '60': '1W', D: '1M', W: '6M', M: '1Y' }[resolution] || '1M';
  },

  /**
   * Returns the same shape as yahooFinanceService.getEnrichedData():
   * { header, metrics, about, news }
   */
  async getEnrichedData(ticker) {
    const [quoteRes, fundamentalRes, newsRes] = await Promise.allSettled([
      this.getQuote(ticker),
      this.getFundamentalData(ticker),
      this.getNews(ticker),
    ]);

    const quote       = quoteRes.status       === 'fulfilled' ? quoteRes.value       : null;
    const fundamental = fundamentalRes.status === 'fulfilled' ? fundamentalRes.value : null;
    const news        = newsRes.status        === 'fulfilled' ? newsRes.value        : [];

    if (!quote) throw new Error(`EODHD: could not fetch quote for ${ticker}`);

    const profile  = fundamental?.profile || {};
    const metric   = fundamental?.metric  || {};

    const marketCap  = profile.marketCapitalization || 0;
    const currency   = profile.currency || 'USD';
    const currSymbol = currency === 'GBP' ? '£' : (currency === 'EUR' ? '€' : '$');
    const change     = quote.change || 0;
    const pctChange  = quote.percentChange || 0;
    const pillar     = getPillar(profile.type, marketCap, profile.name, ticker);

    return {
      header: {
        symbol: ticker,
        name: profile.name || ticker,
        price: quote.current || 0,
        change: `${change >= 0 ? '+' : ''}${change.toFixed(2)} (${pctChange.toFixed(2)}%)`,
        pillar,
        currencySymbol: currSymbol,
        isPositive: change >= 0,
      },
      metrics: [
        { label: 'MARKET CAP',  value: formatValue(marketCap, currSymbol) },
        { label: 'P/E RATIO',   value: formatValue(metric.peTTM) },
        { label: 'DIV YIELD',   value: formatValue(metric.dividendYieldIndicatedAnnual, '', '%') },
        { label: '52W HIGH',    value: formatValue(metric['52WeekHigh'], currSymbol) },
        { label: '52W LOW',     value: formatValue(metric['52WeekLow'],  currSymbol) },
        { label: 'BETA',        value: formatValue(metric.beta) },
      ],
      about: {
        description: profile.description
          ? (profile.description.length > 500 ? profile.description.substring(0, 500).trim() + '...' : profile.description)
          : 'No description available for this ticker.',
        details: {
          sector:   profile.sector   || 'N/A',
          industry: profile.industry || 'N/A',
          exchange: profile.exchange || 'N/A',
          ...(profile.weburl ? { website: profile.weburl } : {}),
        },
      },
      news: news.map(item => ({
        title:         item.headline,
        source:        item.source,
        formattedDate: formatDate(item.datetime),
        image:         item.image,
        url:           item.url,
      })),
    };
  },
};
