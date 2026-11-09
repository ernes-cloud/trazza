import Decimal from 'decimal.js';
import { FIFOCalculator } from './fifoAnalytics.js';
import { isCashPosition as isCash } from '../lib/positionKind.js';

// Shared FIFO/history pipeline for DB transactions.
//
// This is THE single implementation used by the brokers screen (usePositions),
// the Dashboard AND the share-portfolio server endpoint
// (server/routes/sharePortfolio.js imports this file directly). It used to exist
// three times and the copies drifted, so "Invertido" and the P&L totals disagreed
// between screens. Any change to cost-basis or fee logic goes HERE.
//
// Node-compatible: relative imports only, and the browser-only currencyService is
// loaded lazily inside the default deps (the server always injects its own deps,
// so the dynamic import never runs there). Tests inject deps and run offline.

// Actual execution currency of a transaction. The transaction_currency column
// (populated by new imports + migration backfill) is authoritative; rows imported
// before the column existed fall back to parsing the notes text:
//   Raw description (old imports): "Compra 10 MSFT @360,65 USD (US5949181045)" → 'USD'
//   Classification (new imports):  "Compra Directa (EUR)" → 'EUR'
//                                  "Compra Internacional (USD)" → 'USD'
export const noteTxCurrency = (notes, fallback) => {
  const m1 = notes?.match(/@[\d.,]+\s+([A-Z]{3})\s+\(/);
  if (m1) return m1[1];
  const m2 = notes?.match(/(?:Compra|Venta)\s+(?:Directa|Internacional)\s+\(([A-Z]{3})\)/);
  if (m2) return m2[1];
  return fallback;
};

export const txCurrencyOf = (t, fallback) =>
  t.transaction_currency || noteTxCurrency(t.notes, fallback);

// True if notes explicitly contain a DIFFERENT ISIN from the position's.
// Only exclude when we have positive evidence of wrong linkage; don't exclude
// classification-format notes that simply lack an ISIN.
const isWronglyLinked = (notes, posIsin) => {
  if (!posIsin || !notes) return false;
  const m = notes.match(/\(([A-Z]{2}[A-Z0-9]{9}[0-9])\)/);
  return !!(m && m[1] !== posIsin);
};

/**
 * Reconciles a FIFO open-lot cost with the quantity the position actually holds.
 *
 * The FIFO cost basis only covers lots present in the transactions table. When
 * the stored history covers FEWER shares than the position holds (DBs damaged by
 * the old unique-key import dedupe that dropped identical partial fills, manual
 * quantity edits, partial histories), pairing that PARTIAL cost with the FULL
 * market value inflates the latent gain and dumps the missing half into
 * "G/P Moneda" as a fake FX gain (+186% on a 2-share Amazon position with one
 * saved fill). Scaling by heldQty/openQty prices the uncovered shares at the
 * same average historical cost — the same AVCO semantics the _histCost fallback
 * already uses.
 *
 * @param {number} openPrefCost  FIFO cost of open lots in preferred currency
 * @param {number} openQty       quantity those lots cover
 * @param {number} heldQty       quantity the position actually holds
 * @returns {number} cost scaled to heldQty (unchanged when quantities match)
 */
export function scaleOpenCostToHeldQty(openPrefCost, openQty, heldQty) {
  if (!(openPrefCost > 0) || !(openQty > 0) || !(heldQty > 0)) return openPrefCost;
  // Relative tolerance: float drift between Decimal FIFO qty and the DB numeric
  // must not trigger a rescale.
  if (Math.abs(openQty - heldQty) / heldQty <= 0.001) return openPrefCost;
  return openPrefCost * (heldQty / openQty);
}

const EMPTY_TOTALS = {
  realized: 0,
  realizedSales: [],
  dividends: 0,
  fees: 0,
  totalBuyCost: 0,
  openPositionCost: 0,
  tradeCommissions: 0,
  tradeCommissionsByBroker: {},
  perAssetMetrics: {},
  buyTotalsByAsset: {},
  buyTotalsByPosition: {},
  firstTransactionDate: null,
  histRateMisses: 0,
};

/**
 * Computes the historical P&L totals from DB transaction rows
 * (each row shaped as returned by `transactions.select('*, positions(broker_id, assets(...)))`).
 *
 * @param {Array} transactions  raw DB transaction rows
 * @param {string} preferredCurrency  target display currency
 * @param {object} rates  spot rates currency→preferredCurrency; missing ones (incl. EUR)
 *                        are fetched and added via deps.getExchangeRate
 * @param {object} deps   { getExchangeRate, getHistoricalRate } — default currencyService
 * @returns totals (+ perAssetMetrics for per-position enrichment, firstTransactionDate)
 */
export async function computeHistoryTotals(transactions, preferredCurrency, rates = {}, deps = {}) {
  const getExchangeRate = deps.getExchangeRate
    || (async (from, to) => (await import('./currencyService.js')).currencyService.getExchangeRate(from, to));
  const getHistoricalRate = deps.getHistoricalRate
    || (async (from, to, date) => (await import('./currencyService.js')).currencyService.getHistoricalRate(from, to, date));

  if (!transactions || transactions.length === 0) return { ...EMPTY_TOTALS };

  const sorted = [...transactions].sort(
    (a, b) => new Date(a.transaction_date || 0) - new Date(b.transaction_date || 0)
  );

  // Ensure every currency we will convert has a spot rate. EUR is always needed:
  // trade commissions are EUR-invoiced (DeGiro/IBKR) even on USD/GBP assets.
  const neededCurrencies = new Set(['EUR']);
  sorted.forEach(t => {
    neededCurrencies.add(t.positions?.assets?.currency || 'EUR');
    if (t.transaction_currency) neededCurrencies.add(t.transaction_currency);
  });
  const fullRates = { ...rates };
  await Promise.all([...neededCurrencies].map(async cur => {
    if (cur in fullRates) return;
    try { fullRates[cur] = await getExchangeRate(cur, preferredCurrency); }
    catch { fullRates[cur] = 1; }
  }));

  // Pre-fetch historical FX rates for BUY transactions that need conversion.
  // Skips wrongly-linked transactions and uses actual trade currency (EUR-priced USD stocks).
  const histRateMap = {};
  const histKeys = [...new Set(
    sorted
      .filter(t => {
        if (t.transaction_type !== 'BUY' || !t.transaction_date) return false;
        if (t.eur_total != null && preferredCurrency === 'EUR') return false;
        if (isWronglyLinked(t.notes, t.positions?.assets?.isin)) return false;
        const txCur = txCurrencyOf(t, t.positions?.assets?.currency || 'EUR');
        return txCur !== preferredCurrency;
      })
      .map(t => {
        const txCur = txCurrencyOf(t, t.positions?.assets?.currency || 'EUR');
        return `${txCur}|${t.transaction_date.split('T')[0]}`;
      })
  )];
  // Fetch in small batches: a full-parallel burst gets rate-limited by Yahoo on
  // portfolios with many foreign-currency buy dates, silently dropping lots from
  // openPositionCost/_histCost (the per-row FX breakdown showed "—" until the lazy
  // on-expand loader re-fetched the rate without the burst). Keys that still fail
  // get ONE retry pass after a short pause — failures are transient 429s and are
  // never cached, so the retry usually lands.
  const HIST_BATCH = 4;
  const fetchHistBatch = async (keys) => {
    const misses = [];
    for (let i = 0; i < keys.length; i += HIST_BATCH) {
      await Promise.all(keys.slice(i, i + HIST_BATCH).map(async key => {
        const [cur, dateStr] = key.split('|');
        const histRate = await getHistoricalRate(cur, preferredCurrency, dateStr);
        if (histRate) histRateMap[key] = histRate;
        else misses.push(key);
      }));
    }
    return misses;
  };
  let histRateMisses = 0;
  const missedKeys = await fetchHistBatch(histKeys);
  if (missedKeys.length > 0) {
    await new Promise(r => setTimeout(r, 1200));
    const stillMissing = await fetchHistBatch(missedKeys);
    histRateMisses = stillMissing.length;
    if (histRateMisses > 0) {
      console.warn(`[portfolioHistory] ${histRateMisses} historical FX rates unavailable after retry — affected lots are excluded from openPositionCost:`, stillMissing.join(', '));
    }
  }

  const fifo = new FIFOCalculator();
  const eurRate = fullRates['EUR'] || 1;

  // Accumulators use decimal.js (project standard): compounding hundreds of
  // float additions is exactly where binary drift shows up. Per-lot products
  // stay in floats (single multiplication, negligible) — only the repeated
  // sums are Decimal. Everything converts back to number at return.
  let realized = new Decimal(0);
  // Detalle FIFO de cada venta, en orden cronológico (ver la rama SELL).
  const realizedSales = [];
  let dividends = new Decimal(0);
  let fees = new Decimal(0);
  let totalBuyCost = new Decimal(0);
  // Trade commissions stored on BUY/SELL rows (commission column, EUR-invoiced).
  // Tracked separately from FEE rows and per broker so the stats layer can fall back
  // to imported_data's embedded comisiones only for brokers not yet re-imported.
  let tradeCommissions = new Decimal(0);
  const tradeCommissionsByBroker = {};
  let firstTransactionDate = null;
  // Per-asset ALL-time buy totals in preferred currency (AVCO basis). Lots without a
  // historical rate are excluded from BOTH qty and cost — same semantics the lazy
  // per-row loader used. Two keyings:
  //   buyTotalsByAsset    — `${isin || ticker}_${currency}` (legacy string-key lookup)
  //   buyTotalsByPosition — position_id (authoritative join; immune to ISIN/ticker
  //                         mismatches and correct for merged general-view rows)
  const buyTotalsByAsset = {};
  const buyTotalsByPosition = {};
  const addBuyTotal = (t, trade, cost) => {
    const assetKey = `${trade.isin || trade.producto}_${trade.moneda}`;
    for (const [map, key] of [[buyTotalsByAsset, assetKey], [buyTotalsByPosition, t.position_id]]) {
      if (!key) continue;
      if (!map[key]) map[key] = { totalHistCost: new Decimal(0), totalBoughtQty: new Decimal(0) };
      map[key].totalHistCost = map[key].totalHistCost.plus(cost);
      map[key].totalBoughtQty = map[key].totalBoughtQty.plus(trade.cantidad);
    }
  };
  // Converts a buy-totals map's Decimal entries back to plain numbers for consumers.
  const buyTotalsToNumbers = (map) => Object.fromEntries(
    Object.entries(map).map(([k, v]) => [k, {
      totalHistCost: v.totalHistCost.toNumber(),
      totalBoughtQty: v.totalBoughtQty.toNumber(),
    }])
  );

  sorted.forEach(t => {
    if (!firstTransactionDate && t.transaction_date) {
      firstTransactionDate = t.transaction_date.split('T')[0];
    }

    const posAssetCur = t.positions?.assets?.currency || 'EUR';
    const currentRate = fullRates[posAssetCur] || 1;

    if ((t.transaction_type === 'BUY' || t.transaction_type === 'SELL') && t.commission != null) {
      const commPref = Math.abs(parseFloat(t.commission) || 0) * eurRate;
      tradeCommissions = tradeCommissions.plus(commPref);
      const bId = t.positions?.broker_id;
      if (bId) tradeCommissionsByBroker[bId] = (tradeCommissionsByBroker[bId] || new Decimal(0)).plus(commPref);
    }

    const trade = {
      isin: t.positions?.assets?.isin,
      producto: t.positions?.assets?.ticker,
      cantidad: parseFloat(t.quantity || 0),
      precio: parseFloat(t.price || 0),
      moneda: posAssetCur,
    };

    if (t.transaction_type === 'BUY') {
      // Skip transactions wrongly linked to this position (different ISIN in note).
      if (isWronglyLinked(t.notes, t.positions?.assets?.isin)) return;

      let cost;
      if (t.eur_total != null && preferredCurrency === 'EUR') {
        cost = Math.abs(t.eur_total);
      } else {
        // Use actual transaction currency (column first, notes fallback) —
        // e.g. USD stock bought on Xetra in EUR
        const txCur = txCurrencyOf(t, posAssetCur);
        if (txCur === preferredCurrency) {
          cost = trade.cantidad * trade.precio; // already in preferred currency
        } else {
          const dateStr = t.transaction_date?.split('T')[0];
          const histKey = dateStr ? `${txCur}|${dateStr}` : null;
          const histRate = histKey ? histRateMap[histKey] : null;
          if (histRate) {
            cost = trade.cantidad * trade.precio * histRate;
          } else {
            // No historical rate — approximate the cost at the CURRENT spot rate.
            // The old sentinel-0 design excluded these lots from openPositionCost
            // entirely, which paired a PARTIAL cost basis with the FULL market value
            // in latentGain: with several unpriced lots, "Ganancia Total" inflated by
            // tens of thousands (market value minus an almost-empty cost).
            // Current-rate approximation means the lot's FX gain reads as ~0 (pure
            // price gain) — conservative and complete, instead of absent and wrong.
            const fallbackRate = fullRates[txCur] || currentRate;
            cost = trade.cantidad * trade.precio * fallbackRate;
          }
        }
      }
      totalBuyCost = totalBuyCost.plus(cost);
      addBuyTotal(t, trade, cost);
      fifo.processBuy({ ...trade, _prefCost: cost });
    } else if (t.transaction_type === 'SELL') {
      const result = fifo.processSell(trade);
      realized = realized.plus(result.profit * currentRate);
      // Detalle por venta. El FIFO ya lo calcula para sumar `realized`; antes se
      // tiraba, así que cualquier pantalla que quisiera la lista tenía que
      // reimplementar el FIFO. Publicarlo aquí es lo que permite que la cartera
      // compartida enseñe las MISMAS ventas que la pantalla de brokers.
      // `profitPref` lleva ya el cambio a la divisa preferida, con el mismo
      // `currentRate` que alimenta el acumulador — no puede desviarse de él.
      realizedSales.push({
        date: (t.transaction_date || '').split('T')[0],
        ticker: trade.producto || null,
        name: t.positions?.assets?.company_name || trade.producto || null,
        isin: trade.isin || null,
        currency: posAssetCur,
        quantity: trade.cantidad,
        price: trade.precio,
        avgBuyPrice: result.avgBuyPrice,
        profit: result.profit,                       // en la divisa del activo
        profitPref: result.profit * currentRate,     // en la divisa preferida
        profitPercent: result.profitPercent,
        isMissingBuyData: !!result.isMissingBuyData,
      });
    } else if (t.transaction_type === 'DIVIDEND') {
      // Convert with the transaction's OWN currency (transaction_currency column),
      // not the asset's listing currency: IBKR settles dividends in the account's
      // base currency (EUR) even for USD stocks — converting that EUR amount with
      // the USD rate under-counted IBKR dividends by the EURUSD spread (~8%).
      // Legacy rows without the column keep the old asset-currency behaviour.
      const divCur = t.transaction_currency || posAssetCur;
      dividends = dividends.plus(parseFloat(t.total_amount || 0) * (fullRates[divCur] || 1));
    } else if (['FEE', 'FEES', 'TAX'].includes(t.transaction_type)) {
      // Use eur_total when the fee was already computed in EUR (e.g. Binance crypto fees)
      // to avoid multiplying an EUR amount by the asset's USD exchange rate.
      // Otherwise convert with the transaction's own currency (same rationale as dividends).
      const feeCur = t.transaction_currency || posAssetCur;
      const feeAmt = (t.eur_total != null && preferredCurrency === 'EUR')
        ? Math.abs(t.eur_total)
        : Math.abs(parseFloat(t.total_amount || 0)) * (fullRates[feeCur] || 1);
      fees = fees.plus(feeAmt);
    }
  });

  return {
    realized: realized.toNumber(),
    // Las ventas que componen `realized`, una a una. Invariante fijada por test:
    // Σ profitPref === realized.
    realizedSales,
    dividends: dividends.toNumber(),
    fees: fees.toNumber(),
    totalBuyCost: totalBuyCost.toNumber(),
    // Historical preferred-currency cost of currently-held lots (after sells consumed
    // FIFO lots). Used as the cost basis for latentGain on BOTH screens.
    openPositionCost: fifo.getOpenPositionPrefCost(),
    tradeCommissions: tradeCommissions.toNumber(),
    tradeCommissionsByBroker: Object.fromEntries(
      Object.entries(tradeCommissionsByBroker).map(([k, v]) => [k, v.toNumber()])
    ),
    perAssetMetrics: fifo.getPerAssetMetrics(),
    buyTotalsByAsset: buyTotalsToNumbers(buyTotalsByAsset),
    buyTotalsByPosition: buyTotalsToNumbers(buyTotalsByPosition),
    firstTransactionDate,
    // Number of buy lots whose historical FX rate could not be resolved (after retry).
    // When > 0, openPositionCost/_histCost are INCOMPLETE — consumers must not cache them.
    histRateMisses,
  };
}

/**
 * Hybrid open-position cost in preferred currency: per position, FIFO cost when its
 * history lives in the transactions table, AVCO buy totals otherwise, entry_price×rate
 * as last resort. COMPLETE by construction — the global FIFO openPositionCost only
 * covers brokers whose history was saved to the DB, so using it alone pairs a partial
 * cost with the full market value (the "saved Binance import inflated Ganancia Total"
 * bug). Shared by the brokers screen (usePositions) and the Dashboard fallback so
 * "Invertido" is identical on both with or without a metrics-cache hit.
 *
 * @param {Array} positions  raw DB position rows (`positions.select('*, assets(*)')`)
 * @param {object} history   computeHistoryTotals output (perAssetMetrics, buyTotals*)
 * @param {object} rates     spot rates currency→preferredCurrency
 * @returns {number} total cost basis of open positions in preferred currency
 */
export function computeInvestedHybrid(positions, history, rates = {}) {
  const { perAssetMetrics = {}, buyTotalsByPosition = {}, buyTotalsByAsset = {} } = history || {};

  const queueKeysOf = (p) => {
    const cur = p.assets?.currency || 'EUR';
    return [
      p.assets?.isin ? `${p.assets.isin}_${cur}` : null,
      p.assets?.ticker ? `${p.assets.ticker}_${cur}` : null,
    ].filter(Boolean);
  };

  // Group positions by FIFO queue so an asset held across several broker positions
  // (general view) consumes its open-lot cost exactly once, scaled to the COMBINED
  // held quantity (see scaleOpenCostToHeldQty for why the reconcile matters).
  const queueGroups = new Map(); // queueKey → { metrics, heldQty }
  const noQueue = [];
  for (const p of positions || []) {
    if (isCash(p)) continue;
    const qty = parseFloat(p.quantity || 0);
    if (!(qty > 0)) continue;
    const queueKey = queueKeysOf(p).find(k => perAssetMetrics[k]?.openPrefCost > 0) || null;
    if (queueKey) {
      const group = queueGroups.get(queueKey) || { metrics: perAssetMetrics[queueKey], heldQty: 0 };
      queueGroups.set(queueKey, { ...group, heldQty: group.heldQty + qty });
    } else {
      noQueue.push(p);
    }
  }

  // Decimal accumulation (project standard for monetary math) — keeps this total
  // exactly comparable with the portfolioStats sums it sits next to.
  let total = new Decimal(0);
  for (const { metrics, heldQty } of queueGroups.values()) {
    total = total.plus(scaleOpenCostToHeldQty(metrics.openPrefCost, metrics.openQty || 0, heldQty));
  }
  for (const p of noQueue) {
    const qty = parseFloat(p.quantity || 0);
    const buyTotals = buyTotalsByPosition[p.id]
      || queueKeysOf(p).map(k => buyTotalsByAsset[k]).find(Boolean)
      || null;
    if (buyTotals?.totalBoughtQty > 0) {
      total = total.plus(new Decimal(buyTotals.totalHistCost).times(qty).div(buyTotals.totalBoughtQty));
    } else {
      const rate = rates[p.assets?.currency || 'EUR'] || 1;
      total = total.plus(new Decimal(qty).times(parseFloat(p.entry_price || 0)).times(rate));
    }
  }
  return total.toNumber();
}

/**
 * Order-independent fingerprint of the positions that back a metrics-cache row.
 * txCount alone cannot detect mutations that change the cost basis WITHOUT changing
 * the transaction count (manual position edits/adds, deletes of transaction-less
 * positions) — those left the Dashboard serving a stale "Invertido" until the brokers
 * screen recomputed and republished. Publisher (usePositions) and consumers compare
 * this alongside txCount; any mismatch forces a recompute.
 *
 * @param {Array} positions  raw DB position rows for the scope (open AND closed)
 * @returns {string} stable fingerprint, e.g. "12-x8k3f2"
 */
export function computePositionsFingerprint(positions) {
  const parts = (positions || [])
    .map(p => `${p.id}:${p.quantity ?? ''}:${p.entry_price ?? ''}`)
    .sort();
  const joined = parts.join('|');
  let hash = 5381; // djb2
  for (let i = 0; i < joined.length; i++) {
    hash = ((hash << 5) + hash + joined.charCodeAt(i)) >>> 0;
  }
  return `${parts.length}-${hash.toString(36)}`;
}
