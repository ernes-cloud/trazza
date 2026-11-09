import Decimal from 'decimal.js';
// Relative + .js: this module is imported by the share server under Node.
import { isCashPosition } from '../lib/positionKind.js';

// Monetary aggregation for the brokers screen (CarteraPage header stats).
// Pure module: no React, no Supabase — receives loaded data, returns numbers.
// Uses decimal.js (project standard for monetary math) for the accumulations;
// results are returned as plain numbers for the UI layer.
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

const D = (v) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return new Decimal(Number.isFinite(n) ? n : 0);
};

/**
 * Market value of the NON-CASH positions, in the preferred currency.
 *
 * THE single definition of "Valor en Mercado" / Dashboard "Invertido" /
 * "Invertido en cartera" of the expenses screen. The three surfaces used to
 * compute (or approximate) it separately and drifted apart; any new surface
 * calls this, never its own reduce.
 *
 * Handles both shapes of position row:
 *   - merged general-view rows (`_valueComponents` / `_totalValueInPref`, built
 *     by usePositions — each component keeps ITS own currency and price)
 *   - plain DB rows (quantity × current_price × rate)
 *
 * `current_price` is compared with `!= null` on purpose: a legitimate 0 price
 * must stay 0, not silently fall back to the entry price.
 *
 * @param {Array} positions position rows (cash rows are filtered out here)
 * @param {Record<string, number>} exchangeRates currency → rate to preferred currency
 * @returns {import('decimal.js').Decimal} value in the preferred currency
 */
export function computeInvestedMarketValue(positions = [], exchangeRates = {}) {
  const rateOf = (cur) => D(exchangeRates[cur || 'EUR'] ?? 1);

  return positions.filter(p => !isCashPosition(p)).reduce((sum, p) => {
    if (p._valueComponents) {
      return sum.plus(p._valueComponents.reduce(
        (s, c) => s.plus(D(c.qty).times(D(c.price)).times(rateOf(c.cur))),
        new Decimal(0)
      ));
    }
    if (p._totalValueInPref !== undefined) return sum.plus(D(p._totalValueInPref));
    const cur = p.assets?.currency || 'EUR';
    const price = p.assets?.current_price != null
      ? p.assets.current_price
      : p.entry_price;
    return sum.plus(D(p.quantity).times(D(price)).times(rateOf(cur)));
  }, new Decimal(0));
}

/**
 * Legacy fallback for trade commissions that only exist inside imported_data JSON
 * (imports saved before the transactions.commission column existed).
 * A broker's embedded comisiones are counted only when:
 *   - the broker is considered saved (its CSV rows are deduped out of processedImportData,
 *     so nothing else counts them), AND
 *   - the DB has no commission-column data for it yet (re-importing backfills the column,
 *     after which the DB is authoritative and this fallback must not double-count).
 * Commissions are EUR-invoiced (DeGiro/IBKR) → converted with eurRate.
 */
export function computeEmbeddedCommissionsFallback({
  importedTransactionsByBroker = {},
  savedBrokerIds = new Set(),
  isSavedByBroker = {},
  tradeCommissionsByBroker = {},
  selectedBrokerId = 'general',
  eurRate = 1,
}) {
  let total = new Decimal(0);
  for (const [bId, txs] of Object.entries(importedTransactionsByBroker)) {
    if (selectedBrokerId !== 'general' && bId !== selectedBrokerId) continue;
    const isSaved = savedBrokerIds.has(bId) || isSavedByBroker[bId];
    if (!isSaved) continue;
    if ((tradeCommissionsByBroker[bId] || 0) > 0) continue;

    for (const t of txs || []) {
      const type = t.type || t.transaction_type;
      if (type !== 'BUY' && type !== 'SELL') continue;
      total = total.plus(D(t.comisiones).abs());
    }
  }
  return total.times(D(eurRate)).toNumber();
}

/**
 * Header stats for the brokers screen.
 *
 * Cost-basis priority per position (mirrors the per-row Rentabilidad column):
 *   1. FIFO _prefCostTotal — exact lot-level historical cost (tracks partial sells)
 *   2. assetHistoricalCost — AVCO approximation, populated asynchronously on load
 *   3. _totalCostInPref / entry_price × qty × current rate — last resort
 *
 * Fees composition (each source counted exactly once):
 *   - historyTotals.fees: standalone FEE/TAX rows in DB
 *   - historyTotals.tradeCommissions: commission column on DB BUY/SELL rows
 *   - importTotals.commissionsTotal: CSV-only rows (unsaved brokers) — the memo
 *     excludes DB rows from this total to avoid double-counting historyTotals.fees
 *   - embedded-JSON fallback for saved brokers without commission-column data
 */
