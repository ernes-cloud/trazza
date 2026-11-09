/**
 * Alta de filas en la tabla compartida `assets`.
 *
 * Desde 2026-10-27 (r15/r17) el INSERT directo de `authenticated` se cierra
 * en FASE 2 (20261029000300); FASE 1 (20261027000100) aporta ensure_asset.
 * Camino normal: POST /api/assets (service role → RPC). En modo demo / sin
 * sesión no hay JWT: `supabase.rpc('ensure_asset')` (mock en memoria).
 * Nadie en src/ hace `.from('assets').insert`.
 */

import { supabase } from '@/lib/customSupabaseClient';
import { authHeaders } from '@/lib/authHeaders';

const ASSET_CHUNK = 100;

/**
 * @param {Array<object>} rows  filas listas (ticker obligatorio); current_price se ignora
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<Array<{ id: string, ticker: string }>>}
 */
export async function createAssets(rows, { fetchImpl = fetch } = {}) {
  if (!rows?.length) return [];

  const headers = await authHeaders();
  if (!headers.Authorization) {
    // Demo / sin sesión: ensure_asset en el mock (ON CONFLICT DO NOTHING, price null).
    const created = [];
    for (const row of rows) {
      const res = await supabase.rpc('ensure_asset', {
        p_ticker: row.ticker,
        p_company_name: row.company_name ?? null,
        p_asset_class: row.asset_class ?? null,
        p_currency: row.currency ?? null,
        p_isin: row.isin ?? null,
      });
      if (res?.error) throw new Error(`Assets insert (1 rows): ${res.error.message}`);
      if (!res?.data) {
        throw new Error(
          `Assets insert (1 rows): ensure_asset returned no id for ${row.ticker}`,
        );
      }
      created.push({ id: res.data, ticker: row.ticker });
    }
    return created;
  }

  const out = [];
  for (let i = 0; i < rows.length; i += ASSET_CHUNK) {
    const chunk = rows.slice(i, i + ASSET_CHUNK);
    const r = await fetchImpl('/api/assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ assets: chunk }),
    });
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { const b = await r.json(); if (b?.error) msg = b.error; } catch { /* ignore */ }
      throw new Error(`Assets insert (${chunk.length} rows): ${msg}`);
    }
    const body = await r.json();
    out.push(...(body.assets || []));
  }
  return out;
}
