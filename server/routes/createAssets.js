/**
 * POST /api/assets — asegura filas en la tabla compartida `assets`.
 *
 * Desde 2026-10-27 (r15/r17) el INSERT directo de `authenticated` se cierra
 * en FASE 2 (migración 20261029000300). Solo escribe el service role vía RPC
 * `ensure_asset` (FASE 1: 20261027000100):
 *
 *  - auth: JWT Bearer vía requireUser;
 *  - ticker: btrim, ≤ 120, sin control chars; SIN upper() (r17b; prod tiene
 *    placeholders con espacios/()[]/&/ y casing mixto). ensure_asset hace
 *    match existente exacto O lower(btrim) case-insensitive (prioridad exacto);
 *  - forma: ISIN válido o marcador CASH_*, currency 3–5 letras
 *    (ISO-4217 + USDT/…), asset_class de la lista blanca;
 *  - NUNCA fija ni sobrescribe precio de un ticker existente (body.current_price
 *    se ignora). La RPC pone current_price NULL en altas normales y 1 en CASH_*;
 *  - nunca sobrescribe nombre/divisa/ISIN de un ticker existente.
 *
 * Body: { assets: Array<{ ticker, company_name?, asset_class?, currency?,
 *                         isin?, current_price? }> }  // current_price ignorado
 * Respuesta: { assets: Array<{ id, ticker }> }  (uno por ticker pedido)
 */

import { requireUser } from '../lib/requireUser.js';
import { supabaseAdmin } from '../lib/adminSupabase.js';
import { addLog } from '../lib/logBuffer.js';

export const MAX_ASSETS_PER_REQUEST = 100;

const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
/** Marcador de liquidez de los parsers (DeGiro/IBKR/Binance…): CASH_EUR, CASH_USDT. */
const CASH_ISIN_RE = /^CASH_[A-Z0-9]{3,5}$/;
/** ISO-4217 (3) + cripto fiat-like (USDT, …) hasta 5. */
const CURRENCY_RE = /^[A-Z]{3,5}$/;
const ASSET_CLASSES = new Set([
  'Stock', 'ETF', 'Crypto', 'Cash', 'Fund', 'Bond', 'Index', 'Other', 'Others',
]);

export function isAcceptableIsin(raw) {
  if (typeof raw !== 'string') return false;
  const i = raw.trim().toUpperCase();
  return ISIN_RE.test(i) || CASH_ISIN_RE.test(i);
}

/**
 * Normaliza el ticker de entrada (btrim, ≤120, sin cntrl). SIN upper():
 * el casing y los espacios de un existente los resuelve ensure_asset
 * (exacto O lower(btrim), prioridad exacto) — misma semántica que el mock.
 * @returns {string|null}
 */
export function sanitizeTicker(raw) {
  if (typeof raw !== 'string') return null;
  // Control chars before trim: trim() se come \n/\t y dejaría pasar "bad\n".
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  const ticker = raw.trim();
  if (!ticker || ticker.length > 120) return null;
  return ticker;
}

/**
 * Filas candidatas a partir del body. Puro. Dedup por ticker (primera gana).
 * Ignora current_price (solo el cron / ensure_asset escriben precios).
 * @returns {Array<{ ticker: string, company_name: string|null, asset_class: string,
 *                   currency: string|null, isin: string|null }>}
 */
export function sanitizeAssets(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of input) {
    if (out.length >= MAX_ASSETS_PER_REQUEST) break;
    if (!raw || typeof raw !== 'object') continue;
    const ticker = sanitizeTicker(raw.ticker);
    if (!ticker || seen.has(ticker)) continue;

    let isin = null;
    if (raw.isin != null && raw.isin !== '') {
      if (typeof raw.isin !== 'string') continue;
      const i = raw.isin.trim().toUpperCase();
      if (!ISIN_RE.test(i) && !CASH_ISIN_RE.test(i)) continue;
      isin = i;
    }

    let currency = null;
    if (raw.currency != null && raw.currency !== '') {
      if (typeof raw.currency !== 'string') continue;
      const c = raw.currency.trim().toUpperCase();
      if (!CURRENCY_RE.test(c)) continue;
      currency = c;
    }

    let assetClass = 'Stock';
    if (raw.asset_class != null && raw.asset_class !== '') {
      if (typeof raw.asset_class !== 'string') continue;
      const ac = raw.asset_class.trim();
      if (!ASSET_CLASSES.has(ac)) continue;
      assetClass = ac;
    }
    // CASH_* fuerza Cash
    if (ticker.toUpperCase().startsWith('CASH_')) assetClass = 'Cash';

    let companyName = null;
    if (typeof raw.company_name === 'string') {
      const n = raw.company_name.trim().slice(0, 200);
      companyName = n || null;
    }

    seen.add(ticker);
    out.push({
      ticker,
      company_name: companyName,
      asset_class: assetClass,
      currency,
      isin,
    });
  }
  return out;
}

export async function createAssets(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const candidates = sanitizeAssets(req.body?.assets);
  if (candidates.length === 0) return res.json({ assets: [] });

  const assets = [];
  for (const c of candidates) {
    const { data: id, error } = await supabaseAdmin.rpc('ensure_asset', {
      p_ticker: c.ticker,
      p_company_name: c.company_name,
      p_asset_class: c.asset_class,
      p_currency: c.currency,
      p_isin: c.isin,
    });
    if (error) {
      console.warn('[createAssets] ensure_asset failed:', error.message);
      addLog('error', 'assets', `ensure_asset failed: ${error.message}`);
      return res.status(500).json({ error: 'Could not save assets' });
    }
    if (id) assets.push({ id, ticker: c.ticker });
  }

  return res.json({ assets });
}
