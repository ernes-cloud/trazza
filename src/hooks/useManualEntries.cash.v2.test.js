/**
 * I2/I3/I4 — ensureCashPosition caminos de BD (estado vacío), vista combinada,
 * handleSaveManualCash via ensureCashPosition, y mutantes del Reviewer.
 */
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const BROKER_A = 'broker-a';
const BROKER_B = 'broker-b';
const PORTFOLIO = 'pf-1';
const USER = { id: 'user-1' };

function makeDb(seed = {}, opts = {}) {
  const state = {
    assets: [...(seed.assets || [])],
    positions: [...(seed.positions || [])],
    transactions: [...(seed.transactions || [])],
    portfolios: seed.portfolios || [{ id: PORTFOLIO, user_id: USER.id }],
  };
  let seq = 0;
  const nextId = (p) => `${p}-${++seq}`;
  const inserts = { assets: [], positions: [], transactions: [] };
  const noIlike = opts.noIlike === true;
  const failBrokerPositions = opts.failBrokerPositions === true;
  const failExistingByAsset = opts.failExistingByAsset === true;
  const failInsertPosition = opts.failInsertPosition === true;

  const hydrate = (rows) => rows.map((r) => {
    if (r.assets) return r;
    const asset = state.assets.find((a) => a.id === r.asset_id);
    return asset ? { ...r, assets: asset } : r;
  });

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
    return table === 'positions' ? hydrate(rows) : rows;
  };

  const chain = (table, filters = []) => {
    const api = {
      select() { return api; },
      eq(col, val) { return chain(table, [...filters, [col, val]]); },
      ilike(col, pattern) {
        if (noIlike) throw new Error('no-ilike');
        const re = new RegExp(`^${String(pattern).replace(/%/g, '.*')}$`, 'i');
        return chain(table, [...filters, [col, { __ilike: re }]]);
      },
      limit() { return api; },
      async maybeSingle() {
        if (table === 'positions' && failExistingByAsset) {
          const hasBroker = filters.some(([c]) => c === 'broker_id');
          const hasAsset = filters.some(([c]) => c === 'asset_id');
          if (hasBroker && hasAsset) return { data: null, error: { message: 'positions lookup failed' } };
        }
        let rows = state[table] || [];
        for (const [col, val] of filters) {
          if (val && typeof val === 'object' && val.__ilike) {
            rows = rows.filter((r) => val.__ilike.test(String(r[col] ?? '')));
          } else if (col === 'assets.ticker') {
            rows = rows.filter((r) => state.assets.find((a) => a.id === r.asset_id)?.ticker === val);
          } else {
            rows = rows.filter((r) => r[col] === val);
          }
        }
        rows = table === 'positions' ? hydrate(rows) : rows;
        return { data: rows[0] || null, error: null };
      },
      async single() {
        const { data } = await api.maybeSingle();
        return { data, error: null };
      },
      then(resolve) {
        if (table === 'positions' && failBrokerPositions) {
          const hasBroker = filters.some(([c]) => c === 'broker_id');
          const hasAsset = filters.some(([c]) => c === 'asset_id');
          if (hasBroker && !hasAsset) {
            return Promise.resolve({ data: null, error: { message: 'broker positions failed' } }).then(resolve);
          }
        }
        let rows = state[table] || [];
        for (const [col, val] of filters) {
          if (val && typeof val === 'object' && val.__ilike) {
            rows = rows.filter((r) => val.__ilike.test(String(r[col] ?? '')));
          } else if (col === 'assets.ticker') {
            rows = rows.filter((r) => state.assets.find((a) => a.id === r.asset_id)?.ticker === val);
          } else {
            rows = rows.filter((r) => r[col] === val);
          }
        }
        rows = table === 'positions' ? hydrate(rows) : rows;
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
      insert(row) {
        if (table === 'positions' && failInsertPosition) {
          return {
            select() {
              return {
                async single() { return { data: null, error: { message: 'insert position failed' } }; },
                then(resolve) {
                  return Promise.resolve({ data: null, error: { message: 'insert position failed' } }).then(resolve);
                },
              };
            },
            then(resolve) {
              return Promise.resolve({ data: null, error: { message: 'insert position failed' } }).then(resolve);
            },
          };
        }
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
  supabase.rpc.mockImplementation(async (fn, args) => {
    if (fn === 'ensure_asset') {
      const ticker = String(args.p_ticker || '').trim();
      let asset = state.assets.find((a) => a.ticker === ticker);
      if (!asset) {
        asset = {
          id: nextId('as'),
          ticker,
          company_name: args.p_company_name,
          asset_class: args.p_asset_class,
          currency: args.p_currency,
          current_price: ticker.startsWith('CASH_') ? 1 : null,
        };
        state.assets.push(asset);
        inserts.assets.push(asset);
      }
      return { data: asset.id, error: null };
    }
    if (fn === 'adjust_position_quantity') {
      const pos = state.positions.find((p) => p.id === args.p_position_id);
      if (pos) pos.quantity = (parseFloat(pos.quantity) || 0) + (args.p_delta || 0);
      return { data: pos?.quantity ?? 0, error: null };
    }
    return { data: null, error: null };
  });
  return { state, inserts };
}

function mountHook(positions = []) {
  let api;
  function Probe() {
    api = useManualEntries({
      user: USER,
      selectedBrokerId: BROKER_B,
      preferredCurrency: 'EUR',
      positions,
      loadPositions: vi.fn(),
      refreshLoadedTransactions: vi.fn(),
    });
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return api;
}

describe('I2 — ticker legado con espacios y vista combinada', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("estado vacío + asset ' cash_chf ' → reutiliza por 1b (sin ilike; mata hook-db-solo-canonico)", async () => {
    const asset = {
      id: 'asset-chf-legacy',
      ticker: ' cash_chf ',
      asset_class: 'Cash',
      currency: 'CHF',
      current_price: 1,
    };
    const pos = {
      id: 'pos-chf-b',
      broker_id: BROKER_B,
      portfolio_id: PORTFOLIO,
      asset_id: asset.id,
      quantity: 50,
    };
    // noIlike: step-3 class scan cannot recover; only findCashPosition in 1b works.
    const { inserts } = makeDb({ assets: [asset], positions: [pos] }, { noIlike: true });
    const api = mountHook([]);
    const id = await api.ensureCashPosition(BROKER_B, 'CHF');
    expect(id).toBe('pos-chf-b');
    expect(inserts.positions).toHaveLength(0);
  });

  it('vista combinada: borrar venta en B no crea segunda posición CHF en B', async () => {
    const asset = {
      id: 'asset-chf',
      ticker: ' cash_chf ',
      asset_class: 'Cash',
      currency: 'CHF',
      current_price: 1,
    };
    const posB = {
      id: 'pos-chf-b',
      broker_id: BROKER_B,
      portfolio_id: PORTFOLIO,
      asset_id: asset.id,
      quantity: 10,
    };
    // Combined-view state wrongly carries broker A on the cash group.
    const staleGeneralView = [{
      id: 'pos-chf-a',
      broker_id: BROKER_A,
      portfolio_id: PORTFOLIO,
      assets: asset,
    }];
    const { inserts, state } = makeDb({
      assets: [asset],
      positions: [
        { id: 'pos-chf-a', broker_id: BROKER_A, portfolio_id: PORTFOLIO, asset_id: asset.id, quantity: 10 },
        posB,
      ],
    });
    const api = mountHook(staleGeneralView);
    const id = await api.ensureCashPosition(BROKER_B, 'CHF');
    expect(id).toBe('pos-chf-b');
    expect(inserts.positions).toHaveLength(0);
    expect(state.positions.filter((p) => p.broker_id === BROKER_B && p.asset_id === asset.id)).toHaveLength(1);
  });
});

describe('I3 — ensureCashPosition en flujo de cash manual', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('con CASH_EUR (EUR) existente no crea segunda posición', async () => {
    const asset = {
      id: 'asset-degiro-eur',
      ticker: 'CASH_EUR (EUR)',
      asset_class: 'Cash',
      currency: 'EUR',
      current_price: 1,
    };
    const pos = {
      id: 'pos-degiro-eur',
      broker_id: BROKER_B,
      portfolio_id: PORTFOLIO,
      asset_id: asset.id,
      quantity: 500,
    };
    const { inserts } = makeDb({ assets: [asset], positions: [pos], transactions: [] });
    const api = mountHook([
      { id: pos.id, portfolio_id: PORTFOLIO, broker_id: BROKER_B, assets: asset },
    ]);
    const cashPosId = await api.ensureCashPosition(BROKER_B, 'EUR');
    expect(inserts.positions).toHaveLength(0);
    expect(inserts.assets).toHaveLength(0);
    expect(cashPosId).toBe('pos-degiro-eur');
  });
});

describe('I4 — ramas BD con estado vacío (matan mutantes)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('pos-sin-broker: no abona liquidez del broker A al pedir broker B', async () => {
    const asset = {
      id: 'a-eur', ticker: 'CASH_EUR', asset_class: 'Cash', currency: 'EUR', current_price: 1,
    };
    const posA = {
      id: 'pos-a', broker_id: BROKER_A, portfolio_id: PORTFOLIO, asset_id: asset.id, quantity: 1,
    };
    const { inserts, state } = makeDb({ assets: [asset], positions: [posA] });
    const api = mountHook([]);
    const id = await api.ensureCashPosition(BROKER_B, 'EUR');
    expect(id).not.toBe('pos-a');
    expect(state.positions.some((p) => p.broker_id === BROKER_B)).toBe(true);
    expect(inserts.positions).toHaveLength(1);
    expect(inserts.positions[0].broker_id).toBe(BROKER_B);
  });

  it('hook-sin-estado: solo estado (BD vacía) reutiliza la posición cargada', async () => {
    const asset = {
      id: 'a-st', ticker: 'CASH_EUR (EUR)', asset_class: 'Cash', currency: 'EUR', current_price: 1,
    };
    const { inserts } = makeDb({ assets: [], positions: [] });
    const api = mountHook([
      { id: 'pos-state-only', portfolio_id: PORTFOLIO, broker_id: BROKER_B, assets: asset },
    ]);
    expect(await api.ensureCashPosition(BROKER_B, 'EUR')).toBe('pos-state-only');
    expect(inserts.positions).toHaveLength(0);
    expect(inserts.assets).toHaveLength(0);
  });

  it('hook-db-solo-canonico / trim-upper: alias DeGiro desde BD sin estado', async () => {
    const asset = {
      id: 'a-deg', ticker: 'CASH_EUR (EUR)', asset_class: 'Cash', currency: 'EUR', current_price: 1,
    };
    const pos = {
      id: 'pos-deg', broker_id: BROKER_B, portfolio_id: PORTFOLIO, asset_id: asset.id, quantity: 1,
    };
    const { inserts } = makeDb({ assets: [asset], positions: [pos] });
    const api = mountHook([]);
    expect(await api.ensureCashPosition(BROKER_B, 'EUR')).toBe('pos-deg');
    expect(inserts.positions).toHaveLength(0);
  });

  it('hook-asset-solo-canonico: reutiliza asset CASH_EUR (EUR) sin crear CASH_EUR', async () => {
    const asset = {
      id: 'a-deg-only', ticker: 'CASH_EUR (EUR)', asset_class: 'Cash', currency: 'EUR', current_price: 1,
    };
    // No position yet — must reuse the decorated asset, not create CASH_EUR.
    const { inserts } = makeDb({ assets: [asset], positions: [] });
    const api = mountHook([
      { id: 'pos-stock', portfolio_id: PORTFOLIO, broker_id: BROKER_B, assets: { ticker: 'AAPL' } },
    ]);
    await api.ensureCashPosition(BROKER_B, 'EUR');
    expect(inserts.assets).toHaveLength(0);
    expect(inserts.positions).toHaveLength(1);
    expect(inserts.positions[0].asset_id).toBe('a-deg-only');
  });

  it('asset-scan: CASH_NET_EUR no es liquidez (R2) — crea CASH_EUR canónico', async () => {
    const asset = {
      id: 'a-net', ticker: 'CASH_NET_EUR', asset_class: 'Cash', currency: 'EUR', current_price: 1,
    };
    const pos = {
      id: 'pos-net', broker_id: BROKER_B, portfolio_id: PORTFOLIO, asset_id: asset.id, quantity: 1,
    };
    const { inserts } = makeDb({ assets: [asset], positions: [pos] });
    const api = mountHook([]);
    const id = await api.ensureCashPosition(BROKER_B, 'EUR');
    expect(id).not.toBe('pos-net');
    expect(inserts.assets.some((a) => a.ticker === 'CASH_EUR')).toBe(true);
    expect(inserts.positions).toHaveLength(1);
  });

  it('propaga error del barrido por clase cuando ilike no está disponible', async () => {
    makeDb({ assets: [], positions: [] }, { noIlike: true });
    const api = mountHook([]);
    await expect(api.ensureCashPosition(BROKER_B, 'EUR')).rejects.toMatchObject({
      message: 'no-ilike',
    });
  });

  it('pos-sin-isCash: activo Stock con currency EUR no se usa como liquidez', async () => {
    const stock = {
      id: 'a-stock', ticker: 'AAPL', asset_class: 'Stock', currency: 'EUR', current_price: 10,
    };
    const pos = {
      id: 'pos-stock', broker_id: BROKER_B, portfolio_id: PORTFOLIO, asset_id: stock.id, quantity: 1,
    };
    const { inserts } = makeDb({ assets: [stock], positions: [pos] });
    const api = mountHook([]);
    const id = await api.ensureCashPosition(BROKER_B, 'EUR');
    expect(id).not.toBe('pos-stock');
    expect(inserts.positions).toHaveLength(1);
  });

  it('sin liquidez: ensure_asset (rpc) crea CASH_EUR y una posición — sin from(assets).insert', async () => {
    const { state, inserts } = makeDb({ assets: [], positions: [] });
    const api = mountHook([
      { id: 'pos-stock', portfolio_id: PORTFOLIO, broker_id: BROKER_B, assets: { ticker: 'AAPL' } },
    ]);
    const id = await api.ensureCashPosition(BROKER_B, 'EUR');
    expect(inserts.positions).toHaveLength(1);
    expect(inserts.assets).toHaveLength(1);
    expect(inserts.assets[0].ticker).toBe('CASH_EUR');
    expect(id).toBe(inserts.positions[0].id);
    expect(state.positions.filter((p) => {
      const a = state.assets.find((x) => x.id === p.asset_id);
      return a && String(a.ticker).toUpperCase().startsWith('CASH');
    })).toHaveLength(1);
  });

  it('propaga error al leer posiciones del broker (no swallow en 1b)', async () => {
    makeDb({ assets: [], positions: [] }, { failBrokerPositions: true });
    const api = mountHook([]);
    await expect(api.ensureCashPosition(BROKER_B, 'EUR')).rejects.toMatchObject({
      message: 'broker positions failed',
    });
  });

  it('propaga error al comprobar posición broker+asset (no swallow en 4)', async () => {
    const asset = {
      id: 'a-deg-only', ticker: 'CASH_EUR (EUR)', asset_class: 'Cash', currency: 'EUR', current_price: 1,
    };
    makeDb({ assets: [asset], positions: [] }, { failExistingByAsset: true });
    const api = mountHook([
      { id: 'pos-stock', portfolio_id: PORTFOLIO, broker_id: BROKER_B, assets: { ticker: 'AAPL' } },
    ]);
    await expect(api.ensureCashPosition(BROKER_B, 'EUR')).rejects.toMatchObject({
      message: 'positions lookup failed',
    });
  });

  it('propaga error al insertar la posición de cash (insert verifica error)', async () => {
    const asset = {
      id: 'a-cash', ticker: 'CASH_EUR', asset_class: 'Cash', currency: 'EUR', current_price: 1,
    };
    makeDb({ assets: [asset], positions: [] }, { failInsertPosition: true });
    const api = mountHook([
      { id: 'pos-stock', portfolio_id: PORTFOLIO, broker_id: BROKER_B, assets: { ticker: 'AAPL' } },
    ]);
    await expect(api.ensureCashPosition(BROKER_B, 'EUR')).rejects.toMatchObject({
      message: 'insert position failed',
    });
  });
});
