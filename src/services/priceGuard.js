/**
 * Sanity guard for live-price writes to assets.current_price.
 *
 * Motivation: a currency-handling bug (LSE pence ÷100 applied to USD-quoted
 * ETFs) silently wrote prices 100× too small to the DB for every user. This
 * guard blocks that class of corruption at the write boundary.
 *
 * Policy (deliberately ASYMMETRIC):
 *  - Block collapses: new price < 15% of the stored one in a single refresh.
 *    Real assets rarely lose >85% between two refreshes; unit-mixups (÷100,
 *    wrong currency) always look like this.
 *  - Allow increases of any size: if a too-small corrupted price is already
 *    stored, the correct larger price must be able to heal it (blocking both
 *    directions would freeze corruption forever). Big jumps are logged by the
 *    caller instead.
 *
 * Never applies to CASH rows (price is always 1) or when either side is
 * missing/zero — those writes carry their own semantics.
 */

export const PRICE_COLLAPSE_RATIO = 0.15;

export function isPlausiblePriceUpdate(storedPrice, newPrice) {
  const prev = Number(storedPrice);
  const next = Number(newPrice);
  if (!Number.isFinite(prev) || !Number.isFinite(next)) return true;
  if (prev <= 0 || next <= 0) return true; // nothing meaningful to compare
  return next / prev >= PRICE_COLLAPSE_RATIO;
}
