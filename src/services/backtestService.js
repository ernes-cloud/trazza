import Decimal from 'decimal.js';

const D = (v) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return new Decimal(Number.isFinite(n) ? n : 0);
};

/**
 * Backtest / "time machine" — pure computation over historical price series.
 *
 * Given per-ticker series (from yahooFinanceService.getHistoricalData, which
 * uses adjusted close → dividends/splits included) and optional weights,
 * simulates a portfolio over the common history window:
 *
 *   - Dates are aligned by INTERSECTION: the window starts at the first date
 *     every asset has data for (the youngest asset bounds the comparison).
 *   - Each asset is rebased to its close on the first common date; its line is
 *     the % return from that day.
 *   - The portfolio line is a strategy index that starts at 1 and applies the
 *     chosen rebalancing policy ('none' = classic buy & hold, which equals
 *     Σ weight_i × growth_i; 'quarterly'/'annual' reset the allocation to the
 *     target weights on the first data point of each new period).
 *   - Optionally simulates money: an initial lump sum plus a monthly
 *     contribution (DCA, invested at target weights on the first data point of
 *     each new calendar month), with the same rebalancing policy. This powers
 *     the "final value / invested / profit" stats without polluting the %
 *     lines (which stay time-weighted and comparable).
 *
 * Order of operations within a date: growth → contribution → rebalance.
 *
 * Limitation (by design, documented in the UI): each series is in the asset's
 * native quote currency — FX effects between assets are not modelled.
 *
 * Precision boundary: the MONEY simulation (contributions, final value, profit)
 * uses decimal.js; the % index and its statistics (CAGR, volatility, drawdown)
 * stay in floats — they are estimates over price ratios (pow/sqrt), where
 * decimal arithmetic adds cost but no accuracy that survives the model error.
 *
 * @param {Object<string, Array<{time: string, close: number}>>} seriesByTicker
 * @param {Object<string, number>} [weights] any positive numbers; normalized.
 *        Missing/invalid/all-zero → equal weights.
 * @param {{ rebalance?: 'none'|'quarterly'|'annual', initial?: number, monthly?: number, cash?: number }} [options]
 *        `cash` = a flat cash sleeve on the same weight scale as the assets; it
 *        stays at growth factor 1, diluting return, volatility and drawdown.
 * @returns {{
 *   points: Array<{date: string, portfolio: number}>,  // + one key per ticker (%)
 *   startDate: string|null,
 *   endDate: string|null,
 *   stats: {
 *     portfolio: { totalReturn: number|null, cagr: number|null,
 *                  maxDrawdown: number|null, volatility: number|null },
 *     perAsset: Object<string, { totalReturn: number, weightPct: number }>,
 *     money: { finalValue: number, invested: number, profit: number, profitPct: number|null }|null,
 *   },
 * }}
 */
/**
 * Rewrites a list of weights so they sum to EXACTLY 100 (one-decimal precision),
 * keeping their relative proportions — the "Ajustar a 100%" convenience. All
 * zero/invalid → an equal split that also sums to 100. The rounding remainder
 * lands on the largest weight so the visible total is always 100.
 * @param {Array<number|string>} weights
 * @returns {number[]}
 */
export function scaleWeightsToHundred(weights = []) {
  const n = weights.length;
  if (n === 0) return [];
  const nums = weights.map((w) => {
    const v = typeof w === 'string' ? parseFloat(w) : w;
    return Number.isFinite(v) && v > 0 ? v : 0;
  });
  const sum = nums.reduce((s, w) => s + w, 0);

  if (sum <= 0) {
    const base = Math.floor((100 / n) * 10) / 10;
    const out = Array(n).fill(base);
    let rem = Math.round((100 - base * n) * 10) / 10;
    for (let i = 0; i < n && rem > 0; i++) { out[i] = Math.round((out[i] + 0.1) * 10) / 10; rem = Math.round((rem - 0.1) * 10) / 10; }
    return out;
  }

  const rounded = nums.map((w) => Math.round((w / sum) * 1000) / 10);
  const diff = Math.round((100 - rounded.reduce((s, v) => s + v, 0)) * 10) / 10;
  if (diff !== 0) {
    const maxIdx = rounded.indexOf(Math.max(...rounded));
    rounded[maxIdx] = Math.round((rounded[maxIdx] + diff) * 10) / 10;
  }
  return rounded;
}

