/**
 * TDD (RED): ensureCashPosition looks up liquidez by exact ticker `CASH_${cur}`
 * (see useManualEntries.js). Production DBs also hold DeGiro-style
 * `CASH_EUR (EUR)` / `CASH_USD (USD)` (what importPlanner writes via
 * getAssetIdentifiers) and bare `CASH`. Exact match misses those → second
 * cash position on every manual op.
 *
 * No production code changes in this commit — assertions below that expect
 * alias reuse MUST fail today by "inserted a second position", not by mock errors.
 */
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { attachEnsureAssetRpc } from '@/test-utils/makeCashSupabaseMock.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k) => k }),
}));
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const supabase = {
  from: vi.fn(),
  rpc: vi.fn(),
  auth: { getSession: vi.fn(async () => ({ data: { session: null } })) },
};

vi.mock('@/lib/customSupabaseClient', () => ({ supabase }));

const { useManualEntries } = await import('./useManualEntries.js');

const BROKER = 'broker-1';
const PORTFOLIO = 'pf-1';
const USER = { id: 'user-1' };

/**
 * In-memory supabase-js-ish chain for the ensureCashPosition query path:
 *   positions.select(...).eq('broker_id').eq('assets.ticker').limit().maybeSingle()
 *   assets.select(...).eq('ticker').limit(1)
 *   assets|positions.insert(...).select().single()
 *   portfolios.select(...).eq(...).limit().maybeSingle()
 */
function makeDb(seed = {}) {
  const state = {
    assets: [...(seed.assets || [])],
    positions: [...(seed.positions || [])],
    portfolios: seed.portfolios || [{ id: PORTFOLIO, user_id: USER.id }],
  };
  let seq = 0;
  const nextId = (p) => `${p}-${++seq}`;
  const inserts = { assets: [], positions: [] };

  const filterRows = (table, filters) => {
    let rows = state[table] || [];
    for (const [col, val] of filters) {
      if (col === 'assets.ticker') {
        rows = rows.filter((r) => {
          const asset = state.assets.find((a) => a.id === r.asset_id);
          return asset?.ticker === val;
        });
      } else {
        rows = rows.filter((r) => r[col] === val);
      }
    }
    return rows;
  };

  const chain = (table, filters = []) => {
    const api = {
      select() { return api; },
      eq(col, val) { return chain(table, [...filters, [col, val]]); },
      ilike: vi.fn(() => Promise.resolve({ data: [], error: null })),
      limit() { return api; },
      async maybeSingle() {
        const rows = filterRows(table, filters);
        return { data: rows[0] || null, error: null };
      },
      async single() {
        const rows = filterRows(table, filters);
        return { data: rows[0] || null, error: null };
      },
      then(resolve) {
        // await supabase.from('assets').select(...).eq(...).limit(1)
        const rows = filterRows(table, filters);
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
      insert(row) {
        const created = { id: nextId(table.slice(0, 2)), ...row };
        state[table].push(created);
        inserts[table]?.push(created);
        return {
          select() {
            return {
              async single() { return { data: created, error: null }; },
              then(resolve) {
                return Promise.resolve({ data: [created], error: null }).then(resolve);
              },
            };
          },
          then(resolve) {
            return Promise.resolve({ data: [created], error: null }).then(resolve);
          },
        };
      },
    };
    return api;
  };

  supabase.from.mockImplementation((table) => chain(table));
  attachEnsureAssetRpc(supabase.rpc, { state, inserts, nextId });
  return { state, inserts };
}

function mountEnsureCash(positions = []) {
  let api;
  function Probe() {
    api = useManualEntries({
      user: USER,
      selectedBrokerId: BROKER,
      preferredCurrency: 'EUR',
      positions,
      loadPositions: vi.fn(),
      refreshLoadedTransactions: vi.fn(),
    });
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return api.ensureCashPosition;
}

describe('ensureCashPosition — aliases de liquidez (TDD RED)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("(a) con 'CASH_EUR (EUR)' existente, operacion manual EUR reutiliza esa posicion y no inserta otra", async () => {
    const asset = {
      id: 'asset-degiro-eur',
      ticker: 'CASH_EUR (EUR)',
      asset_class: 'Cash',
      currency: 'EUR',
      current_price: 1,
    };
    const pos = {
      id: 'pos-degiro-eur',
      broker_id: BROKER,
      portfolio_id: PORTFOLIO,
      asset_id: asset.id,
      quantity: 500,
    };
    const { inserts } = makeDb({ assets: [asset], positions: [pos] });
    const ensureCashPosition = mountEnsureCash([
      { id: pos.id, portfolio_id: PORTFOLIO, broker_id: BROKER, assets: asset },
    ]);

    const id = await ensureCashPosition(BROKER, 'EUR');

    // Primary RED signal: second cash position inserted (exact ticker miss).
    expect(inserts.positions).toHaveLength(0);
    expect(inserts.assets).toHaveLength(0);
    expect(id).toBe('pos-degiro-eur');
  });

  it("(c) con 'CASH_USD (USD)' existente, operacion manual USD reutiliza esa posicion y no inserta otra", async () => {
    const asset = {
      id: 'asset-degiro-usd',
      ticker: 'CASH_USD (USD)',
      asset_class: 'Cash',
      currency: 'USD',
      current_price: 1,
    };
    const pos = {
      id: 'pos-degiro-usd',
      broker_id: BROKER,
      portfolio_id: PORTFOLIO,
      asset_id: asset.id,
      quantity: 200,
    };
    const { inserts } = makeDb({ assets: [asset], positions: [pos] });
    const ensureCashPosition = mountEnsureCash([
      { id: pos.id, portfolio_id: PORTFOLIO, broker_id: BROKER, assets: asset },
    ]);

    const id = await ensureCashPosition(BROKER, 'USD');

    expect(inserts.positions).toHaveLength(0);
    expect(id).toBe('pos-degiro-usd');
  });

  // Bare ticker 'CASH' (no currency suffix): ensureCashPosition only receives a
  // currency argument and matches `CASH_${cur}` — there is no portfolio-currency
  // deduction path to map bare 'CASH' → EUR/USD. Omit until that contract exists.
});

