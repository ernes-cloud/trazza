/**
 * POST /api/ticker-mappings — aporta asignaciones ISIN → ticker al catálogo
 * compartido `ticker_mappings`.
 *
 * Hasta el 2026-10-26 el navegador escribía la tabla directamente y las
 * políticas eran `with check (true)` / `using (true)`: cualquier cuenta podía
 * cambiar `IE00B4L5Y983` a otro ticker y todo el que importase ese ISIN
 * acababa con otro activo, otro precio y otra valoración (auditoría 7f2c915d,
 * A2). Ahora la tabla solo la escribe el service role, y el server no se fía
 * del par que le mandan:
 *
 *  - forma: ISIN válido, símbolo con caracteres de símbolo (≤ 20), nada CASH_;
 *  - verificación: el símbolo tiene que salir en la búsqueda de Yahoo POR ESE
 *    ISIN. Lo que el cliente resolvió buscando por NOMBRE no se comparte (le
 *    sirve a ese usuario en su sesión, pero no se publica para todos);
 *  - si el cliente manda el símbolo sin sufijo de bolsa (o uno que Yahoo no
 *    lista), se elige el listado de la bolsa que corresponde al país del ISIN
 *    — nunca el primer resultado a ciegas;
 *  - nunca sobrescribe: insert con ignoreDuplicates, así que ni una fila
 *    'manual' ni una 'auto' ya existente cambian por una aportación.
 *
 * Body: { mappings: { [isin]: ticker } }
 * Respuesta: { saved, rejected, unverified }
 *   - rejected: forma OK pero el símbolo no casa con Yahoo para ese ISIN
 *   - unverified: la búsqueda falló (red/429/…); no se publica
 */

import { requireUser } from '../lib/requireUser.js';
import { supabaseAdmin } from '../lib/adminSupabase.js';
import { ensureCrumb, httpsGetBody } from '../lib/yahooCrumb.js';
import { addLog } from '../lib/logBuffer.js';

export const MAX_MAPPINGS_PER_REQUEST = 25;
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.\-^=]{0,19}$/;

/** Sufijos de bolsa preferidos por país del ISIN (primero = más preferido). */
const ISIN_EXCHANGE_PREF = {
  IE: ['.AS', '.L', '.DE'],
  NL: ['.AS'],
  DE: ['.DE'],
  GB: ['.L'],
  FR: ['.PA'],
  BE: ['.BR'],
  IT: ['.MI'],
  ES: ['.MC'],
  CH: ['.SW'],
  US: [''], // listado USA sin sufijo
};

/**
 * Filas candidatas (aún sin verificar) a partir del body. Puro.
 * @returns {Array<{ isin: string, ticker: string }>}
 */
export function sanitizeMappings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const out = [];
  for (const [rawIsin, rawTicker] of Object.entries(input)) {
    if (out.length >= MAX_MAPPINGS_PER_REQUEST) break;
    if (typeof rawIsin !== 'string' || typeof rawTicker !== 'string') continue;
    const isin = rawIsin.trim().toUpperCase();
    const ticker = rawTicker.trim().toUpperCase();
    if (!ISIN_RE.test(isin) || !SYMBOL_RE.test(ticker) || ticker.startsWith('CASH_')) continue;
    out.push({ isin, ticker });
  }
  return out;
}

/**
 * Entre los símbolos que Yahoo devolvió para el ISIN, elige el del cliente si
 * está exacto; si no, el de la misma base en la bolsa que toca al país del
 * ISIN. Nunca `symbols[0]` a ciegas.
 * @returns {string|null}
 */
export function pickVerifiedTicker(isin, requested, symbols) {
  if (!symbols?.length) return null;
  if (symbols.includes(requested)) return requested;

  const base = requested.split('.')[0];
  const candidates = symbols.filter((s) => s === base || s.split('.')[0] === base);
  if (!candidates.length) return null;

  // Sufijo del pedido (SAN.MC, VOW3.DE) gana ANTES que la preferencia por país del ISIN.
  if (requested.includes('.')) {
    const suf = requested.slice(requested.indexOf('.'));
    const hit = candidates.find((s) => s.endsWith(suf));
    if (hit) return hit;
  }

  const prefs = ISIN_EXCHANGE_PREF[String(isin || '').slice(0, 2)] || [];
  for (const suf of prefs) {
    const hit = candidates.find((s) => (suf === '' ? !s.includes('.') : s.endsWith(suf)));
    if (hit) return hit;
  }
  return null;
}

/**
 * Símbolos que Yahoo devuelve al buscar el ISIN (en mayúsculas). Con las
 * cookies de la sesión del crumb: sin ellas la búsqueda responde 429 desde el
 * server (medido el 2026-10-26; con ellas, 200).
 */
export async function yahooSymbolsForIsin(isin) {
  const { cookies } = await ensureCrumb();
  const r = await httpsGetBody(
    `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(isin)}&quotesCount=10&newsCount=0`,
    cookies,
  );
  if (r.status !== 200) throw new Error(`Yahoo search HTTP ${r.status}`);
  return (JSON.parse(r.body)?.quotes || []).map((q) => String(q?.symbol || '').toUpperCase()).filter(Boolean);
}

const isRateLimited = (err) => /HTTP 429|\b429\b/.test(String(err?.message || err || ''));

/**
 * Se queda con las filas cuyo símbolo casa con la búsqueda del ISIN.
 * Secuencial (Yahoo castiga las ráfagas). Un 429 corta el bucle: lo que queda
 * sin mirar cuenta como unverified, no como rejected.
 *
 * @returns {{ verified: Array<{isin,ticker}>, rejected: number, unverified: number }}
 */
export async function verifyMappings(rows, lookup = yahooSymbolsForIsin) {
  const verified = [];
  let rejected = 0;
  let unverified = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    try {
      const symbols = await lookup(row.isin);
      const picked = pickVerifiedTicker(row.isin, row.ticker, symbols);
      if (picked) verified.push({ isin: row.isin, ticker: picked });
      else rejected += 1;
    } catch (err) {
      const msg = err?.message || String(err);
      console.warn(`[tickerMappings] verify ${row.isin}: ${msg}`);
      addLog('warn', 'import', `tickerMappings verify failed for ${row.isin}`, { isin: row.isin, error: msg });
      unverified += 1;
      if (isRateLimited(err)) {
        unverified += rows.length - i - 1;
        break;
      }
    }
  }
  return { verified, rejected, unverified };
}

export async function tickerMappings(req, res, { lookup } = {}) {
  const user = await requireUser(req, res);
  if (!user) return;

  const candidates = sanitizeMappings(req.body?.mappings);
  if (candidates.length === 0) return res.json({ saved: 0, rejected: 0, unverified: 0 });

  const { verified, rejected, unverified } = await verifyMappings(candidates, lookup);
  if (verified.length > 0) {
    const { error } = await supabaseAdmin
      .from('ticker_mappings')
      .upsert(verified.map((r) => ({ ...r, source: 'auto' })), { onConflict: 'isin', ignoreDuplicates: true });
    if (error) {
      console.warn('[tickerMappings] insert failed:', error.message);
      addLog('error', 'import', `tickerMappings upsert failed: ${error.message}`);
      return res.status(500).json({ error: 'Could not save mappings' });
    }
  }
  return res.json({ saved: verified.length, rejected, unverified });
}
