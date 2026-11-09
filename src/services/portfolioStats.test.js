import { describe, it, expect } from 'vitest';
import {
  computePortfolioStats, computeEmbeddedCommissionsFallback, computeInvestedMarketValue,
} from './portfolioStats';
import { convertQuotePrice } from './quotePricing';

const stockPosition = (over = {}) => ({
  id: 'pos-1',
  asset_id: 'asset-1',
  quantity: 10,
  entry_price: 100,
  assets: { ticker: 'MSFT', asset_class: 'Stock', currency: 'USD', current_price: 120 },
  ...over,
});

const cashPosition = (over = {}) => ({
  id: 'pos-cash',
  asset_id: 'asset-cash',
  quantity: 500,
  entry_price: 1,
  assets: { ticker: 'CASH_EUR', asset_class: 'Cash', currency: 'EUR', current_price: 1 },
  ...over,
});

describe('computePortfolioStats', () => {
  it('computes invested, market value and cash in preferred currency', () => {
    const stats = computePortfolioStats({
      positions: [stockPosition(), cashPosition()],
      exchangeRates: { USD: 0.9, EUR: 1 },
    });
    // invested: 10 × 100 × 0.9 (entry_price fallback, no FIFO data)
    expect(stats.invested).toBeCloseTo(900, 10);
    // value: 10 × 120 × 0.9
    expect(stats.investedValue).toBeCloseTo(1080, 10);
    expect(stats.totalCash).toBeCloseTo(500, 10);
    expect(stats.current).toBeCloseTo(1580, 10);
  });

  describe('5000 CHF de liquidez en la vista general (ensure_asset pone precio 1 a CASH_*)', () => {
    // La vista general de brokers (usePositions) agrupa con
    // qty × parseFloat(current_price || 0) × rate en _valueComponents →
    // _totalValueInPref. Con el ensure_asset viejo (current_price NULL) la
    // liquidez salía a 0; con precio 1, a su valor.
    const rates = { CHF: 0.95, EUR: 1 };
    const generalViewChf = (currentPrice) => {
      const assets = { ticker: 'CASH_CHF', asset_class: 'Cash', currency: 'CHF', current_price: currentPrice };
      const valueComponents = [{ qty: 5000, price: parseFloat(assets.current_price || 0), cur: 'CHF' }];
      return cashPosition({
        quantity: 5000,
        assets,
        _valueComponents: valueComponents,
        _totalValueInPref: valueComponents.reduce((s, c) => s + c.qty * c.price * (rates[c.cur] || 1), 0),
      });
    };

    it('current_price NULL (alta vieja sin precio) → totalCash 0', () => {
      const stats = computePortfolioStats({ positions: [generalViewChf(null)], exchangeRates: rates });
      expect(stats.totalCash).toBe(0);
    });

    it('current_price 1 (ensure_asset en CASH_*) → totalCash 4750', () => {
      const stats = computePortfolioStats({ positions: [generalViewChf(1)], exchangeRates: rates });
      expect(stats.totalCash).toBeCloseTo(4750, 10);
    });

    it('sin _totalValueInPref (vista de un broker) cuenta qty × tipo, con o sin precio', () => {
      for (const price of [null, 1]) {
        const chf = cashPosition({
          quantity: 5000,
          assets: { ticker: 'CASH_CHF', asset_class: 'Cash', currency: 'CHF', current_price: price },
        });
        const stats = computePortfolioStats({ positions: [chf], exchangeRates: rates });
        expect(stats.totalCash).toBeCloseTo(4750, 10);
      }
    });
  });

  it('prefers FIFO _prefCostTotal over entry_price for cost basis', () => {
    const stats = computePortfolioStats({
      positions: [stockPosition({ _prefCostTotal: 850 })],
      exchangeRates: { USD: 0.9 },
    });
    expect(stats.invested).toBeCloseTo(850, 10);
  });

  it('uses AVCO assetHistoricalCost proportional to held quantity when FIFO is missing', () => {
    const stats = computePortfolioStats({
      positions: [stockPosition({ quantity: 5 })],
      exchangeRates: { USD: 0.9 },
      // bought 10 in total for 1000 (pref currency) — still holds 5 → cost 500
      assetHistoricalCost: { 'asset-1': { totalBoughtQty: 10, totalHistCost: 1000 } },
    });
    expect(stats.invested).toBeCloseTo(500, 10);
  });

  it('values merged positions through _valueComponents per component currency', () => {
    const merged = stockPosition({
      quantity: 15,
      _totalCostInPref: 1400,
      _valueComponents: [
        { qty: 10, price: 120, cur: 'USD', ticker: 'AMZN' },
        { qty: 5, price: 110, cur: 'EUR', ticker: 'AMZ.DE' },
      ],
    });
    const stats = computePortfolioStats({
      positions: [merged],
      exchangeRates: { USD: 0.9, EUR: 1 },
    });
    // 10×120×0.9 + 5×110×1 = 1080 + 550
    expect(stats.investedValue).toBeCloseTo(1630, 10);
    expect(stats.invested).toBeCloseTo(1400, 10);
  });

  it('uses the hybrid cost basis for latent gain — NEVER the partial global FIFO cost', () => {
    // openPositionCost only covers brokers with history saved to the DB. Pairing it
    // with the full market value inflated "Ganancia Total" by tens of thousands the
    // moment the first broker (Binance) got its history saved.
    const stats = computePortfolioStats({
      positions: [stockPosition()],
      exchangeRates: { USD: 0.9 },
      historyTotals: { openPositionCost: 100, investedHybrid: 1000 },
    });
    // value 1080 − hybrid 1000 = 80 (NOT 1080 − partial 100 = 980)
    expect(stats.latentGain).toBeCloseTo(80, 10);

    // Without the hybrid value, falls back to the per-position invested chain (900)
    const fallback = computePortfolioStats({
      positions: [stockPosition()],
      exchangeRates: { USD: 0.9 },
      historyTotals: { openPositionCost: 100 },
    });
    expect(fallback.latentGain).toBeCloseTo(180, 10); // 1080 − 900, partial 100 ignored
  });

  it('sums fees from DB fees + DB trade commissions + CSV-only commissions exactly once', () => {
    const stats = computePortfolioStats({
      positions: [],
      exchangeRates: { EUR: 1 },
      historyTotals: { fees: 30, tradeCommissions: 12, tradeCommissionsByBroker: { b1: 12 } },
      importTotals: { commissionsTotal: 5 },
      // Broker b1 is saved AND has commission-column data → embedded JSON must NOT be re-added
      importedTransactionsByBroker: {
        b1: [{ type: 'BUY', comisiones: 12 }],
      },
      savedBrokerIds: new Set(['b1']),
    });
    expect(stats.feesTotal).toBeCloseTo(47, 10); // 30 + 12 + 5, embedded skipped
  });

  it('falls back to embedded JSON comisiones for saved brokers without commission-column data', () => {
    const stats = computePortfolioStats({
      positions: [],
      exchangeRates: { EUR: 1 },
      historyTotals: { fees: 0, tradeCommissions: 0, tradeCommissionsByBroker: {} },
      importTotals: { commissionsTotal: 0 },
      importedTransactionsByBroker: {
        saved: [{ type: 'BUY', comisiones: 3 }, { type: 'SELL', comisiones: 2 }, { type: 'DIVIDEND', comisiones: 99 }],
        unsaved: [{ type: 'BUY', comisiones: 7 }],
      },
      savedBrokerIds: new Set(['saved']),
    });
    // Only BUY/SELL of the saved broker: 3 + 2. The unsaved broker's comisiones flow
    // through importTotals.commissionsTotal instead, and DIVIDEND rows never count.
    expect(stats.feesTotal).toBeCloseTo(5, 10);
  });

  it('uses totalBuyCost (+ unsaved CSV buys) as ROI denominator and falls back to invested', () => {
    const withHistory = computePortfolioStats({
      positions: [stockPosition()],
      exchangeRates: { USD: 1 },
      historyTotals: { totalBuyCost: 2000, realized: 100 },
      importTotals: { csvBuyTotal: 500 },
    });
    expect(withHistory.totalCapitalDeployed).toBeCloseTo(2500, 10);
    expect(withHistory.gainPercent).toBeCloseTo((withHistory.gain / 2500) * 100, 10);

    const noHistory = computePortfolioStats({
      positions: [stockPosition()],
      exchangeRates: { USD: 1 },
    });
    expect(noHistory.totalCapitalDeployed).toBeCloseTo(1000, 10); // invested fallback
  });

  it('builds currency exposure from invested assets only, sorted descending', () => {
    const stats = computePortfolioStats({
      positions: [
        stockPosition(),
        stockPosition({ id: 'p2', asset_id: 'a2', quantity: 2, assets: { ticker: 'SAP', asset_class: 'Stock', currency: 'EUR', current_price: 200 } }),
        cashPosition(),
      ],
      exchangeRates: { USD: 0.9, EUR: 1 },
    });
    expect(stats.exposureData).toEqual([
      { name: 'USD', value: expect.closeTo(1080, 8) },
      { name: 'EUR', value: expect.closeTo(400, 8) },
    ]);
  });

  it('ADDS unsaved-CSV realized/dividends to DB totals (general ↔ broker-tab consistency)', () => {
    // The old `db || csv` fallback dropped unsaved brokers' gains in the general view
    // whenever any broker had DB history — DeGiro tab and General disagreed by thousands.
    const stats = computePortfolioStats({
      positions: [],
      exchangeRates: { EUR: 1 },
      historyTotals: { realized: 100, dividends: 10 },
      importTotals: { salesTotal: 999, salesTotalCsvOnly: 40, dividendsTotal: 999, dividendsTotalCsvOnly: 5 },
    });
    expect(stats.realizedGain).toBeCloseTo(140, 10); // 100 DB + 40 CSV-only (NOT 100, NOT 999)
    expect(stats.dividendsGain).toBeCloseTo(15, 10);
  });

  it('total gain combines latent + realized + dividends − fees', () => {
    const stats = computePortfolioStats({
      positions: [stockPosition({ _prefCostTotal: 900 })],
      exchangeRates: { USD: 0.9 },
      historyTotals: { realized: 50, dividends: 20, fees: 10, openPositionCost: 900 },
      importTotals: {},
    });
    // latent = 1080 − 900 = 180; gain = 180 + 50 + 20 − 10
    expect(stats.gain).toBeCloseTo(240, 10);
  });
});

