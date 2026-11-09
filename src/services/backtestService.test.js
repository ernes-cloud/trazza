import { describe, it, expect } from 'vitest';
import { computeBacktest, scaleWeightsToHundred } from './backtestService';

describe('scaleWeightsToHundred', () => {
  const sum = (a) => Math.round(a.reduce((s, v) => s + v, 0) * 10) / 10;

  it('scales proportionally to sum exactly 100', () => {
    expect(scaleWeightsToHundred([10, 10])).toEqual([50, 50]);
    expect(sum(scaleWeightsToHundred([3, 1]))).toBe(100);
    expect(scaleWeightsToHundred([3, 1])).toEqual([75, 25]);
  });

  it('keeps a total of 100 even when rounding does not divide evenly', () => {
    const out = scaleWeightsToHundred([1, 1, 1]);
    expect(sum(out)).toBe(100);
    expect(out.length).toBe(3);
  });

  it('all-zero / invalid → an equal split summing 100', () => {
    expect(sum(scaleWeightsToHundred([0, 0, 0, 0]))).toBe(100);
    expect(sum(scaleWeightsToHundred(['x', 0]))).toBe(100);
  });

  it('empty list → empty', () => {
    expect(scaleWeightsToHundred([])).toEqual([]);
  });

  it('ignores negatives, scales the rest to 100', () => {
    const out = scaleWeightsToHundred([-5, 10, 30]);
    expect(sum(out)).toBe(100);
    expect(out[0]).toBe(0);
  });
});

// Helper: build a daily series from [date, close] pairs
const series = (pairs) => pairs.map(([time, close]) => ({ time, close }));

describe('computeBacktest — un solo activo', () => {
  it('un activo que se duplica → cartera +100%', () => {
    // Arrange
    const input = {
      AAPL: series([['2024-01-01', 100], ['2024-06-01', 150], ['2025-01-01', 200]]),
    };

    // Act
    const result = computeBacktest(input);

    // Assert
    expect(result.points).toHaveLength(3);
    expect(result.points[0].portfolio).toBeCloseTo(0, 6);
    expect(result.points[2].portfolio).toBeCloseTo(100, 6);
    expect(result.points[2].AAPL).toBeCloseTo(100, 6);
    expect(result.stats.portfolio.totalReturn).toBeCloseTo(100, 6);
    expect(result.stats.perAsset.AAPL.totalReturn).toBeCloseTo(100, 6);
    expect(result.stats.perAsset.AAPL.weightPct).toBeCloseTo(100, 6);
  });
});

describe('computeBacktest — cartera ponderada (buy & hold)', () => {
  const A = series([['2024-01-01', 10], ['2025-01-01', 20]]); // +100%
  const B = series([['2024-01-01', 50], ['2025-01-01', 50]]); // 0%

  it('pesos iguales por defecto: +100% y 0% → +50%', () => {
    const result = computeBacktest({ A, B });
    expect(result.points[1].portfolio).toBeCloseTo(50, 6);
  });

  it('pesos 75/25 → +75%', () => {
    const result = computeBacktest({ A, B }, { A: 75, B: 25 });
    expect(result.points[1].portfolio).toBeCloseTo(75, 6);
    expect(result.stats.perAsset.A.weightPct).toBeCloseTo(75, 6);
    expect(result.stats.perAsset.B.weightPct).toBeCloseTo(25, 6);
  });

  it('los pesos se normalizan (3 y 1 → 75%/25%)', () => {
    const result = computeBacktest({ A, B }, { A: 3, B: 1 });
    expect(result.points[1].portfolio).toBeCloseTo(75, 6);
  });

  it('pesos inválidos (0 o ausentes) → pesos iguales', () => {
    const result = computeBacktest({ A, B }, { A: 0, B: 0 });
    expect(result.points[1].portfolio).toBeCloseTo(50, 6);
  });
});

