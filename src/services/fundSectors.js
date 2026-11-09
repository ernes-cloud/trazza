/**
 * Live sector weights for fund positions (donut de Sectores look-through).
 *
 * Fetches Yahoo quoteSummary `topHoldings` through the crumb proxy
 * (`/api/yahoo-profile/:ticker?modules=topHoldings` — same dev-only endpoint
 * getProfile already uses) and reduces it with extractFundSectorWeights.
 *
 * Caching: results — INCLUDING null "this fund has no data" results (.MU
 * listings, bond funds) — are cached in localStorage for 24h so each page
 * load doesn't re-hit Yahoo per fund. Network errors are NOT cached (retry
 * next load). Fetches run sequentially with a small pause: parallel bursts
 * trip Yahoo's rate limit silently (same lesson as fundNavEnricher).
 *
 * Degrades gracefully: any failure → null → the donut keeps the fund's
 * single fundExposure bucket.
 */

import { extractFundSectorWeights } from './fundExposure';

const LS_KEY = 'wf_fund_sectors_v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const PAUSE_MS = 150;

const memoryCache = new Map();

const readStore = (storage) => {
  try {
    return JSON.parse(storage.getItem(LS_KEY)) || {};
  } catch (_) {
    return {};
  }
};

const writeStore = (storage, store) => {
  try {
    storage.setItem(LS_KEY, JSON.stringify(store));
  } catch (_) {
    // quota/private mode — memory cache still covers the session
  }
};

const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

async function fetchWeights(ticker, fetchFn) {
  const response = await fetchFn(
    `/api/yahoo-profile/${encodeURIComponent(ticker)}?modules=topHoldings`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  return extractFundSectorWeights(data?.quoteSummary?.result?.[0]?.topHoldings);
}

/**
 * @param tickers  DB tickers of fund positions (deduped by the caller or not)
 * @param deps     { fetchFn, storage, now, pauseMs } — injectable for tests
 * @returns { [ticker]: [{sector, weight}] } — only tickers WITH usable data
 */
export async function loadFundSectorWeights(tickers, deps = {}) {
  const fetchFn = deps.fetchFn || ((...args) => fetch(...args));
  const storage = deps.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  const now = deps.now || (() => Date.now());
  const pauseMs = deps.pauseMs ?? PAUSE_MS;

  const store = storage ? readStore(storage) : {};
  const result = {};
  let storeDirty = false;
  let firstFetch = true;

  for (const ticker of [...new Set(tickers)]) {
    // Unresolved fund names contain whitespace and would burn quota (same
    // guard as the quote surfaces)
    if (!ticker || /\s/.test(ticker)) continue;

    if (memoryCache.has(ticker)) {
      if (memoryCache.get(ticker)) result[ticker] = memoryCache.get(ticker);
      continue;
    }
    const cached = store[ticker];
    if (cached && now() - cached.ts < CACHE_TTL_MS) {
      memoryCache.set(ticker, cached.weights);
      if (cached.weights) result[ticker] = cached.weights;
      continue;
    }

    try {
      if (!firstFetch) await sleep(pauseMs);
      firstFetch = false;
      const weights = await fetchWeights(ticker, fetchFn);
      memoryCache.set(ticker, weights);
      store[ticker] = { ts: now(), weights };
      storeDirty = true;
      if (weights) result[ticker] = weights;
    } catch (_) {
      // network/proxy error — don't cache, keep the fund's exposure bucket
    }
  }

  if (storage && storeDirty) writeStore(storage, store);
  return result;
}

// test-only: reset module state between cases
export function __clearFundSectorMemoryCache() {
  memoryCache.clear();
}
