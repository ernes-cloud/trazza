/**
 * Mock supabase-js-ish para tests de liquidez (ensureCashPosition / createAssets).
 *
 * Semántica de `rpc('ensure_asset')` alineada con public.ensure_asset / mockSupabaseClient:
 * existente por ticker exacto → id; si no, alta en state.assets y se contabiliza
 * en inserts.assets (para aserciones que miran "¿se creó un asset?").
 *
 * Usar desde tests no-TDD y también desde el harness TDD
 * (`useManualEntries.cash.test.js`), que lo importa directamente para mantener
 * el camino `ensure_asset` cubierto sin volver al fallback prohibido
 * `from('assets').insert`.
 */

/**
 * @param {{ mockImplementation: Function }} rpcMock  supabase.rpc (vi.fn)
 * @param {{
 *   state: { assets: object[] },
 *   inserts: { assets?: object[] },
 *   nextId: (prefix: string) => string,
 * }} ctx
 */
export function attachEnsureAssetRpc(rpcMock, { state, inserts, nextId }) {
  if (!rpcMock || typeof rpcMock.mockImplementation !== 'function') return;
  rpcMock.mockImplementation(async (fn, args = {}) => {
    if (fn === 'ensure_asset') {
      const ticker = String(args.p_ticker || '').trim();
      if (!ticker) return { data: null, error: { message: 'ticker required' } };
      let asset = state.assets.find((a) => a.ticker === ticker)
        || state.assets.find((a) => String(a.ticker || '').trim().toLowerCase() === ticker.toLowerCase());
      if (!asset) {
        asset = {
          id: nextId('as'),
          ticker,
          company_name: args.p_company_name ?? ticker,
          asset_class: args.p_asset_class ?? null,
          currency: args.p_currency ?? null,
          isin: args.p_isin ?? null,
          current_price: ticker.toUpperCase().startsWith('CASH_') ? 1 : null,
        };
        state.assets.push(asset);
        inserts.assets?.push(asset);
      }
      return { data: asset.id, error: null };
    }
    if (fn === 'adjust_position_quantity') {
      const pos = state.positions?.find((p) => p.id === args.p_position_id);
      if (pos) pos.quantity = (parseFloat(pos.quantity) || 0) + (args.p_delta || 0);
      return { data: pos?.quantity ?? 0, error: null };
    }
    return { data: null, error: null };
  });
}
