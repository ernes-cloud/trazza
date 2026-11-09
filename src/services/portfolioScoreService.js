import Decimal from 'decimal.js';
import { isHeldInvestedPosition } from '@/lib/positionKind';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

/**
 * Computes a 0–100 portfolio health score using four algorithmic sub-scores.
 *
 * "Ingresos pasivos" dejó de ser un pilar el 2026-09-11 (decisión del owner): una
 * cartera de crecimiento sin dividendos perdía hasta 15 puntos por una elección
 * de estrategia, no por un defecto. Sus 15 puntos se repartieron entre los que
 * quedan — 30/30/20/20 — para que la puntuación siga siendo sobre 100 y las
 * barras SIGAN SUMANDO EL TOTAL; dejarla en 85 habría hecho que las partes no
 * cuadrasen con el número grande. El yield se sigue calculando y viaja en el
 * payload como CONTEXTO para el análisis con IA (que distingue perfil growth por
 * él), simplemente ya no puntúa.
 */
const WEIGHTS = { diversification: 30, performance: 30, costs: 20, liquidity: 20 };
const rescale = (score, oldMax, newMax) => score.div(oldMax).times(newMax);
export function computePortfolioScore({
  positions = [],
  totalWealth = 0,
  totalInvested = 0,
  totalBuyCost = 0,
  cashPosition = 0,
  totalDividends = 0,
  totalFees = 0,
  totalGainPct = 0,
  portfolioStartDate = null,
  exchangeRates = {},
  currency = 'EUR',
}) {
  const investedPositions = positions.filter(isHeldInvestedPosition);

  // Portfolio age in years — used to annualise cumulative dividends and fees.
  // Floored at 1 so portfolios < 1 year old use raw totals (no upward extrapolation).
  const portfolioAgeYears = portfolioStartDate
    ? Math.max(1, (Date.now() - new Date(portfolioStartDate).getTime()) / (365.25 * 24 * 3600 * 1000))
    : 1;

  // All-time buy cost is the correct denominator for fee ratio and dividend yield.
  // Falls back to totalInvested (open position cost) when totalBuyCost not available.
  // Zero base → both ratios return 0 (widget shows N/A implicitly via score=0).
  const base = new Decimal(
    totalBuyCost > 0 ? totalBuyCost : (totalInvested > 0 ? totalInvested : 0)
  );
  const hasBase = base.gt(0);

  // ── 1. Diversification (25 pts) ─────────────────────────────────────────────
  // HHI = Σ(wi²), range [1/n, 1].
  //   HHI = 1  → 1 position (maximally concentrated) → 0 pts
  //   HHI → 0  → infinite equally weighted positions  → 25 pts
  // Using raw HHI directly avoids the n=1 edge case where the
  // per-n normalisation collapses to hhiRange=0 and returns 25/25 on a
  // single-position portfolio.
  const investedValue = new Decimal(totalWealth).minus(cashPosition);
  const totalForHHI = investedValue.gt(0) ? investedValue : new Decimal(1);

  const hhi = investedPositions.reduce((sum, p) => {
    const cur = p.assets?.currency || currency;
    const rate = cur === currency ? 1 : (exchangeRates[cur] || 1);
    // Prefer current_price when it is a valid positive number; fall back to entry_price.
    const rawPrice = p.assets?.current_price;
    const price = (rawPrice != null && rawPrice > 0)
      ? parseFloat(rawPrice)
      : parseFloat(p.entry_price || 0);
    const qty = parseFloat(p.quantity || 0);
    const w = new Decimal(qty).times(price).times(rate).div(totalForHHI);
    return sum.plus(w.pow(2));
  }, new Decimal(0));

  // score = (1 - HHI) × 25  →  0 pts when HHI=1, 25 pts when HHI≈0
  const diversificationScore = investedPositions.length === 0
    ? new Decimal(0)
    : new Decimal(1).minus(hhi).times(25).clampedTo(0, 25);

  // ── 2. Performance (25 pts) ──────────────────────────────────────────────────
  // Map totalGainPct ∈ [−30, +30] → [0, 25]
  const gainPct = new Decimal(totalGainPct).clampedTo(-30, 30);
  const performanceScore = gainPct.plus(30).div(60).times(25).clampedTo(0, 25);

  // ── 3. Cost control (20 pts) ─────────────────────────────────────────────────
  // Annualised fee ratio = (totalFees / portfolioAgeYears) / totalBuyCost × 100.
  // Using annualised fees avoids penalising long-running portfolios for cumulative totals.
  const annualFees = new Decimal(totalFees).div(portfolioAgeYears);
  const feeRatio = hasBase ? annualFees.div(base).times(100) : new Decimal(0);
  const costScore = new Decimal(20).minus(feeRatio.times(10)).clampedTo(0, 20);

  // ── 4. Liquidity (15 pts) ────────────────────────────────────────────────────
  // Optimal 5–15% cash = 15 pts; interpolate outside that band.
  const totalWealthD = new Decimal(totalWealth > 0 ? totalWealth : 1);
  const cashPct = new Decimal(cashPosition).div(totalWealthD).times(100);

  let liquidityScore;
  if (cashPct.gte(5) && cashPct.lte(15)) {
    liquidityScore = new Decimal(15);
  } else if (cashPct.lt(5)) {
    liquidityScore = cashPct.div(5).times(10).plus(5).clampedTo(0, 15);
  } else if (cashPct.lte(40)) {
    liquidityScore = new Decimal(15).minus(cashPct.minus(15).div(25).times(13)).clampedTo(2, 15);
  } else {
    liquidityScore = new Decimal(2);
  }

  // ── Dividend yield — contexto, ya NO puntúa ─────────────────────────────────
  // Annualised dividend yield = (totalDividends / portfolioAgeYears) / totalBuyCost × 100.
  const annualDividends = new Decimal(totalDividends).div(portfolioAgeYears);
  const dividendYield = hasBase ? annualDividends.div(base).times(100) : new Decimal(0);

  // ── Total ────────────────────────────────────────────────────────────────────
  // Cada pilar se reescala de su máximo propio al peso nuevo, así que la suma de
  // las barras es EXACTAMENTE el número grande.
  const diversificationFinal = rescale(diversificationScore, 25, WEIGHTS.diversification);
  const performanceFinal     = rescale(performanceScore,     25, WEIGHTS.performance);
  const costFinal            = rescale(costScore,            20, WEIGHTS.costs);
  const liquidityFinal       = rescale(liquidityScore,       15, WEIGHTS.liquidity);

  const total = diversificationFinal
    .plus(performanceFinal)
    .plus(costFinal)
    .plus(liquidityFinal)
    .clampedTo(0, 100);

  return {
    total: total.toNumber(),
    breakdown: {
      diversification: {
        score: diversificationFinal.toNumber(),
        max: WEIGHTS.diversification,
        hhi: hhi.toNumber(),
      },
      performance: {
        score: performanceFinal.toNumber(),
        max: WEIGHTS.performance,
        gainPct: totalGainPct,
      },
      costs: {
        score: costFinal.toNumber(),
        max: WEIGHTS.costs,
        feeRatio: feeRatio.toNumber(),
      },
      liquidity: {
        score: liquidityFinal.toNumber(),
        max: WEIGHTS.liquidity,
        cashPct: cashPct.toNumber(),
      },
      // Sin `score` ni `max` a propósito: ya no es un pilar puntuable, solo el
      // dato que el prompt de la IA usa para reconocer una cartera de crecimiento.
      income: {
        dividendYield: dividendYield.toNumber(),
      },
    },
    nPositions: investedPositions.length,
  };
}

export function getScoreLabel(score) {
  if (score >= 91) return { key: 'excellent', color: '#10b981' };
  if (score >= 76) return { key: 'good',      color: '#34d399' };
  if (score >= 61) return { key: 'moderate',  color: '#f59e0b' };
  if (score >= 41) return { key: 'improvable',color: '#f97316' };
  return               { key: 'at_risk',   color: '#ef4444' };
}
