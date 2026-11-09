import { describe, it, expect } from 'vitest';
import {
  tickerLookupKey, indexAssetsByTicker, findAssetByTicker, loadExistingAssetsByTicker,
} from './existingAssets';
import { computeImportPlan } from './importPlanner';
import { applyImportPlan } from './importExecutor';
import { calculateNetBuys } from './netHoldings';
import { buildExistingTransMap } from '../../lib/importDedupe';
import mockSupabase from '../../lib/mockSupabaseClient';

describe('tickerLookupKey / indexAssetsByTicker / findAssetByTicker', () => {
  it('normaliza como ensure_asset: lower(btrim(ticker))', () => {
    expect(tickerLookupKey(' BTC-USD ')).toBe('btc-usd');
    expect(tickerLookupKey(null)).toBe('');
  });

  it('exacto gana sobre el normalizado, aunque el normalizado llegue antes', () => {
    const padded = { id: 'a-pad', ticker: ' BTC-USD ' };
    const exact = { id: 'a-exact', ticker: 'btc-usd' };
    const map = indexAssetsByTicker([padded, exact]);
    expect(findAssetByTicker(map, 'btc-usd')).toBe(exact);
    expect(findAssetByTicker(map, ' BTC-USD ')).toBe(padded);
    expect(findAssetByTicker(map, 'BTC-USD')).toBeDefined();
  });

  it('un ticker guardado con espacios/otro case se encuentra por la clave normalizada', () => {
    const map = indexAssetsByTicker([{ id: 'a1', ticker: ' btc-usd ' }]);
    expect(findAssetByTicker(map, 'BTC-USD')?.id).toBe('a1');
    expect(findAssetByTicker(map, 'ETH-USD')).toBeUndefined();
  });
});

// Fake con la semántica REAL de PostgREST: `.in` es igualdad exacta.
function makeStrictSupabase({ assets = [] } = {}) {
  const state = { assets: [...assets], positions: [], transactions: [] };
  let seq = 0;
  const nextId = (p) => `${p}-${++seq}`;
  const query = (table) => {
    const filters = [];
    const q = {
      select: () => q,
      eq: (c, v) => { filters.push((r) => r[c] === v); return q; },
      in: (c, vs) => { filters.push((r) => vs.includes(r[c])); return q; },
      then: (resolve) => Promise.resolve({ data: state[table].filter((r) => filters.every((f) => f(r))), error: null }).then(resolve),
      insert: (rows) => {
        const created = (Array.isArray(rows) ? rows : [rows]).map((r) => ({ id: nextId(table.slice(0, 2)), ...r }));
        state[table].push(...created);
        return { select: async () => ({ data: created, error: null }), then: (res) => Promise.resolve({ data: created, error: null }).then(res) };
      },
      update: (patch) => ({
        eq: async (c, v) => { state[table].forEach((r) => { if (r[c] === v) Object.assign(r, patch); }); return { error: null }; },
        in: async (c, vs) => { state[table].forEach((r) => { if (vs.includes(r[c])) Object.assign(r, patch); }); return { error: null }; },
      }),
    };
    return q;
  };
  // ensure_asset: existente por exacto O lower(btrim); si no, alta.
  const createAssetsFn = async (rows) => rows.map((row) => {
    const t = row.ticker.trim();
    const found = state.assets.find((a) => a.ticker === t)
      || state.assets.find((a) => tickerLookupKey(a.ticker) === t.toLowerCase());
    if (found) return { id: found.id, ticker: row.ticker };
    const created = { id: nextId('as'), ...row, ticker: t };
    state.assets.push(created);
    return { id: created.id, ticker: row.ticker };
  });
  return { state, from: query, rpc: async () => ({ error: null }), createAssetsFn };
}

const BTC_BUY = [{
  type: 'BUY', fecha: '02-01-2026', hora: '10:00', cantidad: 0.5, precio: 40000,
  producto: 'BTC-USD', isin: '', moneda: 'USD', total: -20000, descripcion: 'Buy BTC',
}];

