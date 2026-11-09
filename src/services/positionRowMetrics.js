// Per-row display metrics for a position row (brokers screen).
//
// This math was duplicated verbatim between the mobile card list and the
// desktop table in CarteraPage — one shared implementation keeps the two
// views' numbers identical by construction (the CLAUDE.md cross-surface
// consistency rule). Display-level derivation over values ALREADY computed
// by the shared FIFO pipeline (usePositions/portfolioHistory) — no financial
// core logic lives here. decimal.js keeps the per-row figures coherent with
// the header stats (portfolioStats), which already use it.

import Decimal from 'decimal.js';

const D = (v) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return new Decimal(Number.isFinite(n) ? n : 0);
};

/**
 * Cost-basis priority (mirrors portfolioStats header stats):
 *   1. pos._prefCostTotal — FIFO cost of remaining lots (exact after partial sells)
 *   2. pos._histCost / assetHistoricalCost[asset_id] — AVCO approximation,
 *      scaled to the held quantity
 *   3. entry_price fallback (percentage from price ratio only)
 *
 * G/P decomposition (DeGiro-style), identity: gpProducto + gpMoneda = profitConverted.
 *
 * @param {object} pos position row (with .assets, optional _prefCostTotal/_histCost/
 *                     _totalValueInPref/_realizedGain enrichments from usePositions)
 * @param {object} ctx { preferredCurrency, exchangeRates, assetHistoricalCost }
 * @returns {{
 *   currentPrice:number, fxRate:number, valConverted:number, valNative:number,
 *   showNativeCurrency:boolean, prefCostTotal:number, gainPct:number,
 *   profitConverted:number, gpProducto:number|null, gpMoneda:number|null,
 *   gpObtenida:number|null, priceUp:boolean, priceDown:boolean, isPositive:boolean
 * }}
 */
/**
 * Bullet-chart metrics for a target-allocation row (position or cash).
 * Was duplicated four times across CarteraPage's mobile/desktop views.
 *
 * @param {number} valueInPref  current market value in preferred currency
 * @param {number|string} targetPct  target allocation (%)
 * @param {number} totalCurrent  total portfolio value (stats.current)
 */
export function computeTargetMetrics(valueInPref, targetPct, totalCurrent) {
  const value = D(valueInPref);
  const total = D(totalCurrent);
  const target = D(parseFloat(targetPct) || 0);
  const currentWeight = total.gt(0) ? value.div(total).times(100) : new Decimal(0);
  const fillPct = target.gt(0) ? Decimal.min(currentWeight.div(target).times(100), 130) : new Decimal(0);
  const isOver = target.gt(0) && currentWeight.gt(target.plus(0.5));
  const isUnder = target.gt(0) && currentWeight.lt(target.minus(0.5));
  const drift = currentWeight.minus(target);
  // Money needed: positive = need to add, negative = should reduce
  const moneyDelta = target.gt(0) ? target.div(100).times(total).minus(value) : null;
  return {
    currentWeight: currentWeight.toNumber(),
    target: target.toNumber(),
    fillPct: fillPct.toNumber(),
    isOver,
    isUnder,
    drift: drift.toNumber(),
    moneyDelta: moneyDelta === null ? null : moneyDelta.toNumber(),
  };
}

/**
 * Resolves the cash position used for the liquidity target row and its
 * effective target: the position's target_percentage first, the localStorage
 * fallback (`wf_cash_target_<ticker>`) when no cash position exists yet.
 */
export function resolveCashTarget(positions, preferredCurrency) {
  const cashAsset = positions.find(p => p.assets?.ticker === `CASH_${preferredCurrency}`)
    || positions.find(p => p.assets?.ticker?.startsWith('CASH'));
  const cashTickerId = cashAsset?.assets?.ticker || `CASH_${preferredCurrency}`;
  const storedCashTarget = (() => {
    try { return parseFloat(localStorage.getItem(`wf_cash_target_${cashTickerId}`)) || 0; }
    catch (_) { return 0; }
  })();
  const cashTarget = parseFloat(cashAsset?.target_percentage) || storedCashTarget;
  return { cashAsset, cashTickerId, cashTarget };
}

export function computePositionRowMetrics(pos, { preferredCurrency, exchangeRates = {}, assetHistoricalCost = {} }) {
  const currentPrice = pos.assets?.current_price != null
    ? pos.assets.current_price
    : (pos.entry_price || 0);
  const fxRate = pos.assets?.currency === preferredCurrency ? 1 : (exchangeRates[pos.assets?.currency] || 1);

  const qty = D(pos.quantity);
  const price = D(currentPrice);
  const fx = D(fxRate);
  const entry = D(pos.entry_price || 0);

  // Merged positions (general view) have a pre-computed _totalValueInPref that
  // correctly accounts for per-component currencies. Use it when available.
  const valConverted = pos._totalValueInPref !== undefined
    ? D(pos._totalValueInPref)
    : qty.times(price).times(fx);
  const valNative = fx.gt(0) ? valConverted.div(fx) : qty.times(price);
  const showNativeCurrency = pos._totalValueInPref === undefined && pos.assets?.currency !== preferredCurrency;

  let prefCostTotal;
  if (pos._prefCostTotal) {
    prefCostTotal = D(pos._prefCostTotal);
  } else {
    const hcd = pos._histCost || assetHistoricalCost[pos.asset_id];
    prefCostTotal = (hcd && hcd.totalBoughtQty > 0 && hcd.totalHistCost > 0)
      ? D(hcd.totalHistCost).times(qty.div(D(hcd.totalBoughtQty)))
      : new Decimal(0);
  }

  const gainPct = prefCostTotal.gt(0)
    ? valConverted.div(prefCostTotal).minus(1).times(100)
    : (pos.entry_price ? price.div(entry).minus(1).times(100) : new Decimal(0));
  const profitConverted = prefCostTotal.gt(0)
    ? valConverted.minus(prefCostTotal)
    : qty.times(price.minus(entry)).times(fx);

  // G/P Producto = pure price gain — computable from entry_price even without FIFO.
  // G/P Moneda = FX delta — only meaningful when we have historical cost.
  const gpProducto = pos.entry_price
    ? qty.times(price.minus(entry)).times(fx)
    : null;
  const gpMoneda = (prefCostTotal.gt(0) && gpProducto !== null)
    ? profitConverted.minus(gpProducto)
    : null;
  const gpObtenida = pos._realizedGain != null ? pos._realizedGain : null;

  return {
    currentPrice,
    fxRate,
    valConverted: valConverted.toNumber(),
    valNative: valNative.toNumber(),
    showNativeCurrency,
    prefCostTotal: prefCostTotal.toNumber(),
    gainPct: gainPct.toNumber(),
    profitConverted: profitConverted.toNumber(),
    gpProducto: gpProducto === null ? null : gpProducto.toNumber(),
    gpMoneda: gpMoneda === null ? null : gpMoneda.toNumber(),
    gpObtenida,
    priceUp: currentPrice > (pos.entry_price || 0),
    priceDown: currentPrice < (pos.entry_price || 0),
    isPositive: gainPct.gte(0),
  };
}
