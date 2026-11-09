/**
 * Canonical "is this position liquidity (cash) rather than an invested asset?"
 *
 * The same two-signal test was hand-copied into ~15 places, half of them
 * case-SENSITIVE (`asset_class === 'Cash'`) and half case-insensitive
 * (`asset_class?.toLowerCase() === 'cash'`). A row stored as 'cash' or 'CASH'
 * was therefore liquidity for the positions table and an invested asset for the
 * Dashboard's position count and value split — the same row counted twice in
 * different senses on two screens.
 *
 * Signals (either one is enough):
 *   - `assets.asset_class` reads "cash" in any casing
 *   - `assets.ticker` starts with CASH (the CASH_EUR / CASH_USD convention every
 *     writer in the app uses: import planner and ensureCashPosition)
 */
export function isCashPosition(p) {
  const assetClass = p?.assets?.asset_class;
  if (typeof assetClass === 'string' && assetClass.trim().toLowerCase() === 'cash') return true;
  const ticker = p?.assets?.ticker;
  return typeof ticker === 'string' && ticker.trim().toUpperCase().startsWith('CASH');
}

/** Positions that hold a real asset — liquidity and closed (qty≈0) rows excluded. */
export const HELD_QTY_EPSILON = 0.0001;

export function isHeldInvestedPosition(p) {
  return !isCashPosition(p) && parseFloat(p?.quantity ?? 0) > HELD_QTY_EPSILON;
}
