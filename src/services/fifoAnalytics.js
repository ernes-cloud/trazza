import Decimal from 'decimal.js';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

/**
 * FIFO cost-basis tracker for realized P&L and open-position cost calculations.
 *
 * Each asset+currency combination maintains its own queue of buy lots.
 * Sells consume lots in FIFO order, recording the cost basis of each consumed lot
 * so that realized gain/loss can be computed accurately even across partial fills.
 *
 * All quantities and prices use decimal.js (precision 28) to prevent float drift
 * when compounding many small lot consumptions.
 */
export class FIFOCalculator {
  constructor() {
    this.queues = {};
    this.realizedByAsset = {};
    // Cumulative cost basis of ALL sold lots (denominator for Beta ROI) — native currency
    this._totalSoldCostBasis = new Decimal(0);
    // Cumulative realized gain/loss across ALL sells (numerator for Beta ROI) — native currency
    this._totalRealizedGain = new Decimal(0);
    // Pref-currency (EUR) equivalents for Getquin formula — always in base currency
    this._totalSoldProceedsPref = new Decimal(0);
    this._totalSoldPrefCostBasis = new Decimal(0);
  }

  /**
   * Records a BUY lot in the FIFO queue for the given asset.
   *
   * @param {object} trade
   * @param {number} trade.cantidad  - Number of units purchased.
   * @param {number} trade.precio    - Price per unit in native currency.
   * @param {string} trade.moneda    - Native currency of the asset (e.g. 'USD', 'EUR').
   * @param {string} [trade.isin]    - ISIN used as the queue key (preferred over producto).
   * @param {string} [trade.producto] - Fallback identifier when ISIN is absent.
   * @param {number} [trade._prefCost] - Total cost in the user's preferred currency at the
   *   historical FX rate of the purchase date.  When provided, getOpenPositionPrefCost()
   *   returns true EUR-base cost instead of qty × price.  Omit for same-currency assets.
   */
  processBuy(trade) {
    const assetId = trade.isin || trade.producto || trade.name;
    const currency = trade.moneda || 'EUR';
    const key = `${assetId}_${currency}`;

    if (!this.queues[key]) this.queues[key] = [];

    const qty = new Decimal(trade.cantidad);
    this.queues[key].push({
      ...trade,
      _qty: qty,
      _price: new Decimal(trade.precio),
      _prefCost: trade._prefCost != null ? new Decimal(trade._prefCost) : qty.times(new Decimal(trade.precio)),
      remainingQty: qty,
    });
  }

  /**
   * Returns the historical preferred-currency cost of all currently open lots.
   *
   * Each lot contributes proportionally: (remainingQty / originalQty) × lotPrefCost.
   * This is the denominator used by the Dashboard's "ROI Actual" metric —
   * it reflects what was actually paid (at historical FX) for the units still held,
   * not what the same units would cost to buy today.
   *
   * @returns {number}
   */
  getOpenPositionPrefCost() {
    let total = new Decimal(0);
    for (const queue of Object.values(this.queues)) {
      for (const lot of queue) {
        if (lot.remainingQty.gt(0.00000001) && lot._qty.gt(0) && lot._prefCost.gt(0)) {
          total = total.plus(lot.remainingQty.div(lot._qty).times(lot._prefCost));
        }
      }
    }
    return total.toNumber();
  }

  /**
   * Returns the cumulative realized gain/loss from all sell operations.
   * This is the numerator for the Beta ROI: sum of (sale proceeds − cost basis).
   * @returns {number}
   */
  getTotalRealizedGain() {
    return this._totalRealizedGain.toNumber();
  }

  /**
   * Returns the cumulative cost basis of all lots consumed by sell operations.
   * This is the denominator for the Beta ROI: sum of purchase costs of sold assets.
   * @returns {number}
   */
  getTotalSoldCostBasis() {
    return this._totalSoldCostBasis.toNumber();
  }

  /**
   * Returns total sell proceeds in pref-currency (EUR), accumulated via _prefProceeds.
   * Numerator component for the Getquin formula: open value + these proceeds.
   * @returns {number}
   */
  getTotalSoldProceedsPref() {
    return this._totalSoldProceedsPref.toNumber();
  }

  /**
   * Returns pref-currency (EUR) cost basis consumed by all sell operations.
   * Used with getOpenPositionPrefCost() to reconstruct total historical buy cost in EUR.
   * @returns {number}
   */
  getTotalSoldPrefCostBasis() {
    return this._totalSoldPrefCostBasis.toNumber();
  }

