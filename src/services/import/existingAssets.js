/**
 * Lookup de filas existentes de `assets` para el planner del import.
 *
 * Misma clave que `public.ensure_asset` (migración 20261027000100): exacto
 * primero y, si no, `lower(btrim(ticker))`. En producción hay tickers legados
 * con espacios o en minúsculas; con un lookup solo exacto el planner no los
 * veía, planificaba un asset nuevo, ensure_asset devolvía el id EXISTENTE y
 * cada reimport creaba otra posición sobre el mismo activo (cantidad × N).
 */

import { getAssetIdentifiers, twinAssetTicker } from './assetIdentity.js';
import { cashTickersForCurrency } from '../../lib/cashIdentity.js';

const ASSET_CHUNK = 100;

const isCashNet = (net) => net?.type === 'CASH' || net?.type === 'Cash'
  || String(net?.isin || '').startsWith('CASH_');

/**
 * Refs that useImportFlow must batch-fetch before computeImportPlan.
 * Includes the broker-aware dbTicker, twin fund tickers, and every known
 * cash alias for cash rows so findCashAssetByCurrency can see CASH_EUR when
 * the CSV identity is CASH_EUR (EUR) (and the reverse).
 *
 * PURE — same code the hook uses; tests must build maps via this helper.
 *
 * @param {{ netBuys?: Array, dataSource?: Array, broker?: string }} args
 * @returns {string[]}
 */
export function collectImportAssetRefs({ netBuys = [], dataSource = [], broker } = {}) {
  const refs = new Set();
  for (const net of netBuys || []) {
    const { dbTicker } = getAssetIdentifiers(net, broker);
    if (dbTicker) refs.add(dbTicker);
    if (isCashNet(net)) {
      for (const t of cashTickersForCurrency(net.moneda || 'EUR')) refs.add(t);
    } else {
      const twin = twinAssetTicker(net, broker);
      if (twin) refs.add(twin);
    }
  }
  for (const tr of dataSource || []) {
    if (tr.isConsolidated) continue;
    if (!['BUY', 'SELL', 'DIVIDEND', 'TAX'].includes(tr.type) || !tr.isin) continue;
    const { dbTicker } = getAssetIdentifiers(tr, broker);
    if (dbTicker) refs.add(dbTicker);
  }
  return [...refs];
}


export const tickerLookupKey = (ticker) => String(ticker ?? '').trim().toLowerCase();

/**
 * Mapa ticker → fila con dos claves por fila: el ticker exacto y su clave
 * normalizada. Las exactas se indexan antes que todas las normalizadas para
 * que un 'btc-usd' real gane a un ' BTC-USD ' (ORDER BY (ticker = t) DESC).
 */
export function indexAssetsByTicker(rows) {
  const map = {};
  const list = (rows || []).filter((a) => a && a.ticker != null);
  for (const a of list) if (!(a.ticker in map)) map[a.ticker] = a;
  for (const a of list) {
    const key = tickerLookupKey(a.ticker);
    if (!(key in map)) map[key] = a;
  }
  return map;
}

export function findAssetByTicker(map, ref) {
  if (!map || ref == null) return undefined;
  return map[ref] ?? map[tickerLookupKey(ref)];
}

async function fetchChunked(supabase, column, values) {
  const rows = [];
  for (let i = 0; i < values.length; i += ASSET_CHUNK) {
    const { data, error } = await supabase
      .from('assets').select('*').in(column, values.slice(i, i + ASSET_CHUNK));
    if (error) throw new Error(`Assets lookup: ${error.message}`);
    rows.push(...(data || []));
  }
  return rows;
}

/**
 * Carga los assets que el plan puede referenciar: por ticker (`.in` de
 * PostgREST es exacto) Y por los asset_id de las posiciones ya existentes del
 * broker, que es lo que reencuentra un ticker legado con espacios al reimportar.
 */
export async function loadExistingAssetsByTicker({ supabase, refs = [], assetIds = [] }) {
  const tickers = [...new Set(refs.filter(Boolean))];
  const ids = [...new Set(assetIds.filter(Boolean))];
  const byTicker = await fetchChunked(supabase, 'ticker', tickers);
  const byId = await fetchChunked(supabase, 'id', ids);
  const seen = new Set();
  const rows = [...byTicker, ...byId].filter((a) => !seen.has(a.id) && seen.add(a.id));
  return indexAssetsByTicker(rows);
}