describe('ensureCashPosition — regresion ticker estandar (debe PASAR hoy)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("(d) con ticker estandar CASH_EUR existente no duplica", async () => {
    const asset = {
      id: 'asset-std-eur',
      ticker: 'CASH_EUR',
      asset_class: 'Cash',
      currency: 'EUR',
      current_price: 1,
    };
    const pos = {
      id: 'pos-std-eur',
      broker_id: BROKER,
      portfolio_id: PORTFOLIO,
      asset_id: asset.id,
      quantity: 100,
    };
    const { inserts } = makeDb({ assets: [asset], positions: [pos] });
    const ensureCashPosition = mountEnsureCash([
      { id: pos.id, portfolio_id: PORTFOLIO, broker_id: BROKER, assets: asset },
    ]);

    const id = await ensureCashPosition(BROKER, 'EUR');

    expect(id).toBe('pos-std-eur');
    expect(inserts.positions).toHaveLength(0);
  });

  it('(d) sin ninguna posicion de liquidez crea exactamente una', async () => {
    const { state, inserts } = makeDb({ assets: [], positions: [] });
    const ensureCashPosition = mountEnsureCash([
      { id: 'pos-stock', portfolio_id: PORTFOLIO, broker_id: BROKER, assets: { ticker: 'AAPL' } },
    ]);

    const id = await ensureCashPosition(BROKER, 'EUR');

    expect(inserts.positions).toHaveLength(1);
    expect(inserts.assets).toHaveLength(1);
    expect(inserts.assets[0].ticker).toBe('CASH_EUR');
    expect(id).toBe(inserts.positions[0].id);
    expect(state.positions.filter((p) => {
      const a = state.assets.find((x) => x.id === p.asset_id);
      return a && String(a.ticker).toUpperCase().startsWith('CASH');
    })).toHaveLength(1);
  });
});