describe('computeBacktest — liquidez (cash sleeve)', () => {
  const A = series([['2024-01-01', 100], ['2025-01-01', 200]]); // +100%
  const B = series([['2024-01-01', 100], ['2025-01-01', 200]]); // +100%

  it('50% liquidez sobre un +100% → +50% (la liquidez no rinde)', () => {
    // A y B pesan 1 cada uno (Σ=2); liquidez 2 → mitad cartera en efectivo
    const result = computeBacktest({ A, B }, { A: 1, B: 1 }, { cash: 2 });
    expect(result.points[1].portfolio).toBeCloseTo(50, 6);
    expect(result.stats.cashWeightPct).toBeCloseTo(50, 6);
    // el % efectivo de cada activo también refleja la dilución
    expect(result.stats.perAsset.A.weightPct).toBeCloseTo(25, 6);
    expect(result.stats.perAsset.B.weightPct).toBeCloseTo(25, 6);
  });

  it('la liquidez diluye el valor final del dinero', () => {
    // inicial 100, 50% liquidez, activos que se duplican → 50 crece a 100, 50 queda → 150
    const result = computeBacktest({ A, B }, { A: 1, B: 1 }, { cash: 2, initial: 100 });
    expect(result.stats.money.finalValue).toBeCloseTo(150, 4);
    expect(result.stats.money.invested).toBeCloseTo(100, 4);
    expect(result.stats.money.profit).toBeCloseTo(50, 4);
    expect(result.stats.money.profitPct).toBeCloseTo(50, 4);
  });

  it('100% liquidez → cartera plana en 0% aunque los activos suban', () => {
    const result = computeBacktest({ A, B }, { A: 0, B: 0 }, { cash: 10 });
    expect(result.points[1].portfolio).toBeCloseTo(0, 6);
    expect(result.stats.cashWeightPct).toBeCloseTo(100, 6);
    expect(result.stats.portfolio.maxDrawdown).toBeCloseTo(0, 6);
  });

  it('cash = 0 es idéntico a no pasar liquidez (regresión)', () => {
    const withZero = computeBacktest({ A, B }, { A: 1, B: 1 }, { cash: 0 });
    const without = computeBacktest({ A, B }, { A: 1, B: 1 });
    expect(withZero.points[1].portfolio).toBeCloseTo(without.points[1].portfolio, 9);
    expect(withZero.stats.cashWeightPct).toBe(0);
  });
});

describe('computeBacktest — alineación de fechas (histórico común)', () => {
  it('la ventana empieza en la primera fecha común (activo más joven)', () => {
    const OLD = series([['2020-01-01', 100], ['2024-01-01', 400], ['2025-01-01', 800]]);
    const NEW = series([['2024-01-01', 10], ['2025-01-01', 15]]);

    const result = computeBacktest({ OLD, NEW });

    // Common window: 2024-01-01 → 2025-01-01. OLD rebased: 400→800 = +100%.
    expect(result.startDate).toBe('2024-01-01');
    expect(result.points).toHaveLength(2);
    expect(result.points[1].OLD).toBeCloseTo(100, 6);
    expect(result.points[1].NEW).toBeCloseTo(50, 6);
    expect(result.points[1].portfolio).toBeCloseTo(75, 6);
  });

  it('fechas no comunes se descartan', () => {
    const A = series([['2024-01-01', 10], ['2024-01-02', 11], ['2024-01-03', 12]]);
    const B = series([['2024-01-01', 5], ['2024-01-03', 6]]);
    const result = computeBacktest({ A, B });
    expect(result.points.map(p => p.date)).toEqual(['2024-01-01', '2024-01-03']);
  });
});

describe('computeBacktest — CAGR y ventanas', () => {
  it('2 años con +21% total → CAGR ≈ 10%', () => {
    const A = series([['2023-01-01', 100], ['2025-01-01', 121]]);
    const result = computeBacktest({ A });
    expect(result.stats.portfolio.cagr).toBeCloseTo(10, 1);
  });

  it('ventana < 6 meses → cagr null (regla del proyecto)', () => {
    const A = series([['2024-01-01', 100], ['2024-03-01', 120]]);
    const result = computeBacktest({ A });
    expect(result.stats.portfolio.cagr).toBeNull();
  });
});

describe('computeBacktest — rebalanceo periódico', () => {
  // A se duplica cada año, B plano. Buy & hold: 0.5×4 + 0.5×1 = 2.5 → +150%.
  // Rebalanceo anual: tras el año 1 (G=1.5) se vuelve a 50/50 → año 2:
  // 0.75×2 + 0.75×1 = 2.25 → +125%.
  const A = series([['2024-01-01', 100], ['2025-01-01', 200], ['2026-01-01', 400]]);
  const B = series([['2024-01-01', 50], ['2025-01-01', 50], ['2026-01-01', 50]]);

  it("'none' mantiene el buy & hold clásico", () => {
    const result = computeBacktest({ A, B }, {}, { rebalance: 'none' });
    expect(result.stats.portfolio.totalReturn).toBeCloseTo(150, 6);
  });

  it("'annual' vuelve a los pesos objetivo al cambiar de año", () => {
    const result = computeBacktest({ A, B }, {}, { rebalance: 'annual' });
    expect(result.stats.portfolio.totalReturn).toBeCloseTo(125, 6);
  });

  it('las líneas por activo no cambian con el rebalanceo', () => {
    const result = computeBacktest({ A, B }, {}, { rebalance: 'annual' });
    expect(result.points[2].A).toBeCloseTo(300, 6);
    expect(result.points[2].B).toBeCloseTo(0, 6);
  });
});

