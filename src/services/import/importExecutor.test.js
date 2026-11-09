import { describe, it, expect } from 'vitest';
import { applyImportPlan } from './importExecutor';
import { computeImportPlan } from './importPlanner';
import { calculateNetBuys } from './netHoldings';

// ─── Fake supabase client: in-memory tables, chainable like supabase-js ──────

function makeFakeSupabase() {
  const state = { assets: [], positions: [], transactions: [], rpcCalls: [] };
  let idSeq = 0;
  const nextId = (prefix) => `${prefix}-${++idSeq}`;

  const createAssetsFn = async (rows) => {
    const created = (rows || []).map(r => ({ id: nextId('as'), ...r }));
    state.assets.push(...created);
    return created;
  };

  return {
    state,
    createAssetsFn,
    from(table) {
      return {
        insert(rows) {
          const list = Array.isArray(rows) ? rows : [rows];
          const created = list.map(r => ({ id: nextId(table.slice(0, 2)), ...r }));
          state[table].push(...created);
          return {
            select: async () => ({ data: created, error: null }),
            then: (resolve) => Promise.resolve({ data: created, error: null }).then(resolve),
          };
        },
        update(patch) {
          return {
            eq: async (col, val) => {
              state[table].forEach(r => { if (r[col] === val) Object.assign(r, patch); });
              return { error: null };
            },
            in: async (col, vals) => {
              state[table].forEach(r => { if (vals.includes(r[col])) Object.assign(r, patch); });
              return { error: null };
            },
          };
        },
      };
    },
    async rpc(name, args) {
      state.rpcCalls.push({ name, args, positionsAtCall: state.positions.length });
      return { error: null };
    },
  };
}

// ─── Fixture (same shape the planner tests use) ──────────────────────────────

const DATA = [
  {
    type: 'BUY', fecha: '02-01-2026', hora: '10:00', cantidad: 2, precio: 100,
    isin: 'US0378331005', id_activo: 'US0378331005', producto: 'AAPL', nombre: 'Apple Inc',
    moneda: 'USD', total: -200, comisiones: 2,
    descripcion: 'Compra 2 Apple Inc@100 USD (US0378331005)',
  },
  { type: 'TRANSFER', fecha: '01-01-2026', hora: '09:00', cantidad: 0, precio: 0, moneda: 'EUR', total: 1000, descripcion: 'Ingreso' },
];

