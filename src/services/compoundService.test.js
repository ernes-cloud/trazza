import { describe, it, expect } from 'vitest';
import { buildProjection, yearGoalReached, requiredMonthlyFor } from './compoundService';

describe('buildProjection — matemática base', () => {
  it('capitalización anual sin aportaciones: 1000 al 10% × 1 año = 1100', () => {
    const p = buildProjection({ initial: 1000, monthly: 0, annualRate: 10, years: 1, freq: 'annual' });
    expect(p.finalValue).toBeCloseTo(1100, 8);
    expect(p.totalContributed).toBeCloseTo(1000, 8);
    expect(p.totalInterest).toBeCloseTo(100, 8);
  });

  it('capitalización mensual: 1000 al 12% × 1 año = 1000 × 1.01^12', () => {
    const p = buildProjection({ initial: 1000, monthly: 0, annualRate: 12, years: 1, freq: 'monthly' });
    expect(p.finalValue).toBeCloseTo(1000 * Math.pow(1.01, 12), 8);
  });

  it('solo aportaciones al 0%: 100/mes × 1 año = 1200', () => {
    const p = buildProjection({ initial: 0, monthly: 100, annualRate: 0, years: 1, freq: 'monthly' });
    expect(p.finalValue).toBeCloseTo(1200, 8);
    expect(p.totalContributed).toBeCloseTo(1200, 8);
    expect(p.totalInterest).toBeCloseTo(0, 8);
  });

  it('frecuencia trimestral agrupa la aportación mensual (×3) y aporta 4 veces/año', () => {
    const p = buildProjection({ initial: 0, monthly: 100, annualRate: 0, years: 2, freq: 'quarterly' });
    expect(p.finalValue).toBeCloseTo(2400, 8); // mismas aportaciones totales que mensual
  });

  it('step-up: la aportación crece un 10% cada año a partir del 2º', () => {
    const p = buildProjection({ initial: 0, monthly: 100, annualRate: 0, years: 2, freq: 'monthly', stepUpPct: 10 });
    expect(p.table[0].contribution).toBeCloseTo(1200, 8);
    expect(p.table[1].contribution).toBeCloseTo(1320, 8);
    expect(p.finalValue).toBeCloseTo(2520, 8);
  });

  it('inflación: deflacta por (1+i)^año sin tocar la rentabilidad nominal', () => {
    const p = buildProjection({ initial: 1000, monthly: 0, annualRate: 10, years: 10, freq: 'annual', inflationPct: 2.5 });
    const nominal = 1000 * Math.pow(1.1, 10);
    expect(p.finalValue).toBeCloseTo(nominal, 6);
    expect(p.finalValueReal).toBeCloseTo(nominal / Math.pow(1.025, 10), 6);
    expect(p.table[9].balanceReal).toBeCloseTo(p.finalValueReal, 6);
  });

  it('sin inflación, la serie real coincide con la nominal', () => {
    const p = buildProjection({ initial: 1000, monthly: 100, annualRate: 8, years: 5 });
    expect(p.finalValueReal).toBeCloseTo(p.finalValue, 8);
    expect(p.chart.every(c => c.totalReal === c.total)).toBe(true);
  });

  it('registra hitos con el año en que se alcanzan', () => {
    // 1000 + 1200/año al 0% → 10.000 en el año 8 (1000 + 9600 = 10600)
    const p = buildProjection({ initial: 1000, monthly: 100, annualRate: 0, years: 10 });
    const m = p.milestones.find(x => x.value === 10000);
    expect(m?.year).toBe(8);
  });
});

describe('yearGoalReached', () => {
  it('encuentra el año dentro y más allá del horizonte configurado', () => {
    const params = { initial: 1000, monthly: 100, annualRate: 0, years: 2, freq: 'monthly' };
    // balance año y = 1000 + 1200y → 5000 se alcanza en el año 4 (5800)
    expect(yearGoalReached(params, 5000)).toBe(4);
  });

  it('0 si el balance inicial ya cubre el objetivo; null si es inalcanzable', () => {
    const params = { initial: 1000, monthly: 0, annualRate: 0, years: 5 };
    expect(yearGoalReached(params, 500)).toBe(0);
    expect(yearGoalReached(params, 2000)).toBe(null); // 0% sin aportar: nunca
    expect(yearGoalReached(params, 0)).toBe(null);
  });
});

describe('requiredMonthlyFor', () => {
  it('al 0% e inicial 0: para 1200 en 1 año hacen falta 100/mes', () => {
    const params = { initial: 0, annualRate: 0, years: 1, freq: 'monthly' };
    expect(requiredMonthlyFor(params, 1200)).toBeCloseTo(100, 4);
  });

  it('0 si el plan sin aportar ya llega; y la solución cuadra al re-simular', () => {
    expect(requiredMonthlyFor({ initial: 2000, annualRate: 0, years: 1 }, 1500)).toBe(0);
    const params = { initial: 5000, annualRate: 7, years: 15, freq: 'monthly', stepUpPct: 2 };
    const req = requiredMonthlyFor(params, 100000);
    const check = buildProjection({ ...params, monthly: req });
    expect(check.finalValue).toBeCloseTo(100000, 0);
  });
});
