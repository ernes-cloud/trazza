import { tickerGuard } from '@/lib/tickerGuard';
import { appLocale, formatNumber, formatPercent } from '@/lib/formatters';

// Enfriamiento compartido del proxy de perfiles (ver getProfile).
let profileCooldownUntil = 0;
const PROFILE_COOLDOWN_MS = 60_000;

const BASE_URL = '/api/yahoo';

// Yahoo quotes LSE pence-denominated instruments with currency 'GBp' (occasionally
// 'GBX'); their prices arrive in pence and must be divided by 100 → GBP.
// NEVER infer pence from the '.L' suffix: many LSE ETFs are USD-denominated
// (VUAA.L, SMH.L…) — the old suffix check turned $111.20 into £1.11.
// Note 'GBP' (uppercase P) means pounds, NOT pence — the comparison is case-sensitive.
export const isPenceCurrency = (currency) => currency === 'GBp' || currency === 'GBX';

/**
 * Trading date ('YYYY-MM-DD') of a chart bar, in the EXCHANGE's timezone.
 *
 * Yahoo stamps 1wk/1mo bars at LOCAL midnight of the period start, so reading
 * their UTC date puts every European series one day early: ^IBEX's week of
 * Mon 28-Jul arrives as `2025-07-27T22:00:00Z` (Sun) while ^GSPC's arrives as
 * `2025-07-28T04:00:00Z` (Mon), and VUAA.L's April bar as `03-31T23:00Z`.
 * Mixing a European and a US series then left an EMPTY date intersection —
 * that is why the backtest drew nothing for ^IBEX + ^GSPC on any weekly or
 * monthly range.
 *
 * `gmtoffset` (seconds, from the chart `meta`) shifts the instant to exchange
 * wall clock, which IS the bar's date. Daily bars are unaffected: they are
 * stamped at the market open, hours away from local midnight (Madrid 07:00Z
 * → 09:00, New York 13:30Z → 09:30, crypto has offset 0).
 */
export const barDateFromTimestamp = (ts, gmtoffset = 0) => {
    if (!Number.isFinite(ts)) return null;
    const offset = Number(gmtoffset);
    return new Date((ts + (Number.isFinite(offset) ? offset : 0)) * 1000).toISOString().split('T')[0];
};