describe('computeEmbeddedCommissionsFallback', () => {
  const base = {
    importedTransactionsByBroker: {
      b1: [{ type: 'BUY', comisiones: 4 }, { type: 'SELL', comisiones: 6 }],
      b2: [{ type: 'BUY', comisiones: 100 }],
    },
    savedBrokerIds: new Set(['b1', 'b2']),
    isSavedByBroker: {},
    tradeCommissionsByBroker: {},
    selectedBrokerId: 'general',
    eurRate: 1,
  };

  it('counts BUY/SELL comisiones of saved brokers', () => {
    expect(computeEmbeddedCommissionsFallback(base)).toBeCloseTo(110, 10);
  });

  it('skips brokers whose commission column is already populated in DB', () => {
    expect(computeEmbeddedCommissionsFallback({
      ...base,
      tradeCommissionsByBroker: { b2: 100 },
    })).toBeCloseTo(10, 10);
  });

  it('skips unsaved brokers (their comisiones flow through processedImportData)', () => {
    expect(computeEmbeddedCommissionsFallback({
      ...base,
      savedBrokerIds: new Set(['b1']),
    })).toBeCloseTo(10, 10);
  });

  it('scopes to the selected broker in single-broker view', () => {
    expect(computeEmbeddedCommissionsFallback({
      ...base,
      selectedBrokerId: 'b1',
    })).toBeCloseTo(10, 10);
  });

  it('converts EUR-invoiced commissions with eurRate (preferred currency ≠ EUR)', () => {
    expect(computeEmbeddedCommissionsFallback({
      ...base,
      eurRate: 1.1,
    })).toBeCloseTo(121, 10);
  });
});

