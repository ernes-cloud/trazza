/**
 * runPortfolioSnapshots con >1000 posiciones: PostgREST corta en 1000 sin
 * avisar; sin .range() los usuarios del final no reciben foto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rangeCalls = [];
let allRows = [];

function makeQuery() {
  const q = {
    select() { return q; },
    gt() { return q; },
    order() { return q; },
    async range(from, to) {
      rangeCalls.push([from, to]);
      return { data: allRows.slice(from, to + 1), error: null };
    },
  };
  return q;
}

const upsert = vi.fn(async () => ({ error: null }));
vi.mock('../lib/adminSupabase.js', () => ({
  supabaseAdmin: {
    from: (table) => {
      if (table === 'positions') return makeQuery();
      if (table === 'portfolio_snapshots') return { upsert };
      return {};
    },
  },
}));
vi.mock('../lib/marketQuotes.js', () => ({
  resolveTicker: (t) => t,
  getYahooQuotes: async (syms) => new Map(syms.map((s) => [s, { current: 10, currency: 'EUR' }])),
}));
vi.mock('../lib/logBuffer.js', () => ({ addLog: vi.fn() }));
vi.mock('../lib/assetPrices.js', () => ({
  planAssetPriceWrites: () => ({ writes: [], implausible: [] }),
  writeAssetPrices: async () => ({ written: 0, rejected: 0, failed: 0 }),
}));
vi.mock('../lib/heartbeat.js', () => ({
  pingHeartbeat: vi.fn(),
  isHealthySnapshotRun: () => true,
}));

const { runPortfolioSnapshots } = await import('./portfolioSnapshots.js');

function row(i) {
  return {
    id: `pos-${i}`,
    quantity: 1,
    entry_price: 10,
    assets: { id: `a-${i}`, ticker: `T${i}`, currency: 'EUR', current_price: 10, asset_class: 'Stock' },
    brokers: { user_id: `u-${Math.floor(i / 10)}` },
  };
}

describe('runPortfolioSnapshots pagination', () => {
  beforeEach(() => {
    rangeCalls.length = 0;
    upsert.mockClear();
    allRows = Array.from({ length: 1001 }, (_, i) => row(i));
  });

  it('lee más de 1000 posiciones con .range() y hace snapshot de todos los usuarios', async () => {
    const summary = await runPortfolioSnapshots();
    expect(rangeCalls.length).toBeGreaterThanOrEqual(2);
    expect(rangeCalls[0]).toEqual([0, 999]);
    expect(rangeCalls[1][0]).toBe(1000);
    // 1001 posiciones → 101 usuarios (10 por user + 1)
    expect(summary.users).toBe(101);
    expect(summary.upserted).toBe(101);
    expect(summary.error).toBeUndefined();
  });
});
