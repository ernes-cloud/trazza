/**
 * Shared ISIN → Yahoo ticker mappings (ticker_mappings table).
 *
 * Every ISIN a user resolves via Yahoo search gets persisted ONCE and reused
 * by every other user — the catalogue improves with usage instead of each
 * client re-searching (and occasionally mis-resolving) the same ISINs.
 *
 * Precedence when resolving (highest first):
 *   1. static TICKER_MAP (curated, authoritative)
 *   2. user's own imported_data ticker_map (their confirmed session mappings)
 *   3. this shared table
 *   4. live Yahoo search
 *
 * Reads go straight to the table; writes go through the server (see
 * saveTickerMappings). All calls are best-effort: failures degrade to live search, never break flows.
 */

import { supabase } from '@/lib/customSupabaseClient';

const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const MAX_ROWS = 5000;

// Module-level cache: one fetch per session is enough (mappings rarely change).
let cachePromise = null;

export async function loadSharedTickerMappings() {
  if (!cachePromise) {
    cachePromise = supabase
      .from('ticker_mappings')
      .select('isin, ticker')
      .limit(MAX_ROWS)
      .then(({ data, error }) => {
        if (error) {
          console.warn('[tickerMappings] load failed:', error.message);
          cachePromise = null; // allow retry on next call
          return {};
        }
        const map = {};
        for (const row of data || []) map[row.isin] = row.ticker;
        return map;
      })
      .catch(() => {
        cachePromise = null;
        return {};
      });
  }
  return cachePromise;
}

// Same cap as the server (server/routes/tickerMappings.js MAX_MAPPINGS_PER_REQUEST).
const MAPPINGS_PER_REQUEST = 25;

/**
 * Contribute newly-resolved ISIN → ticker pairs (fire-and-forget).
 *
 * The table is written ONLY by the server since 2026-10-26 (audit 7f2c915d,
 * A2: its RLS let any account rewrite any mapping for everyone). The server
 * re-checks each pair against Yahoo's search for that ISIN and never
 * overwrites an existing row, so a pair resolved here by NAME may be dropped
 * — it still serves this session through the local cache below.
 */
export function saveTickerMappings(resolvedMap) {
  const rows = Object.entries(resolvedMap || {})
    .filter(([isin, ticker]) => ISIN_RE.test(isin) && ticker && ticker.length <= 20 && !ticker.startsWith('CASH_'));
  if (rows.length === 0) return;

  // Keep the session cache coherent with what this user just resolved.
  cachePromise = cachePromise?.then(cached => {
    const merged = { ...cached };
    for (const [isin, ticker] of rows) if (!merged[isin]) merged[isin] = ticker;
    return merged;
  }) || null;

  (async () => {
    const { data: { session } = {} } = await supabase.auth.getSession();
    if (!session?.access_token) return; // demo / signed out: nothing to contribute
    for (let i = 0; i < rows.length; i += MAPPINGS_PER_REQUEST) {
      const r = await fetch('/api/ticker-mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ mappings: Object.fromEntries(rows.slice(i, i + MAPPINGS_PER_REQUEST)) }),
      });
      if (!r.ok) { console.warn('[tickerMappings] save failed: HTTP', r.status); return; }
    }
  })().catch(err => console.warn('[tickerMappings] save failed:', err?.message));
}