describe('computeInvestedMarketValue — the single definition of "Valor en Mercado"', () => {
  it('returns exactly the investedValue computePortfolioStats reports', () => {
    // Arrange — the brokers screen and the Dashboard must not just "agree": they
    // run the same function. This pins the extraction.
    const positions = [stockPosition(), cashPosition()];
    const exchangeRates = { USD: 0.9, EUR: 1 };

    // Act
    const shared = computeInvestedMarketValue(positions, exchangeRates).toNumber();
    const stats = computePortfolioStats({ positions, exchangeRates });

    // Assert
    expect(shared).toBeCloseTo(stats.investedValue, 10);
    expect(shared).toBeCloseTo(1080, 10);
  });

  it('excludes cash positions (quantity IS the amount, never × price)', () => {
    expect(computeInvestedMarketValue([cashPosition()], { EUR: 1 }).toNumber()).toBe(0);
  });

  it('keeps legacy liquidity rows out of invested value (regression guard)', () => {
    const positions = [
      {
        id: 'p-stock',
        quantity: 10,
        entry_price: 100,
        assets: { ticker: 'AAPL', asset_class: 'Stock', currency: 'EUR', current_price: 150 },
      },
      { id: 'p-cash-1', quantity: 5000, assets: { ticker: 'CASH_EUR', asset_class: 'Cash', currency: 'EUR', current_price: 1 } },
      { id: 'p-cash-2', quantity: 5000, assets: { ticker: 'CASH_NET_EUR', asset_class: 'Cash', currency: 'EUR', current_price: 1 } },
      { id: 'p-cash-3', quantity: 5000, assets: { ticker: 'CASH', asset_class: 'Cash', currency: 'EUR', current_price: 1 } },
      { id: 'p-cash-4', quantity: 5000, assets: { ticker: 'CASH_- (-)', asset_class: 'Cash', currency: 'EUR', current_price: 1 } },
      { id: 'p-cash-5', quantity: 5000, assets: { ticker: 'CASH_USD (USD)', asset_class: 'Cash', currency: null, current_price: 1 } },
      { id: 'p-cash-6', quantity: 5000, assets: { ticker: 'EUR', asset_class: 'Cash', currency: 'EUR', current_price: 1 } },
    ];
    expect(computeInvestedMarketValue(positions, { EUR: 1, USD: 1 }).toNumber()).toBe(1500);
  });

  it('values merged rows component by component, each in its own currency', () => {
    const merged = stockPosition({
      quantity: 15,
      _valueComponents: [
        { qty: 10, price: 120, cur: 'USD', ticker: 'AMZN' },
        { qty: 5, price: 110, cur: 'EUR', ticker: 'AMZ.DE' },
      ],
    });
    expect(computeInvestedMarketValue([merged], { USD: 0.9, EUR: 1 }).toNumber())
      .toBeCloseTo(1630, 10);
  });

  it('keeps a legitimate 0 price at 0 instead of falling back to entry_price', () => {
    const worthless = stockPosition({ assets: { ticker: 'X', currency: 'USD', current_price: 0 } });
    expect(computeInvestedMarketValue([worthless], { USD: 0.9 }).toNumber()).toBe(0);
  });

  it('falls back to entry_price when the asset has no current_price', () => {
    const noPrice = stockPosition({ assets: { ticker: 'X', currency: 'USD', current_price: null } });
    // 10 × 100 (entry) × 0.9
    expect(computeInvestedMarketValue([noPrice], { USD: 0.9 }).toNumber()).toBeCloseTo(900, 10);
  });
});

