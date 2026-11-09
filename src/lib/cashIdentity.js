/**
 * Shared cash-position identity: writers historically used two ticker forms —
 *   `CASH_EUR`           — ensureCashPosition / CarteraPage (manual)
 *   `CASH_EUR (EUR)`     — importPlanner via getAssetIdentifiers (DeGiro-style)
 * Looking up only one form created a second liquidity row on every reimport /
 * manual op. Both paths resolve through these helpers so a broker never gets
 * duplicate cash for the same currency.
 *
 * R2: cash matches ONLY by canonical ticker (never by asset_class or currency
 * alone). After trim+toUpperCase the ticker must match
 *   /^CASH_([A-Z]{3,5})( \(\1\))?$/
 * and the captured currency must equal the currency column (normalized).
 * Bare `CASH`, `CASH_NET_EUR`, FX pairs, etc. never resolve as liquidity.
 */

/** Canonical forms: `CASH_EUR` or `CASH_EUR (EUR)` (parenthetical must repeat). */
export const CANONICAL_CASH_RE = /^CASH_([A-Z]{3,5})( \(\1\))?$/;

/**
 * Currency encoded by a canonical cash ticker, or null if not canonical.
 * @param {string} [ticker]
 * @returns {string|null}
 */
export function currencyFromCanonicalCashTicker(ticker) {
  const t = String(ticker ?? '').trim().toUpperCase();
  const m = t.match(CANONICAL_CASH_RE);
  return m ? m[1] : null;
}

/**
 * Single cash-identity predicate (R1/R2).
 * True iff ticker is a canonical cash spelling AND `currency` equals the
 * currency encoded in the ticker. Neither asset_class nor currency alone.
 * @param {string} [ticker]
 * @param {string} [currency]
 * @returns {boolean}
 */
export function matchesCashIdentity(ticker, currency) {
  const hint = currencyFromCanonicalCashTicker(ticker);
  if (!hint) return false;
  const cur = String(currency ?? '').trim().toUpperCase();
  return cur === hint;
}

/**
 * DeGiro-style decorated cash ticker: `CASH_EUR (EUR)`.
 * Single helper — used by cashTickersForCurrency and importPlanner TX linking.
 * @param {string} [currency]
 * @returns {string}
 */
export function decoratedCashTicker(currency) {
  const cur = String(currency || 'EUR').trim().toUpperCase() || 'EUR';
  return `CASH_${cur} (${cur})`;
}

/**
 * Known ticker spellings for liquidity in `currency`.
 * Bare `CASH` is intentionally absent.
 * @param {string} [currency]
 * @returns {string[]}
 */
export function cashTickersForCurrency(currency) {
  const cur = String(currency || 'EUR').trim().toUpperCase() || 'EUR';
  return [canonicalCashTicker(cur), decoratedCashTicker(cur)];
}

/** Canonical ticker written by ensureCashPosition for NEW cash assets. */
export function canonicalCashTicker(currency) {
  const cur = String(currency || 'EUR').trim().toUpperCase() || 'EUR';
  return `CASH_${cur}`;
}

/**
 * Currency encoded by a canonical cash ticker (alias of
 * currencyFromCanonicalCashTicker). Non-canonical → null.
 * @deprecated Prefer currencyFromCanonicalCashTicker; kept for callers/mutants.
 */
export function currencyHintFromCashTicker(ticker) {
  return currencyFromCanonicalCashTicker(ticker);
}

/**
 * True iff `ticker` is a known cash spelling for `currency` (canonical forms
 * only; currency column / lookup target must match the encoded currency).
 * Bare `CASH` → false.
 */
export function isCashTickerForCurrency(ticker, currency) {
  return matchesCashIdentity(ticker, currency);
}

/**
 * Find an existing cash asset in a ticker→asset map for `currency`.
 * Exact alias keys first, then scan values — both require matchesCashIdentity
 * (canonical ticker + currency column). No asset_class / currency-only fallback.
 * @param {Record<string, object>|null|undefined} assetsByTicker
 * @param {string} [currency]
 * @returns {object|null}
 */
export function findCashAssetByCurrency(assetsByTicker, currency) {
  const cur = String(currency || 'EUR').trim().toUpperCase() || 'EUR';
  if (!assetsByTicker || typeof assetsByTicker !== 'object') return null;

  for (const ticker of cashTickersForCurrency(cur)) {
    const hit = assetsByTicker[ticker];
    if (!hit) continue;
    // Map key may be the alias while value.ticker is authoritative for identity.
    const t = hit.ticker != null ? hit.ticker : ticker;
    const c = String(hit.currency || '').trim().toUpperCase() || currencyFromCanonicalCashTicker(t);
    if (matchesCashIdentity(t, c) && String(c).trim().toUpperCase() === cur) return hit;
  }

  for (const asset of Object.values(assetsByTicker)) {
    if (!asset) continue;
    const assetCur = String(asset.currency || '').trim().toUpperCase()
      || currencyFromCanonicalCashTicker(asset.ticker);
    if (!matchesCashIdentity(asset.ticker, assetCur)) continue;
    if (assetCur === cur) return asset;
  }
  return null;
}

/**
 * Find an existing cash position among loaded rows for broker + currency.
 * Matches only via matchesCashIdentity (canonical ticker + currency column).
 *
 * @param {Array} positions  rows with nested `assets` (and optional broker_id)
 * @param {{ currency?: string, brokerId?: string|null }} [opts]
 * @returns {object|null}
 */
export function findCashPosition(positions, opts = {}) {
  const cur = String(opts.currency || 'EUR').trim().toUpperCase() || 'EUR';
  const brokerId = opts.brokerId;
  const list = Array.isArray(positions) ? positions : [];

  for (const p of list) {
    if (brokerId != null && p?.broker_id != null && p.broker_id !== brokerId) continue;
    const a = p?.assets;
    const assetCur = String(a?.currency || '').trim().toUpperCase()
      || currencyFromCanonicalCashTicker(a?.ticker);
    if (!matchesCashIdentity(a?.ticker, assetCur)) continue;
    if (assetCur !== cur) continue;
    return p;
  }
  return null;
}