export function computeBacktest(seriesByTicker, weights = {}, options = {}) {
  const { rebalance = 'none', initial = 0, monthly = 0, cash = 0 } = options;

  const empty = {
    points: [],
    startDate: null,
    endDate: null,
    stats: {
      portfolio: { totalReturn: null, cagr: null, maxDrawdown: null, volatility: null },
      perAsset: {},
      cashWeightPct: 0,
      money: null,
    },
  };

  const tickers = Object.keys(seriesByTicker || {});
  if (tickers.length === 0) return empty;

  // date → close per ticker (ignore null/undefined closes)
  const closeMaps = {};
  for (const ticker of tickers) {
    const map = new Map();
    for (const point of seriesByTicker[ticker] || []) {
      if (point && point.time && point.close != null) map.set(point.time, point.close);
    }
    if (map.size === 0) return empty; // one empty series kills the intersection
    closeMaps[ticker] = map;
  }

  // Common dates across ALL tickers, ascending
  const commonDates = [...closeMaps[tickers[0]].keys()]
    .filter(date => tickers.every(tk => closeMaps[tk].has(date)))
    .sort();

  // The base date must have a usable (non-zero) close for every asset
  let baseIdx = commonDates.findIndex(date => tickers.every(tk => closeMaps[tk].get(date) > 0));
  if (baseIdx === -1) return empty;
  const dates = commonDates.slice(baseIdx);
  if (dates.length === 0) return empty;

  // Cash sleeve: a flat component (growth factor 1 every period) that dilutes
  // the portfolio's return AND its volatility/drawdown. It shares the same weight
  // scale as the assets and enters the normalization denominator.
  const cashRaw = Math.max(0, Number(cash) || 0);

  // Normalized weights (equal split among ASSETS only when EVERYTHING is zero)
  const rawWeights = tickers.map(tk => {
    const w = Number(weights?.[tk]);
    return Number.isFinite(w) && w > 0 ? w : 0;
  });
  const weightSum = rawWeights.reduce((s, w) => s + w, 0) + cashRaw;
  const normWeights = weightSum > 0
    ? rawWeights.map(w => w / weightSum)
    : tickers.map(() => 1 / tickers.length);
  const normCash = weightSum > 0 ? cashRaw / weightSum : 0;

  const baseDate = dates[0];
  const bases = tickers.map(tk => closeMaps[tk].get(baseDate));

  // ── Strategy index (starts at 1) + optional money simulation ───────────────
  const periodOf = (dateStr) => {
    const d = new Date(dateStr);
    if (rebalance === 'annual') return d.getUTCFullYear();
    if (rebalance === 'quarterly') return d.getUTCFullYear() * 4 + Math.floor(d.getUTCMonth() / 3);
    return 0; // 'none': the period never changes
  };
  const monthOf = (dateStr) => {
    const d = new Date(dateStr);
    return d.getUTCFullYear() * 12 + d.getUTCMonth();
  };

  const simulateMoney = (parseFloat(initial) || 0) > 0 || (parseFloat(monthly) || 0) > 0;
  const initialAmount = Decimal.max(0, D(initial));
  const monthlyAmount = Decimal.max(0, D(monthly));

  let holdings = normWeights.slice();                       // asset index units
  let cashHolding = normCash;                               // flat sleeve; Σ(holdings)+cashHolding = 1
  let moneyHoldings = normWeights.map(w => initialAmount.times(w));
  let cashMoney = initialAmount.times(normCash);
  let invested = initialAmount;
  const indexSeries = [1];

  for (let i = 1; i < dates.length; i++) {
    const factors = tickers.map((tk) => {
      const prev = closeMaps[tk].get(dates[i - 1]);
      return prev > 0 ? closeMaps[tk].get(dates[i]) / prev : 1;
    });
    holdings = holdings.map((h, k) => h * factors[k]);
    // cashHolding stays flat (growth factor 1)
    const total = holdings.reduce((s, h) => s + h, 0) + cashHolding;
    indexSeries.push(total);

    const periodChanged = rebalance !== 'none' && periodOf(dates[i]) !== periodOf(dates[i - 1]);
    if (periodChanged) {
      holdings = normWeights.map(w => w * total);
      cashHolding = normCash * total;
    }

    if (simulateMoney) {
      moneyHoldings = moneyHoldings.map((h, k) => h.times(D(factors[k])));
      // cashMoney stays flat
      if (monthlyAmount.gt(0) && monthOf(dates[i]) !== monthOf(dates[i - 1])) {
        moneyHoldings = moneyHoldings.map((h, k) => h.plus(monthlyAmount.times(normWeights[k])));
        cashMoney = cashMoney.plus(monthlyAmount.times(normCash));
        invested = invested.plus(monthlyAmount);
      }
      if (periodChanged) {
        const moneyTotal = moneyHoldings.reduce((s, h) => s.plus(h), new Decimal(0)).plus(cashMoney);
        moneyHoldings = normWeights.map(w => moneyTotal.times(w));
        cashMoney = moneyTotal.times(normCash);
      }
    }
  }

  const points = dates.map((date, j) => {
    const point = { date };
    tickers.forEach((tk, i) => {
      point[tk] = (closeMaps[tk].get(date) / bases[i] - 1) * 100;
    });
    point.portfolio = (indexSeries[j] - 1) * 100;
    return point;
  });

  const last = points[points.length - 1];

  // CAGR over the exact window; only meaningful with ≥ 6 months of history
  // (same rule as the portfolio CAGR tile — never annualize short windows).
  const years = (new Date(dates[dates.length - 1]) - new Date(baseDate)) / (365.25 * 24 * 3600 * 1000);
  const cagr = years >= 0.5
    ? (Math.pow(1 + last.portfolio / 100, 1 / years) - 1) * 100
    : null;

  // Max drawdown: worst peak-to-trough of the strategy index
  let maxDrawdown = null;
  if (indexSeries.length >= 2) {
    let peak = indexSeries[0];
    let worst = 0;
    for (const v of indexSeries) {
      if (v > peak) peak = v;
      else if (peak > 0) worst = Math.max(worst, (peak - v) / peak);
    }
    maxDrawdown = worst * 100;
  }

  // Annualized volatility from period returns; the periods-per-year factor is
  // inferred from the median spacing between data points (1d/1wk/1mo series).
  let volatility = null;
  if (indexSeries.length >= 3) {
    const returns = [];
    for (let i = 1; i < indexSeries.length; i++) {
      if (indexSeries[i - 1] > 0) returns.push(indexSeries[i] / indexSeries[i - 1] - 1);
    }
    if (returns.length >= 2) {
      const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
      const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
      const gaps = [];
      for (let i = 1; i < dates.length; i++) {
        gaps.push((new Date(dates[i]) - new Date(dates[i - 1])) / (24 * 3600 * 1000));
      }
      gaps.sort((a, b) => a - b);
      const medianGap = gaps[Math.floor(gaps.length / 2)] || 1;
      const periodsPerYear = Math.min(366, Math.max(1, 365.25 / medianGap));
      volatility = Math.sqrt(variance) * Math.sqrt(periodsPerYear) * 100;
    }
  }

  const perAsset = {};
  tickers.forEach((tk, i) => {
    perAsset[tk] = { totalReturn: last[tk], weightPct: normWeights[i] * 100 };
  });

  const finalValue = moneyHoldings.reduce((s, h) => s.plus(h), new Decimal(0)).plus(cashMoney);
  const money = simulateMoney
    ? {
        finalValue: finalValue.toNumber(),
        invested: invested.toNumber(),
        profit: finalValue.minus(invested).toNumber(),
        profitPct: invested.gt(0) ? finalValue.div(invested).minus(1).times(100).toNumber() : null,
      }
    : null;

  return {
    points,
    startDate: baseDate,
    endDate: dates[dates.length - 1],
    stats: { portfolio: { totalReturn: last.portfolio, cagr, maxDrawdown, volatility }, perAsset, cashWeightPct: normCash * 100, money },
  };
}