describe('Dashboard ↔ brokers parity on a quote whose currency ≠ the stored one', () => {
  // GOOGL bought on DeGiro settles in EUR but Yahoo quotes it in USD. The Dashboard
  // used to multiply the RAW USD price by the position's EUR rate (1) while the
  // brokers screen converted the quote first — the two screens then differed by the
  // exchange rate on every such position, and the Dashboard wrote its unconverted
  // price into assets.current_price, dragging the brokers screen along.
  const rates = { USD: 0.86, EUR: 1 }; // preferred currency: EUR
  const rawQuote = 200; // USD
  const eurPosition = {
    id: 'p1', asset_id: 'a1', quantity: 10, entry_price: 150,
    assets: { ticker: 'GOOGL', asset_class: 'Stock', currency: 'EUR', current_price: 150 },
  };

  it('values the position with the quote converted into the stored currency', () => {
    const priced = [{
      ...eurPosition,
      assets: {
        ...eurPosition.assets,
        current_price: convertQuotePrice(rawQuote, 'USD', 'EUR', rates),
      },
    }];

    // 10 × (200 × 0.86) EUR × rate 1 = 1720 — NOT 10 × 200 × 1 = 2000
    expect(computeInvestedMarketValue(priced, rates).toNumber()).toBeCloseTo(1720, 10);
  });

  it('the unconverted path (the bug) overstates the value by 1/FX', () => {
    const buggy = [{ ...eurPosition, assets: { ...eurPosition.assets, current_price: rawQuote } }];
    const buggyValue = computeInvestedMarketValue(buggy, rates).toNumber();
    expect(buggyValue).toBeCloseTo(2000, 10);
    expect(buggyValue / 1720).toBeCloseTo(1 / 0.86, 6);
  });
});