// Helpers
const formatDate = (timestamp) => {
    if (!timestamp) return 'N/A';
    const date = new Date(timestamp * 1000);
    if (isNaN(date.getTime())) return 'N/A';

    const now = new Date();
    const diffInSeconds = Math.floor((now - date) / 1000);

    if (diffInSeconds < 60) return 'Just now';
    if (diffInSeconds < 3600) return `Hace ${Math.floor(diffInSeconds / 60)} min`;
    if (diffInSeconds < 86400) return `Hace ${Math.floor(diffInSeconds / 3600)} horas`;

    return date.toLocaleDateString(appLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
};

const EXCHANGE_MAPPING = {
    'PCX': 'NYSE Arca',
    'NYQ': 'NYSE',
    'NMS': 'NASDAQ',
    'NPT': 'NASDAQ',
    'NGM': 'NASDAQ',
    'ASE': 'NYSE American',
    'LSE': 'London Stock Exchange',
    'PAR': 'Euronext Paris',
    'FRA': 'Frankfurt Stock Exchange',
    'GER': 'XETRA',
    'MCX': 'Moscow Exchange',
    'Otc': 'OTC Markets',
    'PNK': 'OTC Pink',
    'BTS': 'BATS',
    'AMS': 'Euronext Amsterdam',
    'BRU': 'Euronext Brussels',
    'LIS': 'Euronext Lisbon',
    'MIL': 'Borsa Italiana',
    'MAD': 'Bolsa de Madrid',
    'STO': 'Nasdaq Stockholm',
    'HEL': 'Nasdaq Helsinki',
    'CPH': 'Nasdaq Copenhagen'
};

const mapExchange = (code) => {
    if (!code) return 'N/A';
    return EXCHANGE_MAPPING[code] || code;
};

const formatValue = (value, prefix = '', suffix = '') => {
    if (value === null || value === undefined || value === 0) return 'N/A';
    if (typeof value === 'number') {
        // Handle cases where value might be a small decimal (dividend yield)
        if (suffix === '%' && value < 100) return formatPercent(value, 2);

        if (value >= 1000000000) return `${prefix}${formatNumber(value / 1000000000, 2, 2)}B${suffix}`;
        if (value >= 1000000) return `${prefix}${formatNumber(value / 1000000, 2, 2)}M${suffix}`;
        return `${prefix}${formatNumber(value, 0, 2)}${suffix}`;
    }
    return value;
};

const getPillar = (type, marketCap, name = '', ticker = '') => {
    const n = (name || '').toLowerCase();
    const t = (ticker || '').toLowerCase();

    if (type === 'ETF' || type === 'MUTUALFUND' || n.includes('etf') || n.includes('fondo') || t.includes('etf')) return 'ETFs/Fondos';
    if (n.includes('bond') || n.includes('treasury') || n.includes('bono') || n.includes('deuda')) return 'Bonos';

    if (!marketCap || marketCap === 0) return 'Equity/Otros';

    // Values in Billions for comparison
    const mCapInBillions = marketCap / 1000000000;
    if (mCapInBillions < 2) return 'Micro/Small Cap';
    if (mCapInBillions <= 10) return 'Mid Cap';
    return 'Large Caps';
};

// In-memory cache
const cache = new Map();
const CACHE_DURATION  = 5 * 60_000;  // 5 min for quotes — enough freshness for portfolio tracking
const FETCH_TIMEOUT   = 10_000;      // 10 s — prevents requests from hanging indefinitely

/**
 * Respuesta de /v1/finance/search (`quotes`) o de /v1/finance/lookup
 * (`finance.result[0].documents`) → filas del buscador. Las filas sin símbolo
 * (empresas de Crunchbase, listas…) no son cotizaciones y se descartan.
 */
export const mapYahooSearchResponse = (data) => {
    const items = data?.quotes ?? data?.finance?.result?.[0]?.documents ?? [];
    return items
        .filter((item) => item?.symbol)
        .map((item) => ({
            symbol: item.symbol,
            displaySymbol: item.symbol,
            description: item.longname || item.shortname || item.shortName || item.name || item.symbol,
            isin: item.isin || null,
            type: (item.quoteType || 'EQUITY').toUpperCase(),
            exchange: item.exchange,
            // "NASDAQ", "Frankfurt", "Toronto": lo que distingue AAPL de AAPL.TO.
            exchangeName: item.exchDisp || null,
        }));
};

// El timeout NO se puede perder cuando el llamante trae su propia señal (la
// barra de búsqueda cancela al teclear): sin él, un Yahoo colgado dejaba el
// spinner girando para siempre.
const withTimeout = (signal) => {
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT);
    if (!signal) return timeout;
    return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal;
};

