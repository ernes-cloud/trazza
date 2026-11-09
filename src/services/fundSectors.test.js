import { describe, it, expect, beforeEach } from 'vitest';
import { extractFundSectorWeights } from './fundExposure';
import { loadFundSectorWeights, __clearFundSectorMemoryCache } from './fundSectors';

// Real Yahoo topHoldings payloads (captured live 2026-07-10)
const US_INDEX_HOLDINGS = {
  stockPosition: { raw: 0.999 },
  bondPosition: { raw: 0.0 },
  sectorWeightings: [
    { realestate: { raw: 0.0234 } },
    { consumer_cyclical: { raw: 0.0989 } },
    { basic_materials: { raw: 0.0163 } },
    { consumer_defensive: { raw: 0.045 } },
    { technology: { raw: 0.3905 } },
    { communication_services: { raw: 0.1064 } },
    { financial_services: { raw: 0.1107 } },
    { utilities: { raw: 0.0243 } },
    { industrials: { raw: 0.0782 } },
    { energy: { raw: 0.0313 } },
    { healthcare: { raw: 0.083 } },
  ],
};

// Bond funds report a junk "financial_services 100%" sector row
const CORP_BOND_HOLDINGS = {
  stockPosition: { raw: 0.0 },
  bondPosition: { raw: 0.9929 },
  sectorWeightings: [{ financial_services: { raw: 1.0 } }],
};

const GESTION_VALUE_HOLDINGS = {
  stockPosition: { raw: 0.71949995 },
  bondPosition: { raw: 0.0119 },
  sectorWeightings: [
    { realestate: { raw: 0.0141 } },
    { consumer_cyclical: { raw: 0.1972 } },
    { basic_materials: { raw: 0.1711 } },
    { consumer_defensive: { raw: 0.039 } },
    { technology: { raw: 0.0483 } },
    { communication_services: { raw: 0.0398 } },
    { financial_services: { raw: 0.1503 } },
    { utilities: { raw: 0.0068 } },
    { industrials: { raw: 0.1859 } },
    { energy: { raw: 0.0984 } },
    { healthcare: { raw: 0.0491 } },
  ],
};

describe('extractFundSectorWeights', () => {
  it('maps an equity index fund to normalized assetProfile-style sector labels', () => {
    const weights = extractFundSectorWeights(US_INDEX_HOLDINGS);
    expect(weights[0]).toEqual({ sector: 'Technology', weight: expect.closeTo(0.3905, 2) });
    const total = weights.reduce((s, w) => s + w.weight, 0);
    expect(total).toBeCloseTo(1, 6);
    // Labels must merge with individual stocks' assets.sector values
    expect(weights.map((w) => w.sector)).toContain('Consumer Cyclical');
    expect(weights.map((w) => w.sector)).toContain('Real Estate');
  });

  it('rejects bond funds — their sector row is junk, the FUND_BOND bucket must win', () => {
    expect(extractFundSectorWeights(CORP_BOND_HOLDINGS)).toBeNull();
  });

  it('accepts an active fund with a 72% equity sleeve (Gestión Value)', () => {
    const weights = extractFundSectorWeights(GESTION_VALUE_HOLDINGS);
    expect(weights[0].sector).toBe('Consumer Cyclical');
    expect(weights.reduce((s, w) => s + w.weight, 0)).toBeCloseTo(1, 6);
  });

  it('returns null on missing/empty data (.MU listings)', () => {
    expect(extractFundSectorWeights(undefined)).toBeNull();
    expect(extractFundSectorWeights({})).toBeNull();
    expect(extractFundSectorWeights({ stockPosition: { raw: 0.99 }, sectorWeightings: [] })).toBeNull();
  });
});

const yahooResponse = (topHoldings) => ({
  ok: true,
  json: async () => ({ quoteSummary: { result: [{ topHoldings }] } }),
});

const makeStorage = () => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    _map: map,
  };
};

describe('loadFundSectorWeights', () => {
  beforeEach(() => __clearFundSectorMemoryCache());

  it('fetches, reduces and caches per ticker; null results are cached too', async () => {
    const calls = [];
    const fetchFn = async (url) => {
      calls.push(url);
      if (url.includes('0P0001XF42.F')) return yahooResponse(US_INDEX_HOLDINGS);
      return yahooResponse(undefined); // FEPA.MU — no data
    };
    const storage = makeStorage();
    const deps = { fetchFn, storage, pauseMs: 0 };

    const result = await loadFundSectorWeights(['0P0001XF42.F', 'FEPA.MU'], deps);
    expect(result['0P0001XF42.F'][0].sector).toBe('Technology');
    expect(result['FEPA.MU']).toBeUndefined();
    expect(calls).toHaveLength(2);

    // Second load: served from cache, no new fetches (also for the null result)
    __clearFundSectorMemoryCache();
    const again = await loadFundSectorWeights(['0P0001XF42.F', 'FEPA.MU'], deps);
    expect(again['0P0001XF42.F'][0].sector).toBe('Technology');
    expect(calls).toHaveLength(2);
  });

  it('does not cache network errors and never throws', async () => {
    const storage = makeStorage();
    const failing = { fetchFn: async () => ({ ok: false, status: 503 }), storage, pauseMs: 0 };
    expect(await loadFundSectorWeights(['0P0001XF42.F'], failing)).toEqual({});

    const working = { fetchFn: async () => yahooResponse(US_INDEX_HOLDINGS), storage, pauseMs: 0 };
    const result = await loadFundSectorWeights(['0P0001XF42.F'], working);
    expect(result['0P0001XF42.F']).toBeTruthy();
  });

  it('skips unresolved fund names (tickers with whitespace)', async () => {
    let called = 0;
    const deps = { fetchFn: async () => { called++; return yahooResponse(US_INDEX_HOLDINGS); }, storage: makeStorage(), pauseMs: 0 };
    const result = await loadFundSectorWeights(['FIDELITY MSCI EUROPE INDEX P A', ''], deps);
    expect(result).toEqual({});
    expect(called).toBe(0);
  });

  it('expired cache entries are refetched', async () => {
    const storage = makeStorage();
    let t = 1_000_000;
    let called = 0;
    const deps = {
      fetchFn: async () => { called++; return yahooResponse(US_INDEX_HOLDINGS); },
      storage, pauseMs: 0, now: () => t,
    };
    await loadFundSectorWeights(['0P0001XF42.F'], deps);
    expect(called).toBe(1);

    __clearFundSectorMemoryCache();
    t += 25 * 60 * 60 * 1000; // > 24h
    await loadFundSectorWeights(['0P0001XF42.F'], deps);
    expect(called).toBe(2);
  });
});
