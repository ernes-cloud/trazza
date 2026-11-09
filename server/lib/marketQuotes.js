/**
 * Server-side Yahoo quote fetching, shared by the notification cron and the
 * portfolio snapshots cron (extracted from notificationCron.js — one copy of
 * the ticker map, pence handling and batch/fallback logic).
 */

import { fetchV7Quotes } from './yahooCrumb.js';

// ─── Ticker normalization (mirrors src/lib/tickerMap.js) ──────────────────────

export const TICKER_MAP = {
  GB00BVGBY890: 'ZEG.L',
  US02079K3059: 'GOOGL',
  US02079K1079: 'GOOGL',
  GOOG: 'GOOGL',
  US0231351067: 'AMZN',
  US57636Q1040: 'MA',
  US30303M1027: 'META',
  US5949181045: 'MSFT',
  CA21037X1006: 'CSU.TO',
  CSU: 'CSU.TO',
  US0378331005: 'AAPL',
  US88160R1014: 'TSLA',
  US67066G1040: 'NVDA',
  US01609W1027: 'BABA',
  IE00B4L5Y983: 'IWDA.AS',
  IE00B1YZSC51: 'VUSA.AS',
  IE00B3RBWM25: 'VWCE.AS',
  FR0000121014: 'MC.PA',
  FR0000131104: 'BNP.PA',
  FR0000120271: 'TOTAL.PA',
  FR0000120073: 'AI.PA',
  FR0000120628: 'ACA.PA',
  FR0000131757: 'CAP.PA',
  NL0011585146: 'RACE',
  IT0003132476: 'ENI.MI',
  NL0010273215: 'ASML.AS',
  GB0031348658: 'III.L',
  RMS: 'RMS.PA',
  IB1T: 'IB1T.DE',
  AMZ: 'AMZ.DE',
};

export function resolveTicker(t) {
  if (!t) return t;
  const clean = t.replace(/\s*\[.*?\]/g, '').replace(/\s*\([A-Z]{3}\)$/i, '').trim();
  return TICKER_MAP[clean.toUpperCase()] || clean;
}

// ─── Yahoo Finance (direct — no Vite proxy) ────────────────────────────────

const YAHOO_BASE = 'https://query1.finance.yahoo.com';
const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0',
  Accept: 'application/json, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

export async function yahooFetch(path, timeout = 12_000) {
  const r = await fetch(`${YAHOO_BASE}${path}`, {
    headers: YAHOO_HEADERS,
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error(`Yahoo HTTP ${r.status} for ${path}`);
  return r.json();
}

// Pence detection mirrors src/services/yahooFinance.js: only trust Yahoo's
// currency ('GBp'/'GBX'), never the '.L' suffix — LSE ETFs like SMH.L/VUAA.L
// are USD-denominated and the suffix check divided their price by 100.
export const isPenceCurrency = (currency) => currency === 'GBp' || currency === 'GBX';

// Returns Map<ticker, { current, percentChange, currency }>. Prices for
// pence-quoted tickers are already ÷100 with currency normalized to 'GBP'.
const V7_BATCH = 50;
const V8_TOPUP_MAX = 10;   // huecos que se rellenan uno a uno tras un lote que funcionó

function addV7Quotes(map, json) {
  for (const q of json?.quoteResponse?.result || []) {
    if (!q.symbol || !(q.regularMarketPrice > 0)) continue;
    const isGBX = isPenceCurrency(q.currency);
    map.set(q.symbol, {
      current: isGBX ? q.regularMarketPrice / 100 : q.regularMarketPrice,
      percentChange: q.regularMarketChangePercent || 0,
      currency: isGBX ? 'GBP' : (q.currency || null),
      regularMarketTime: q.regularMarketTime || null, // Unix seconds — para detectar datos obsoletos
    });
  }
}

export async function getYahooQuotes(tickers) {
  const map = new Map();
  if (!tickers.length) return map;

  // 1) Lote v7 CON crumb: una petición por cada 50 símbolos. Es la vía buena;
  //    sin crumb Yahoo responde 401/429 y el plan B de abajo (un v8 por
  //    ticker) se come el límite — el cron de snapshots resolvió 0 de 44
  //    cotizaciones en todas sus pasadas hasta el 2026-10-02.
  try {
    for (let i = 0; i < tickers.length; i += V7_BATCH) {
      addV7Quotes(map, await fetchV7Quotes(tickers.slice(i, i + V7_BATCH)));
    }
  } catch { /* plan B */ }

  if (map.size > 0) {
    // Algún símbolo puede faltar en el lote; si son pocos, se rellenan uno a uno.
    const missing = tickers.filter((t) => !map.has(t));
    if (missing.length && missing.length <= V8_TOPUP_MAX) await addV8Quotes(map, missing);
    return map;
  }

  // 2) Lote v7 sin crumb (por si Yahoo vuelve a aceptarlo).
  try {
    addV7Quotes(map, await yahooFetch(`/v7/finance/quote?symbols=${tickers.map(encodeURIComponent).join(',')}`));
    if (map.size > 0) return map;
  } catch { /* fall through */ }

  // 3) Uno a uno.
  await addV8Quotes(map, tickers);
  return map;
}

async function addV8Quotes(map, tickers) {
  // Individual v8 chart fallback — PACED: this path fires one request per ticker
  // and typically runs right after a v7 failure (often a 429); an unpaced burst
  // amplifies the rate limit and gets the whole run blocked (0 quotes resolved).
  let first = true;
  for (const ticker of tickers) {
    if (!first) await new Promise(r => setTimeout(r, 300));
    first = false;
    try {
      const json = await yahooFetch(
        `/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1m`
      );
      const meta = json.chart?.result?.[0]?.meta;
      if (!meta?.regularMarketPrice) continue;
      const isGBX = isPenceCurrency(meta.currency);
      const price = isGBX ? meta.regularMarketPrice / 100 : meta.regularMarketPrice;
      const prevClose = meta.chartPreviousClose || 0;
      map.set(ticker, {
        current: price,
        percentChange: prevClose ? ((meta.regularMarketPrice - prevClose) / prevClose) * 100 : 0,
        currency: isGBX ? 'GBP' : (meta.currency || null),
        regularMarketTime: meta.regularMarketTime || null,
      });
    } catch { /* ignore per-ticker failures */ }
  }
  return map;
}