export const yahooFinanceService = {
    /**
     * @param {string} query
     * @param {AbortSignal} [signal]
     * @param {{ strict?: boolean }} [options] strict: lanza si TODOS los
     *   endpoints fallan, para distinguir "Yahoo no responde" de "no hay
     *   resultados". Por defecto devuelve [] — los imports cuentan con ello.
     */
    async searchTickers(query, signal, { strict = false } = {}) {
        if (!query) return [];

        const endpoints = [
            `${BASE_URL}/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0&enableFuzzyQuery=true`,
            // Sin `type`: el antiguo `type=stock` devolvía 400 ("Valid types: equity, mutualfund…")
            // y el respaldo no había funcionado nunca.
            `${BASE_URL}/v1/finance/lookup?query=${encodeURIComponent(query)}&count=10`
        ];

        let failures = 0;
        for (const url of endpoints) {
            try {
                const response = await fetch(url, { signal: withTimeout(signal) });
                if (!response.ok) {
                    failures += 1;
                    if (response.status === 429) console.warn(`Yahoo Finance 429 for ${url}. Trying next.`);
                    continue;
                }
                const results = mapYahooSearchResponse(await response.json());
                if (results.length > 0) return results;
            } catch (error) {
                if (signal?.aborted) throw error;
                failures += 1;
                console.error(`Yahoo Finance error for ${url}:`, error);
            }
        }
        if (strict && failures === endpoints.length) throw new Error('Yahoo search unavailable');
        return [];
    },

    async getEnrichedData(ticker) {
        try {
            // Fetch quote, profile, supplementary v6 data, and news all in parallel.
            // extraQuoteRes fills in PE/yield/beta when getQuote() used the v8 chart endpoint
            // (which doesn't return those fields). profile (v10) takes priority when available.
            const [quoteRes, profileRes, extraQuoteRes, newsRes] = await Promise.allSettled([
                this.getQuote(ticker),
                this.getProfile(ticker),
                fetch(`${BASE_URL}/v6/finance/quote?symbols=${encodeURIComponent(ticker)}`, {
                    signal: AbortSignal.timeout(FETCH_TIMEOUT),
                }).then(r => r.ok ? r.json() : null),
                this.getNews(ticker),
            ]);

            const quote     = quoteRes.status     === 'fulfilled' ? quoteRes.value     : null;
            const profile   = profileRes.status   === 'fulfilled' ? profileRes.value   : null;
            const extraData = extraQuoteRes.status === 'fulfilled' && extraQuoteRes.value
                ? (extraQuoteRes.value.quoteResponse?.result?.[0] || extraQuoteRes.value.result?.[0])
                : null;
            const news = newsRes.status === 'fulfilled' ? newsRes.value : [];

            if (!quote) throw new Error(`Could not fetch quote for ${ticker}`);

            const isGBX = isPenceCurrency(extraData?.currency);
            const factor = isGBX ? 100 : 1;

            const marketCap = profile?.marketCap || extraData?.marketCap || quote?.marketCap || 0;
            const pe = profile?.pe || extraData?.trailingPE || extraData?.forwardPE || quote?.pe || 0;
            const divYield = profile?.dividendYield || (extraData?.trailingAnnualDividendYield ? extraData.trailingAnnualDividendYield * 100 : 0) || quote?.dividendYield || 0;
            const h52 = profile?.high52 || (extraData?.fiftyTwoWeekHigh ? extraData.fiftyTwoWeekHigh / factor : 0) || quote?.high52 || 0;
            const l52 = profile?.low52 || (extraData?.fiftyTwoWeekLow ? extraData.fiftyTwoWeekLow / factor : 0) || quote?.low52 || 0;
            const beta = profile?.beta || extraData?.beta || quote?.beta || 0;

            const pillar = getPillar(quote.type || profile?.type, marketCap, quote.companyName, ticker);
            const currencySymbol = quote.currency === 'GBP' ? '£' : (quote.currency === 'EUR' ? '€' : '$');
            const change = quote.change || 0;
            const percentChange = quote.percentChange || 0;

            return {
                header: {
                    symbol: ticker,
                    name: quote.companyName || profile?.name || ticker,
                    price: quote.current || 0,
                    change: `${change >= 0 ? '+' : ''}${formatNumber(change, 2, 2)} (${formatPercent(percentChange, 2)})`,
                    pillar: pillar,
                    currencySymbol: currencySymbol,
                    isPositive: change >= 0,
                    symbol: ticker
                },
                metrics: [
                    { label: "MARKET CAP", value: formatValue(marketCap, currencySymbol) },
                    { label: "P/E RATIO", value: formatValue(pe) },
                    { label: "DIV YIELD", value: formatValue(divYield, '', '%') },
                    { label: "52W HIGH", value: formatValue(h52, currencySymbol) },
                    { label: "52W LOW", value: formatValue(l52, currencySymbol) },
                    { label: "BETA", value: formatValue(beta) }
                ],
                about: {
                    description: profile?.description
                        ? (profile.description.length > 500 ? profile.description.substring(0, 500).trim() + '...' : profile.description)
                        : "No description available for this ticker.",
                    details: {
                        sector: profile?.sector || "N/A",
                        industry: profile?.industry || "N/A",
                        exchange: mapExchange(quote.exchange || profile?.exchange),
                        ...(profile?.country ? { country: profile.country } : {}),
                        ...(profile?.employees ? { employees: profile.employees.toLocaleString(appLocale()) } : {}),
                        ...(profile?.website ? { website: profile.website } : {}),
                    }
                },
                news: news.map(item => ({
                    title: item.headline,
                    source: item.source,
                    formattedDate: formatDate(item.datetime),
                    image: item.image,
                    url: item.url
                }))
            };
        } catch (error) {
            console.error("Error generating enriched data:", error);
            throw error;
        }
    },

    async getQuotes(tickers) {
        if (!tickers || tickers.length === 0) return [];

        const results = await Promise.allSettled(tickers.map(ticker => this.getQuote(ticker)));
        return results
            .filter(r => r.status === 'fulfilled' && r.value !== null)
            .map(r => r.value);
    },

    async getQuote(ticker) {
        if (!ticker) throw new Error('Ticker is missing');

        const cacheKey = `quote-${ticker}`;
        const cached = cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
            return cached.data;
        }

        // Misma guarda que en el histórico: la liquidez y los símbolos que Yahoo
        // ya rechazó no vuelven a consumir cuota.
        if (tickerGuard.shouldSkip(ticker)) return null;

        // Prioritize v8/chart as it is currently more stable than v7/quote
        const quoteEndpoints = [
            `${BASE_URL}/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1m`,
            `${BASE_URL}/v7/finance/quote?symbols=${encodeURIComponent(ticker)}`,
            `${BASE_URL}/v6/finance/quote?symbols=${encodeURIComponent(ticker)}`
        ];

        for (const url of quoteEndpoints) {
            try {
                const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
                if (!response.ok) continue;

                const data = await response.json();
                
                // Detect Yahoo's internal "Unauthorized" error even if status is 200
                if (data.code === 'Unauthorized' || data.finance?.error?.code === 'Unauthorized') {
                    console.warn(`Yahoo Finance Unauthorized for ${url}. Trying next.`);
                    continue;
                }

                // If it's a chart endpoint (v8)
                if (url.includes('/v8/finance/chart/')) {
                    const result = data.chart?.result?.[0];
                    if (!result) continue;
                    const meta = result.meta;
                    const resultData = {
                        current: meta.regularMarketPrice || 0,
                        change: (meta.regularMarketPrice || 0) - (meta.chartPreviousClose || 0),
                        percentChange: meta.chartPreviousClose ? (((meta.regularMarketPrice || 0) - meta.chartPreviousClose) / meta.chartPreviousClose) * 100 : 0,
                        currency: isPenceCurrency(meta.currency) ? 'GBP' : (meta.currency || 'USD'),
                        companyName: meta.shortName || meta.longName || ticker,
                        marketCap: meta.marketCap || 0,
                        high52: meta.fiftyTwoWeekHigh || 0,
                        low52: meta.fiftyTwoWeekLow || 0,
                        exchange: meta.exchangeName || '',
                        marketTime: meta.regularMarketTime || null,
                        // MUTUALFUND / EQUITY / ETF…: un fondo publica su NAV con 1-2 días
                        // de retraso y la tabla enseña de qué día es (ver quotePricing).
                        type: meta.instrumentType || null,
                        symbol: ticker
                    };
                    if (isPenceCurrency(meta.currency)) {
                        resultData.current /= 100;
                        resultData.change /= 100;
                    }
                    // Don't cache a zero price — Yahoo sometimes returns 0 for pre/post-market.
                    // Let the next endpoint try, or let the caller fall back to the DB price.
                    if (!resultData.current) continue;
                    cache.set(cacheKey, { timestamp: Date.now(), data: resultData });
                    return resultData;
                }

                // If it's a quote endpoint (v6/v7)
                const quote = data.quoteResponse?.result?.[0];
                if (!quote) {
                    const altQuote = data.result?.[0] || data[0];
                    if (!altQuote) continue;
                }

                const q = quote || data.result?.[0] || data[0];
                const isGBX = isPenceCurrency(q.currency);

                const result = {
                    current: isGBX ? (q.regularMarketPrice || 0) / 100 : (q.regularMarketPrice || 0),
                    change: isGBX ? (q.regularMarketChange || 0) / 100 : (q.regularMarketChange || 0),
                    percentChange: q.regularMarketChangePercent || 0,
                    high: isGBX ? (q.regularMarketDayHigh || 0) / 100 : (q.regularMarketDayHigh || 0),
                    low: isGBX ? (q.regularMarketDayLow || 0) / 100 : (q.regularMarketDayLow || 0),
                    currency: isGBX ? 'GBP' : (q.currency || 'USD'),
                    companyName: q.longName || q.shortName || ticker,
                    marketCap: q.marketCap || 0,
                    pe: q.trailingPE || q.forwardPE || 0,
                    dividendYield: (q.trailingAnnualDividendYield || 0) * 100,
                    beta: q.beta || 0,
                    high52: isGBX ? (q.fiftyTwoWeekHigh || 0) / 100 : (q.fiftyTwoWeekHigh || 0),
                    low52: isGBX ? (q.fiftyTwoWeekLow || 0) / 100 : (q.fiftyTwoWeekLow || 0),
                    exchange: q.exchange || '',
                    type: q.quoteType,
                    symbol: q.symbol || ticker,
                    marketState: q.marketState || 'CLOSED',
                    marketTime: q.regularMarketTime || null,
                };

                // Fallback for missing metrics in some quote responses
                if (result.marketCap === 0 && q.marketCap) result.marketCap = q.marketCap;

                // Don't cache a zero price — try next endpoint
                if (!result.current) continue;
                cache.set(cacheKey, { timestamp: Date.now(), data: result });
                return result;
            } catch (e) {
                console.error(`Error fetching quote from ${url}:`, e);
            }
        }
        throw new Error('Could not fetch quote from any Yahoo endpoint');
    },

    async getProfile(ticker) {
        if (!ticker) throw new Error('Ticker is missing');
        // Yahoo estrangula quoteSummary con dureza y el crumb proxy comparte UNA
        // cookie para todos: en cuanto devuelve 429, los tickers que vienen detrás
        // reciben 429 también (se veían once seguidos). Tras el primero se deja de
        // intentar la vía v10 durante un minuto y se va DIRECTO al fallback de
        // /v1/finance/search, que no va por crumb y sí responde. No se pierde nada:
        // el sector/industria es enriquecido de fondo y se rellena en otra carga.
        const inCooldown = Date.now() < profileCooldownUntil;

        const cacheKey = `profile-${ticker}`;
        const cached = cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_DURATION * 60) {
            return cached.data;
        }

        // Try v10 quoteSummary via crumb proxy first (full profile + description)
        if (!inCooldown) {
            try {
                const response = await fetch(`/api/yahoo-profile/${encodeURIComponent(ticker)}`, {
                    signal: AbortSignal.timeout(FETCH_TIMEOUT),
                });
                if (response.ok) {
                    const data = await response.json();
                    const summary = data.quoteSummary?.result?.[0];
                    if (summary) {
                        const profile = summary.assetProfile || {};
                        const stats = summary.defaultKeyStatistics || {};
                        const financial = summary.financialData || {};
                        const detail = summary.summaryDetail || {};
                        const isGBX = isPenceCurrency(financial.financialCurrency) || isPenceCurrency(detail.currency);
                        const factor = isGBX ? 100 : 1;

                        const result = {
                            name: "",
                            description: profile.longBusinessSummary || "",
                            sector: profile.sector || "",
                            industry: profile.industry || "",
                            website: profile.website || "",
                            employees: profile.fullTimeEmployees || null,
                            country: profile.country || "",
                            city: profile.city || "",
                            marketCap: (detail.marketCap?.raw || stats.marketCap?.raw || 0) / factor,
                            pe: detail.trailingPE?.raw || stats.trailingPE?.raw || 0,
                            dividendYield: (detail.dividendYield?.raw || 0) * 100,
                            beta: detail.beta?.raw || stats.beta?.raw || 0,
                            high52: (detail.fiftyTwoWeekHigh?.raw || stats.fiftyTwoWeekHigh?.raw || 0) / factor,
                            low52: (detail.fiftyTwoWeekLow?.raw || stats.fiftyTwoWeekLow?.raw || 0) / factor,
                            currency: isGBX ? 'GBP' : (financial.financialCurrency || detail.currency || 'USD'),
                            type: detail.quoteType || ""
                        };
                        cache.set(cacheKey, { timestamp: Date.now(), data: result });
                        return result;
                    }
                }
                // Non-ok response (e.g. 429 rate limit) — do NOT cache, do NOT fall through to
                // the beta=0 fallback. Let the caller retry on the next page load.
                if (!response.ok) {
                    if (response.status === 429) profileCooldownUntil = Date.now() + PROFILE_COOLDOWN_MS;
                    throw new Error(`HTTP ${response.status}`);
                }
            } catch (e) {
                console.warn(`Yahoo v10 profile unavailable for ${ticker}, falling back to search`);
            }
        }

        // Fallback: use v1/search for sector/industry (no description, but always works)
        try {
            const res2 = await fetch(`${BASE_URL}/v1/finance/search?q=${encodeURIComponent(ticker)}&quotesCount=1&newsCount=0`, {
                signal: AbortSignal.timeout(FETCH_TIMEOUT),
            });
            if (res2.ok) {
                const d2 = await res2.json();
                const q = d2?.quotes?.[0];
                if (q) {
                    const fallback = {
                        name: q.longname || q.shortname || "",
                        description: "",
                        sector: q.sectorDisp || q.sector || "",
                        industry: q.industryDisp || q.industry || "",
                        website: "",
                        employees: null,
                        country: "",
                        city: "",
                        marketCap: 0,
                        pe: 0,
                        dividendYield: 0,
                        beta: 0,
                        high52: 0,
                        low52: 0,
                        currency: 'USD',
                        type: q.quoteType || ""
                    };
                    // Cache briefly (10 min) since this is degraded data
                    cache.set(cacheKey, { timestamp: Date.now() - (CACHE_DURATION * 50), data: fallback });
                    return fallback;
                }
            }
        } catch (e) {
            console.error(`Yahoo Finance profile fallback error for ${ticker}:`, e);
        }

        return null;
    },


    async getNews(query) {
        if (!query) return [];
        const cacheKey = `news-${query}`;
        const cached = cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_DURATION * 6) { // 30 min for news
            return cached.data;
        }
        try {
            // Usamos el endpoint de búsqueda para obtener noticias relacionadas
            const response = await fetch(`${BASE_URL}/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=0&newsCount=10`, {
                signal: AbortSignal.timeout(FETCH_TIMEOUT),
            });
            if (!response.ok) return [];
            const data = await response.json();
            const result = (data.news || []).map(item => ({
                headline: item.title,
                source: item.publisher,
                url: item.link,
                datetime: item.provider_publish_time,
                image: (item.thumbnail?.resolutions?.[0]?.url) || null
            }));
            cache.set(cacheKey, { timestamp: Date.now(), data: result });
            return result;
        } catch (e) {
            console.error(`Yahoo Finance news error for ${query}:`, e);
            return [];
        }
    },

    _getMockHistoricalData(ticker, range) {
        const data = [];
        const now = new Date();
        let days = 30;
        if (range === '1y') days = 365;
        if (range === '5y') days = 1825;
        if (range === 'max') days = 3650;

        let basePrice = 100;
        if (ticker.includes('BTC')) basePrice = 40000;
        if (ticker.includes('ETH')) basePrice = 2000;
        if (ticker === 'AAPL') basePrice = 150;
        if (ticker === 'MSFT') basePrice = 300;
        
        for (let i = days; i >= 0; i--) {
            const date = new Date(now);
            date.setDate(date.getDate() - i);
            // Random walk with slight upward bias
            basePrice = basePrice * (1 + (Math.random() * 0.04 - 0.018)); 
            data.push({
                time: date.toISOString().split('T')[0],
                close: basePrice
            });
        }
        return data;
    },

    async getHistoricalData(ticker, range = '1mo', interval = '1d') {
        if (!ticker) throw new Error('Ticker is missing');

        const isDemo = localStorage.getItem('trazza_demo_mode') === 'true';
        const cacheKey = `history-${ticker}-${range}-${interval}`;
        const cached = cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < (CACHE_DURATION * 60)) { // 60 minutes for history
            return cached.data;
        }

        // No gastar una petición en algo que NO se puede cotizar: liquidez
        // (CASH_EUR…), nombres de fondo sin resolver, descripciones de comisión
        // que acabaron de "ticker" (Interés) o un símbolo que Yahoo ya dijo que no
        // existe. Cada uno de esos 404 acercaba el 429 que sí tumba a un activo
        // real — y encima se reintentaban en cada carga.
        if (tickerGuard.shouldSkip(ticker)) {
            if (isDemo) return this._getMockHistoricalData(ticker, range);
            return [];
        }

        try {
            const response = await fetch(`${BASE_URL}/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}`, {
                signal: AbortSignal.timeout(FETCH_TIMEOUT),
            });
            if (!response.ok) {
                if (isDemo) return this._getMockHistoricalData(ticker, range);
                // Un 404 ("symbol may be delisted") es PERMANENTE: se recuerda para
                // no volver a preguntarlo. Un 429 NO se marca jamás — es transitorio
                // y el símbolo puede ser válido; confundirlos dejaría un activo real
                // sin precio durante una semana.
                if (response.status === 404) tickerGuard.markUnquotable(ticker);
                const err = new Error('Failed to fetch historical data');
                err.status = response.status;
                throw err;
            }
            const data = await response.json();
            const result = data.chart?.result?.[0];

            if (!result) {
                if (isDemo) return this._getMockHistoricalData(ticker, range);
                return [];
            }

            const chartData = this._parseChartResult(result);
            cache.set(cacheKey, { timestamp: Date.now(), data: chartData });
            return chartData;
        } catch (e) {
            // El 404 ya quedó registrado en la caché negativa: no es un incidente,
            // es un símbolo que no existe. Ensuciar la consola con él esconde los
            // fallos que sí importan (los 429).
            if (e?.status !== 404) console.error(`Yahoo Finance history error for ${ticker}:`, e);
            return [];
        }
    },

    // Shared parse of a Yahoo chart result → [{ time:'YYYY-MM-DD', close, open, high, low, volume }].
    // Uses adjusted close (adjclose) so dividends/splits keep prices comparable;
    // GBX (pence) quotes are divided by 100. Dates come from barDateFromTimestamp
    // (exchange timezone — see why there). Used by getHistoricalData AND getHistoricalRange.
    _parseChartResult(result) {
        const timestamps = result.timestamp || [];
        const quotes = result.indicators?.quote?.[0] || {};
        const adjcloses = result.indicators?.adjclose?.[0]?.adjclose || [];
        const meta = result.meta || {};
        const isGBX = isPenceCurrency(meta.currency);

        return timestamps.map((ts, i) => {
            let close = adjcloses[i] ?? quotes.close?.[i];
            let open = quotes.open?.[i];
            let high = quotes.high?.[i];
            let low = quotes.low?.[i];
            const volume = quotes.volume?.[i];
            if (isGBX) {
                if (close != null) close /= 100;
                if (open != null) open /= 100;
                if (high != null) high /= 100;
                if (low != null) low /= 100;
            }
            return {
                time: barDateFromTimestamp(ts, meta.gmtoffset),
                close, open, high, low, volume,
            };
        }).filter(item => item.close != null && item.time != null);
    },

    /**
     * Historical series for an ARBITRARY window [fromISO, toISO] (YYYY-MM-DD),
     * via Yahoo's period1/period2 — unlike getHistoricalData's named `range`,
     * this can end in the past (custom backtest window). `interval` = 1d/1wk/1mo.
     */
    async getHistoricalRange(ticker, fromISO, toISO, interval = '1d') {
        if (!ticker) throw new Error('Ticker is missing');
        const isDemo = localStorage.getItem('trazza_demo_mode') === 'true';
        const p1 = Math.floor(Date.parse(`${fromISO}T00:00:00Z`) / 1000);
        const p2 = Math.floor(Date.parse(`${toISO}T23:59:59Z`) / 1000);
        if (!Number.isFinite(p1) || !Number.isFinite(p2) || p2 <= p1) return [];

        const cacheKey = `history-${ticker}-${p1}-${p2}-${interval}`;
        const cached = cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < (CACHE_DURATION * 60)) return cached.data;

        try {
            const response = await fetch(
                `${BASE_URL}/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${p1}&period2=${p2}&interval=${interval}`,
                { signal: AbortSignal.timeout(FETCH_TIMEOUT) },
            );
            if (!response.ok) {
                if (isDemo) return this._getMockHistoricalRange(ticker, fromISO, toISO);
                throw new Error('Failed to fetch historical data');
            }
            const data = await response.json();
            const result = data.chart?.result?.[0];
            if (!result) {
                if (isDemo) return this._getMockHistoricalRange(ticker, fromISO, toISO);
                return [];
            }
            const chartData = this._parseChartResult(result);
            cache.set(cacheKey, { timestamp: Date.now(), data: chartData });
            return chartData;
        } catch (e) {
            console.error(`Yahoo Finance range history error for ${ticker}:`, e);
            if (isDemo) return this._getMockHistoricalRange(ticker, fromISO, toISO);
            return [];
        }
    },

    _getMockHistoricalRange(ticker, fromISO, toISO) {
        const start = new Date(`${fromISO}T00:00:00Z`);
        const end = new Date(`${toISO}T00:00:00Z`);
        if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return [];
        let basePrice = 100;
        if (ticker.includes('BTC')) basePrice = 40000;
        if (ticker.includes('ETH')) basePrice = 2000;
        if (ticker === 'AAPL') basePrice = 150;
        if (ticker === 'MSFT') basePrice = 300;
        const data = [];
        for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
            basePrice = basePrice * (1 + (Math.random() * 0.04 - 0.018));
            data.push({ time: d.toISOString().split('T')[0], close: basePrice });
        }
        return data;
    },

    async getDividendEvents(ticker) {
        if (!ticker) return [];
        try {
            const response = await fetch(`${BASE_URL}/v8/finance/chart/${encodeURIComponent(ticker)}?range=1y&interval=1mo&events=div`, {
                signal: AbortSignal.timeout(FETCH_TIMEOUT),
            });
            if (!response.ok) return [];
            const data = await response.json();
            const result = data.chart?.result?.[0];
            if (!result) return [];

            const meta = result.meta || {};
            const divEvents = result.events?.dividends || {};
            
            const now = Date.now() / 1000;
            const pence = isPenceCurrency(meta.currency);
            const dividends = Object.entries(divEvents).map(([exDateTs, info]) => ({
                exDividendDate: new Date(parseInt(exDateTs) * 1000).toISOString().split('T')[0],
                paymentDate: info.date ? new Date(info.date * 1000).toISOString().split('T')[0] : null,
                // Pence-quoted instruments report dividends in pence too → GBP
                amount: pence ? (info.amount || 0) / 100 : (info.amount || 0),
                currency: pence ? 'GBP' : (meta.currency || 'USD'),
                isFuture: parseInt(exDateTs) > now
            }));

            return dividends;
        } catch (e) {
            console.error(`Yahoo Finance dividend events error for ${ticker}:`, e);
            return [];
        }
    }
};