export function computePortfolioStats({
  positions = [],
  exchangeRates = {},
  assetHistoricalCost = {},
  historyTotals = {},
  importTotals = {},
  importedTransactionsByBroker = {},
  savedBrokerIds = new Set(),
  isSavedByBroker = {},
  selectedBrokerId = 'general',
}) {
  const rateOf = (cur) => D(exchangeRates[cur || 'EUR'] ?? 1);

  const investedAssets = positions.filter(p => !isCashPosition(p));
  const cashAssets = positions.filter(isCashPosition);

  // Cost basis of currently-held positions in preferred currency
  const perPositionInvested = investedAssets.reduce((sum, p) => {
    const heldQty = D(p.quantity);
    // _histCost comes from the shared pipeline (attached in usePositions);
    // the assetHistoricalCost map is the legacy lazy-loaded fallback.
    const hcd = p._histCost || assetHistoricalCost[p.asset_id];
    let perPosCost = D(p._prefCostTotal);
    if (perPosCost.lte(0) && hcd && hcd.totalBoughtQty > 0) {
      perPosCost = D(hcd.totalHistCost).times(heldQty.div(D(hcd.totalBoughtQty)));
    }
    if (perPosCost.gt(0)) return sum.plus(perPosCost);
    if (p._totalCostInPref !== undefined) return sum.plus(D(p._totalCostInPref));
    const cur = p.assets?.currency || 'EUR';
    return sum.plus(heldQty.times(D(p.entry_price)).times(rateOf(cur)));
  }, new Decimal(0));
  const invested = Decimal.max(perPositionInvested, 0);

  // Shared with the Dashboard and the expenses screen — see computeInvestedMarketValue.
  const investedValue = computeInvestedMarketValue(investedAssets, exchangeRates);

  // totalCash from actual DB cash positions (avoids double-counting with CSV imports)
  const totalCash = cashAssets.reduce((sum, p) => {
    if (p._totalValueInPref !== undefined) return sum.plus(D(p._totalValueInPref));
    const cur = p.assets?.currency || 'EUR';
    return sum.plus(D(p.quantity).times(rateOf(cur)));
  }, new Decimal(0));

  // Latent-gain cost basis: the per-position hybrid sum (FIFO where the position's
  // history is in the DB, entry/AVCO where it only lives in imported_data). The global
  // FIFO openPositionCost must NEVER be used directly here: it only covers brokers with
  // saved history, so with mixed saved/unsaved brokers it paired a partial cost with
  // the full market value and inflated the gain by tens of thousands.
  const openPosCostForGain = D(historyTotals.investedHybrid).gt(0)
    ? D(historyTotals.investedHybrid)
    : invested;
  const latentGain = investedValue.minus(openPosCostForGain);
  const current = investedValue.plus(totalCash);

  // Realized/dividends are ADDITIVE: DB totals (saved brokers) + CSV-only totals
  // (unsaved brokers — disjoint sets after dedupe). The old `db || csv` fallback
  // dropped unsaved brokers' gains in the general view whenever ANY broker had DB
  // history. Legacy fallback to the mixed totals only when csv-only fields are absent.
  const csvRealized = importTotals.salesTotalCsvOnly
    ?? ((historyTotals.realized || 0) > 0 ? 0 : importTotals.salesTotal || 0);
  const csvDividends = importTotals.dividendsTotalCsvOnly
    ?? ((historyTotals.dividends || 0) > 0 ? 0 : importTotals.dividendsTotal || 0);
  const realizedGain = (historyTotals.realized || 0) + csvRealized;
  const dividendsGain = (historyTotals.dividends || 0) + csvDividends;

  const embeddedCommissions = computeEmbeddedCommissionsFallback({
    importedTransactionsByBroker,
    savedBrokerIds,
    isSavedByBroker,
    tradeCommissionsByBroker: historyTotals.tradeCommissionsByBroker || {},
    selectedBrokerId,
    eurRate: exchangeRates['EUR'] ?? 1,
  });

  const feesTotal = D(historyTotals.fees)
    .plus(D(historyTotals.tradeCommissions))
    .plus(D(importTotals.commissionsTotal))
    .plus(D(embeddedCommissions));

  const gain = latentGain.plus(D(realizedGain)).plus(D(dividendsGain)).minus(feesTotal);

  // historyTotals.totalBuyCost sums ALL historical BUY amounts (including sold positions)
  // at historical rates (eur_total) — the correct ROI denominator. csvBuyTotal adds
  // unsaved CSV imports on top.
  const mergedBuyCost = D(historyTotals.totalBuyCost).plus(D(importTotals.csvBuyTotal));
  const totalCapitalDeployed = mergedBuyCost.gt(0) ? mergedBuyCost : invested;
  const gainPercent = totalCapitalDeployed.gt(0)
    ? gain.div(totalCapitalDeployed).times(100)
    : new Decimal(0);

  // Currency exposure uses only invested assets (excludes cash/leverage)
  const exposure = investedAssets.reduce((acc, p) => {
    const cur = p.assets?.currency || 'EUR';
    const price = p.assets?.current_price != null
      ? p.assets.current_price
      : p.entry_price;
    const val = D(p.quantity).times(D(price)).times(rateOf(cur));
    if (val.gt(0.01)) acc[cur] = (acc[cur] || new Decimal(0)).plus(val);
    return acc;
  }, {});

  const exposureData = Object.entries(exposure)
    .map(([name, value]) => ({ name, value: value.toNumber() }))
    .filter(({ value }) => value > 0.01)
    .sort((a, b) => b.value - a.value);

  return {
    invested: invested.toNumber(),
    investedValue: investedValue.toNumber(),
    current: current.toNumber(),
    totalCash: totalCash.toNumber(),
    totalCapitalDeployed: totalCapitalDeployed.toNumber(),
    gain: gain.toNumber(),
    gainPercent: gainPercent.toNumber(),
    exposureData,
    latentGain: latentGain.toNumber(),
    realizedGain: typeof realizedGain === 'number' ? realizedGain : D(realizedGain).toNumber(),
    dividendsGain: typeof dividendsGain === 'number' ? dividendsGain : D(dividendsGain).toNumber(),
    feesTotal: feesTotal.toNumber(),
  };
}