  /**
   * Consumes lots from the FIFO queue in order and returns the realized gain/loss.
   *
   * @param {object} sellTrade
   * @param {number} sellTrade.cantidad - Number of units sold.
   * @param {number} sellTrade.precio   - Sale price per unit.
   * @param {string} [sellTrade.isin]   - Asset identifier matching the buy-side key.
   * @param {string} [sellTrade.moneda] - Currency (must match the corresponding buy lots).
   *
   * @returns {{
   *   avgBuyPrice: number,       // FIFO-weighted average cost of the consumed lots
   *   profit: number,            // Gross sale proceeds minus FIFO cost basis
   *   profitPercent: number|null, // (salePrice − avgBuyPrice) / avgBuyPrice × 100; null sin lotes de compra
   *   isMissingBuyData: boolean, // true when no buy lots existed for this asset
   *   sharesMissingHistory: number, // units sold without a matching buy lot (orphan shares)
   *   lots: Array<{ date: string|null, qty: number, unitCost: number, fxRate: number|null }>
   *     // FIFO lots consumed: buy date (pipeline format), units, native unit cost
   *     // (the same _price the profit uses — commissions are NOT included, they
   *     // go to the commissions list), and the broker fx_rate of that buy if any.
   * }}
   */
  processSell(sellTrade) {
    const assetId = sellTrade.isin || sellTrade.producto || sellTrade.name;
    const currency = sellTrade.moneda || 'EUR';
    const key = `${assetId}_${currency}`;

    let sharesToSell = new Decimal(sellTrade.cantidad);
    let totalCostAccumulated = new Decimal(0);
    // Pref-currency (EUR) cost basis consumed from FIFO lots — used for Getquin denominator
    let totalPrefCostConsumed = new Decimal(0);

    const queue = this.queues[key] || [];
    const isMissingBuyData = queue.length === 0;
    let sharesMissingHistory = new Decimal(sellTrade.cantidad);
    // Lotes consumidos, para el informe fiscal (cada lote a SU tipo de cambio).
    // Solo se lee del estado: no cambia ningún cálculo de abajo.
    const lots = [];

    for (const buy of queue) {
      if (sharesToSell.lte(0.00000001)) break;

      if (buy.remainingQty.gt(0.00000001)) {
        const consumed = Decimal.min(sharesToSell, buy.remainingQty);

        const lotFx = Number(buy.fxRate ?? buy.fx_rate);
        lots.push({
          date: buy.fecha ?? null,
          qty: consumed.toNumber(),
          unitCost: buy._price.toNumber(),
          fxRate: Number.isFinite(lotFx) && lotFx > 0 ? lotFx : null,
        });

        totalCostAccumulated = totalCostAccumulated.plus(consumed.times(buy._price));

        // Proportional EUR cost consumed from this lot (_prefCost already in EUR)
        if (buy._qty.gt(0) && buy._prefCost.gt(0)) {
          totalPrefCostConsumed = totalPrefCostConsumed.plus(
            consumed.div(buy._qty).times(buy._prefCost)
          );
        }

        buy.remainingQty = buy.remainingQty.minus(consumed);
        sharesToSell = sharesToSell.minus(consumed);
        sharesMissingHistory = sharesMissingHistory.minus(consumed);
      }
    }

    const sellQty = new Decimal(sellTrade.cantidad);
    const sellPrice = new Decimal(sellTrade.precio);
    const averageBuyPrice = sellQty.gt(0)
      ? totalCostAccumulated.div(sellQty)
      : new Decimal(0);

    const totalSaleGross = sellQty.times(sellPrice);
    const profit = totalSaleGross.minus(totalCostAccumulated);

    let profitPercent = 0;
    if (averageBuyPrice.gt(0)) {
      profitPercent = sellPrice.minus(averageBuyPrice).div(averageBuyPrice).times(100).toNumber();
    } else if (isMissingBuyData) {
      // Without buy lots there is no cost basis — a percentage is undefined.
      // (The old sentinel 100 rendered a fake "+100%" in RealizedPnLTable.)
      profitPercent = null;
    }

    // Track realized profit per asset for per-position gain decomposition.
    if (!this.realizedByAsset[key]) this.realizedByAsset[key] = new Decimal(0);
    this.realizedByAsset[key] = this.realizedByAsset[key].plus(profit);

    // Beta ROI accumulators (native currency — ratio cancels FX)
    this._totalSoldCostBasis = this._totalSoldCostBasis.plus(totalCostAccumulated);
    this._totalRealizedGain = this._totalRealizedGain.plus(profit);

    // Getquin accumulators — pref-currency (EUR) so no FX mixing
    this._totalSoldPrefCostBasis = this._totalSoldPrefCostBasis.plus(totalPrefCostConsumed);
    if (sellTrade._prefProceeds != null) {
      this._totalSoldProceedsPref = this._totalSoldProceedsPref.plus(
        new Decimal(sellTrade._prefProceeds)
      );
    }

    return {
      avgBuyPrice: averageBuyPrice.toNumber(),
      profit: profit.toNumber(),
      profitPercent,
      isMissingBuyData,
      sharesMissingHistory: Math.max(0, sharesMissingHistory.toNumber()),
      lots,
    };
  }

  // Returns per-asset metrics for FX-aware gain decomposition.
  // Each entry: { openPrefCost, openQty, realizedNative }
  getPerAssetMetrics() {
    const result = {};
    for (const [key, queue] of Object.entries(this.queues)) {
      let openPrefCost = new Decimal(0);
      let openQty = new Decimal(0);
      for (const lot of queue) {
        if (lot.remainingQty.gt(0.00000001) && lot._qty.gt(0) && lot._prefCost.gt(0)) {
          openPrefCost = openPrefCost.plus(lot.remainingQty.div(lot._qty).times(lot._prefCost));
          openQty = openQty.plus(lot.remainingQty);
        }
      }
      result[key] = {
        openPrefCost: openPrefCost.toNumber(),
        openQty: openQty.toNumber(),
        realizedNative: (this.realizedByAsset[key] || new Decimal(0)).toNumber(),
      };
    }
    return result;
  }
}