describe('computeBacktest — riesgo (drawdown y volatilidad)', () => {
  it('máx. drawdown: pico 150 → valle 75 = 50%', () => {
    const A = series([['2024-01-01', 100], ['2024-02-01', 150], ['2024-03-01', 75], ['2024-04-01', 120]]);
    const result = computeBacktest({ A });
    expect(result.stats.portfolio.maxDrawdown).toBeCloseTo(50, 6);
  });

  it('retornos constantes → volatilidad 0; serie plana → drawdown 0', () => {
    const up = series([['2024-01-01', 100], ['2024-02-01', 110], ['2024-03-01', 121]]);
    expect(computeBacktest({ A: up }).stats.portfolio.volatility).toBeCloseTo(0, 6);
    const flat = series([['2024-01-01', 100], ['2024-02-01', 100], ['2024-03-01', 100]]);
    expect(computeBacktest({ A: flat }).stats.portfolio.maxDrawdown).toBeCloseTo(0, 6);
  });
});

describe('computeBacktest — simulación con dinero (inicial + DCA)', () => {
  it('inversión inicial sin aportaciones: sigue el índice', () => {
    const A = series([['2024-01-01', 100], ['2025-01-01', 200]]);
    const result = computeBacktest({ A }, {}, { initial: 1000 });
    expect(result.stats.money.finalValue).toBeCloseTo(2000, 6);
    expect(result.stats.money.invested).toBeCloseTo(1000, 6);
    expect(result.stats.money.profitPct).toBeCloseTo(100, 6);
  });

  it('DCA: aporta al cambiar de mes (no en la fecha base) a precios planos', () => {
    const A = series([['2024-01-01', 100], ['2024-02-01', 100], ['2024-03-01', 100]]);
    const result = computeBacktest({ A }, {}, { initial: 0, monthly: 100 });
    expect(result.stats.money.invested).toBeCloseTo(200, 6);
    expect(result.stats.money.finalValue).toBeCloseTo(200, 6);
    expect(result.stats.money.profit).toBeCloseTo(0, 6);
  });

  it('la aportación compra al precio del momento (mitad de unidades si duplica)', () => {
    // 100 iniciales a 100 → 1 unidad; a 200 aporta 100 → 0.5 unidades; cierre 200.
    const A = series([['2024-01-01', 100], ['2024-02-01', 200]]);
    const result = computeBacktest({ A }, {}, { initial: 100, monthly: 100 });
    expect(result.stats.money.invested).toBeCloseTo(200, 6);
    expect(result.stats.money.finalValue).toBeCloseTo(300, 6); // 200 + 100
  });

  it('sin initial ni monthly → money null (las líneas % no cambian)', () => {
    const A = series([['2024-01-01', 100], ['2025-01-01', 200]]);
    const result = computeBacktest({ A });
    expect(result.stats.money).toBeNull();
    expect(result.stats.portfolio.totalReturn).toBeCloseTo(100, 6);
  });
});

describe('computeBacktest — entradas degeneradas', () => {
  it('sin activos → resultado vacío seguro', () => {
    const result = computeBacktest({});
    expect(result.points).toEqual([]);
    expect(result.stats.portfolio.totalReturn).toBeNull();
  });

  it('una serie vacía anula la intersección → vacío seguro', () => {
    const result = computeBacktest({ A: series([['2024-01-01', 10]]), B: [] });
    expect(result.points).toEqual([]);
  });

  it('precios 0 en la base se filtran (sin división por cero)', () => {
    const A = series([['2024-01-01', 0], ['2024-01-02', 10], ['2024-01-03', 12]]);
    const B = series([['2024-01-01', 5], ['2024-01-02', 5], ['2024-01-03', 6]]);
    const result = computeBacktest({ A, B });
    // 2024-01-01 dropped (A base 0); window starts 2024-01-02
    expect(result.startDate).toBe('2024-01-02');
    expect(result.points[1].A).toBeCloseTo(20, 6);
  });
});