describe('applyImportPlan — ejecución del plan contra un cliente fake', () => {
  it('crea assets y posiciones en bloque, resuelve refs e inserta el historial', async () => {
    const netBuys = calculateNetBuys(DATA, 'degiro');
    const plan = computeImportPlan({
      dataSource: DATA, netBuys, broker: 'degiro',
      existingPositions: [], existingAssetsByTicker: {},
    });

    const supabase = makeFakeSupabase();
    const result = await applyImportPlan({
      plan,
      dataSource: DATA,
      broker: 'degiro',
      brokerId: 'broker-1',
      portfolioId: 'pf-1',
      existingTransMap: new Map(),
      supabase,
      createAssetsFn: supabase.createAssetsFn,
    });

    // Assets + positions created (stock + CASH_USD + CASH_EUR)
    expect(supabase.state.assets).toHaveLength(3);
    expect(supabase.state.positions).toHaveLength(3);
    // Every position got portfolio/broker and a REAL asset id from the created assets
    const assetIds = new Set(supabase.state.assets.map(a => a.id));
    for (const p of supabase.state.positions) {
      expect(p.portfolio_id).toBe('pf-1');
      expect(p.broker_id).toBe('broker-1');
      expect(assetIds.has(p.asset_id)).toBe(true);
    }

    // History: BUY linked to the stock position, TRANSFER to the EUR cash position
    expect(result.insertedCount).toBe(2);
    const stockAsset = supabase.state.assets.find(a => a.ticker === 'US0378331005 (USD)');
    const stockPos = supabase.state.positions.find(p => p.asset_id === stockAsset.id);
    const buyTx = supabase.state.transactions.find(tx => tx.transaction_type === 'BUY');
    expect(buyTx.position_id).toBe(stockPos.id);
  });

  it('re-aplicar con el estado ya existente no inserta nada (idempotencia extremo a extremo)', async () => {
    const netBuys = calculateNetBuys(DATA, 'degiro');
    const supabase = makeFakeSupabase();

    // 1st run
    const plan1 = computeImportPlan({
      dataSource: DATA, netBuys, broker: 'degiro',
      existingPositions: [], existingAssetsByTicker: {},
    });
    await applyImportPlan({
      plan: plan1, dataSource: DATA, broker: 'degiro',
      brokerId: 'broker-1', portfolioId: 'pf-1', existingTransMap: new Map(), supabase,
      createAssetsFn: supabase.createAssetsFn,
    });
    const txAfterFirst = supabase.state.transactions.length;

    // 2nd run: plan against the state the first run left behind
    const assetsByTicker = Object.fromEntries(supabase.state.assets.map(a => [a.ticker, a]));
    const existingPositions = supabase.state.positions.map(p => ({ id: p.id, asset_id: p.asset_id }));
    const { transCheckKey } = await import('../../lib/importDedupe');
    const existingTransMap = new Map(supabase.state.transactions.map(t => [
      transCheckKey(t),
      { id: t.id, eur_total: t.eur_total, notes: t.notes, commission: t.commission, transaction_currency: t.transaction_currency },
    ]));

    const plan2 = computeImportPlan({
      dataSource: DATA, netBuys, broker: 'degiro',
      existingPositions, existingAssetsByTicker: assetsByTicker,
    });
    const result2 = await applyImportPlan({
      plan: plan2, dataSource: DATA, broker: 'degiro',
      brokerId: 'broker-1', portfolioId: 'pf-1', existingTransMap, supabase,
      createAssetsFn: supabase.createAssetsFn,
    });

    expect(result2.insertedCount).toBe(0);
    expect(result2.patchedCount).toBe(0);
    expect(supabase.state.transactions).toHaveLength(txAfterFirst); // ni una fila más
    expect(supabase.state.assets).toHaveLength(3);                  // ni un asset más
    expect(supabase.state.positions).toHaveLength(3);               // ni una posición más
  });

  it('un error del insert de assets aborta con contexto (nada de fallos silenciosos)', async () => {
    const supabase = makeFakeSupabase();
    const netBuys = calculateNetBuys(DATA, 'degiro');
    const plan = computeImportPlan({
      dataSource: DATA, netBuys, broker: 'degiro',
      existingPositions: [], existingAssetsByTicker: {},
    });

    await expect(applyImportPlan({
      plan, dataSource: DATA, broker: 'degiro',
      brokerId: 'b', portfolioId: 'p', existingTransMap: new Map(), supabase,
      createAssetsFn: async () => { throw new Error('Assets insert (3 rows): boom assets'); },
    })).rejects.toThrow(/Assets insert.*boom assets/);
  });
});

describe('applyImportPlan — escrituras en la tabla compartida assets', () => {
  it('un asset existente: solo metadatos por update_asset_metadata, sin precio y DESPUÉS de crear la posición', async () => {
    const existing = { id: 'as-aapl', ticker: 'US0378331005 (USD)', current_price: 150, isin: null };
    const netBuys = calculateNetBuys(DATA, 'degiro');
    const plan = computeImportPlan({
      dataSource: DATA, netBuys, broker: 'degiro',
      existingPositions: [], existingAssetsByTicker: { [existing.ticker]: existing },
      importPrices: { US0378331005: 1.5 },
    });
    const supabase = makeFakeSupabase();
    await applyImportPlan({
      plan, dataSource: DATA, broker: 'degiro',
      brokerId: 'broker-1', portfolioId: 'pf-1', existingTransMap: new Map(), supabase,
      createAssetsFn: supabase.createAssetsFn,
    });

    const calls = supabase.state.rpcCalls.filter(c => c.args?.p_asset_id === existing.id);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('update_asset_metadata');
    expect(calls[0].args).not.toHaveProperty('p_current_price');
    expect(calls[0].args.p_isin).toBe('US0378331005');
    // la posición del usuario ya existía cuando se pidió (la RPC exige tenerla)
    expect(calls[0].positionsAtCall).toBe(supabase.state.positions.length);
    expect(supabase.state.positions.some(p => p.asset_id === existing.id)).toBe(true);
    expect(supabase.state.rpcCalls.some(c => c.name === 'update_asset_market_data')).toBe(false);
  });
});