async function reimport(supabase) {
  const existingPositions = supabase.state.positions.filter((p) => p.broker_id === 'broker-1');
  const existingTransMap = buildExistingTransMap(
    supabase.state.transactions.filter((t) => existingPositions.some((p) => p.id === t.position_id)),
  );
  const existingAssetsByTicker = await loadExistingAssetsByTicker({
    supabase, refs: ['BTC-USD'], assetIds: existingPositions.map((p) => p.asset_id),
  });
  const netBuys = calculateNetBuys(BTC_BUY, 'freeform');
  const plan = computeImportPlan({
    dataSource: BTC_BUY, netBuys, broker: 'freeform', existingPositions, existingAssetsByTicker,
  });
  await applyImportPlan({
    plan, dataSource: BTC_BUY, broker: 'freeform', brokerId: 'broker-1', portfolioId: 'pf-1',
    existingTransMap, supabase, createAssetsFn: supabase.createAssetsFn,
  });
}

describe('loadExistingAssetsByTicker — ticker legado con espacios (r16b I1)', () => {
  it("' btc-usd ' guardado: reimportar 3 veces deja UNA posición y la cantidad no se triplica", async () => {
    const supabase = makeStrictSupabase({ assets: [{ id: 'as-legacy', ticker: ' btc-usd ', current_price: 60000 }] });
    await reimport(supabase);
    const after1 = { positions: supabase.state.positions.length, assets: supabase.state.assets.length };
    await reimport(supabase);
    await reimport(supabase);

    const btcPositions = supabase.state.positions.filter((p) => p.asset_id === 'as-legacy');
    expect(btcPositions).toHaveLength(1);
    expect(Number(btcPositions[0].quantity)).toBeCloseTo(0.5, 8);
    // Ni una posición ni un asset más que tras el primer import (la pata CASH_USD incluida).
    expect(supabase.state.positions).toHaveLength(after1.positions);
    expect(supabase.state.assets).toHaveLength(after1.assets);
    expect(supabase.state.assets.filter((a) => tickerLookupKey(a.ticker) === 'btc-usd')).toHaveLength(1);
    expect(supabase.state.transactions.filter((t) => t.transaction_type === 'BUY')).toHaveLength(1);
  });

  it('carga también los assets de las posiciones existentes (el .in exacto de PostgREST no ve el legado)', async () => {
    const supabase = makeStrictSupabase({ assets: [{ id: 'as-legacy', ticker: ' btc-usd ' }] });
    const byRefOnly = await loadExistingAssetsByTicker({ supabase, refs: ['BTC-USD'], assetIds: [] });
    expect(findAssetByTicker(byRefOnly, 'BTC-USD')).toBeUndefined();
    const withPositions = await loadExistingAssetsByTicker({ supabase, refs: ['BTC-USD'], assetIds: ['as-legacy'] });
    expect(findAssetByTicker(withPositions, 'BTC-USD')?.id).toBe('as-legacy');
  });

  it('un error de lectura aborta con contexto (nada de mapa vacío silencioso)', async () => {
    const supabase = {
      from: () => {
        const q = { select: () => q, in: () => q, then: (r) => Promise.resolve({ data: null, error: { message: 'boom' } }).then(r) };
        return q;
      },
    };
    await expect(loadExistingAssetsByTicker({ supabase, refs: ['X'], assetIds: [] })).rejects.toThrow(/Assets lookup: boom/);
    await expect(loadExistingAssetsByTicker({ supabase, refs: [], assetIds: ['a'] })).rejects.toThrow(/Assets lookup: boom/);
  });
});

describe("mockSupabaseClient — .in('ticker') con semántica lower(btrim) de ensure_asset", () => {
  it('encuentra un ticker guardado con espacios y otro casing', async () => {
    const { data: id } = await mockSupabase.rpc('ensure_asset', { p_ticker: 'ZZPAD', p_currency: 'USD' });
    const asset = (await mockSupabase.from('assets').select('*').eq('id', id)).data[0];
    asset.ticker = ' zzpad ';
    const { data, error } = await mockSupabase.from('assets').select('*').in('ticker', ['ZZPAD']);
    expect(error).toBeNull();
    expect(data.map((a) => a.id)).toEqual([id]);
  });

  it('el resto de columnas sigue siendo igualdad exacta', async () => {
    const { data } = await mockSupabase.from('assets').select('*').in('currency', ['usd']);
    expect(data).toEqual([]);
  });
});
