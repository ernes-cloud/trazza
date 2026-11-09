import { describe, it, expect } from 'vitest';
import { computePortfolioScore } from './portfolioScoreService';

const pos = (ticker, qty, price) => ({
  quantity: qty,
  entry_price: price,
  assets: { ticker, currency: 'EUR', current_price: price, asset_class: 'Stock' },
});

const base = {
  positions: [pos('AAPL', 10, 100), pos('MSFT', 10, 100), pos('GOOGL', 10, 100), pos('AMZN', 10, 100)],
  totalWealth: 4400,
  totalInvested: 4000,
  totalBuyCost: 4000,
  cashPosition: 400,
  totalDividends: 0,
  totalFees: 20,
  totalGainPct: 10,
  portfolioStartDate: '2024-01-01',
};

describe('computePortfolioScore — cuatro pilares sobre 100', () => {
  // Quitar "Ingresos pasivos" sin repartir sus 15 puntos habría dejado el máximo
  // en 85: el número grande y las barras dejarían de cuadrar.
  it('los máximos de las barras suman exactamente 100', () => {
    const { breakdown } = computePortfolioScore(base);
    const maxes = [
      breakdown.diversification.max,
      breakdown.performance.max,
      breakdown.costs.max,
      breakdown.liquidity.max,
    ];
    expect(maxes).toEqual([30, 30, 20, 20]);
    expect(maxes.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('la suma de las barras ES el total que se pinta', () => {
    const { total, breakdown } = computePortfolioScore(base);
    const sum = breakdown.diversification.score + breakdown.performance.score
      + breakdown.costs.score + breakdown.liquidity.score;
    expect(sum).toBeCloseTo(total, 6);
  });

  it('ninguna barra se pasa de su máximo, y el total no pasa de 100', () => {
    const { total, breakdown } = computePortfolioScore({
      ...base, totalGainPct: 500, totalFees: 0, cashPosition: 440, totalDividends: 9999,
    });
    for (const k of ['diversification', 'performance', 'costs', 'liquidity']) {
      expect(breakdown[k].score).toBeLessThanOrEqual(breakdown[k].max + 1e-9);
      expect(breakdown[k].score).toBeGreaterThanOrEqual(0);
    }
    expect(total).toBeLessThanOrEqual(100);
  });

  // El yield sigue viajando en el payload: el prompt de la IA lo usa para
  // reconocer una cartera de crecimiento. Lo que NO puede traer es puntuación.
  it('el yield de dividendos sobrevive como contexto, sin puntuar', () => {
    const conDividendos = computePortfolioScore({ ...base, totalDividends: 200 });
    const sinDividendos = computePortfolioScore({ ...base, totalDividends: 0 });
    expect(conDividendos.breakdown.income.dividendYield).toBeGreaterThan(0);
    expect(conDividendos.breakdown.income.score).toBeUndefined();
    expect(conDividendos.breakdown.income.max).toBeUndefined();
    // Cobrar dividendos ya no sube (ni bajar de ellos baja) la puntuación.
    expect(conDividendos.total).toBeCloseTo(sinDividendos.total, 6);
  });

  it('excluye ticker CASH (sin sufijo) del cómputo invertido', () => {
    const out = computePortfolioScore({
      ...base,
      positions: [
        pos('AAPL', 10, 100),
        {
          quantity: 500,
          entry_price: 1,
          assets: { ticker: 'CASH', currency: 'USD', current_price: 1, asset_class: 'Stock' },
        },
      ],
    });
    expect(out.nPositions).toBe(1);
  });
});
