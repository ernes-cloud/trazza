import { describe, it, expect } from 'vitest';
import { savingsTax, incrementalSavingsTax } from './savingsTax.js';
import { computeDividendIncome, ORIGIN_COUNTRIES } from './dividendCalculator.js';
import { computeFire } from './fireCalculator.js';

describe('savingsTax — escala del ahorro (Renta 2025)', () => {
  it('es por tramos, no un tipo plano', () => {
    expect(savingsTax(6000)).toBeCloseTo(1140, 2);          // 6.000 × 19 %
    expect(savingsTax(8000)).toBeCloseTo(1140 + 420, 2);    // + 2.000 × 21 %
    expect(savingsTax(50000)).toBeCloseTo(10380, 2);        // cifra oficial de la AEAT
    expect(savingsTax(200000)).toBeCloseTo(44880, 2);
    expect(savingsTax(300000)).toBeCloseTo(71880, 2);
    expect(savingsTax(400000)).toBeCloseTo(71880 + 30000, 2); // 30 % desde 2025
  });

  it('el impuesto de una renta depende de lo que ya había en la base', () => {
    expect(incrementalSavingsTax(1000, 0)).toBeCloseTo(190, 2);
    expect(incrementalSavingsTax(1000, 5500)).toBeCloseTo(500 * 0.19 + 500 * 0.21, 2);
  });

  it('valores vacíos o negativos dan 0', () => {
    expect(savingsTax(-5)).toBe(0);
    expect(savingsTax(undefined)).toBe(0);
  });
});

describe('computeDividendIncome', () => {
  const us = ORIGIN_COUNTRIES.find((c) => c.id === 'us');
  const ch = ORIGIN_COUNTRIES.find((c) => c.id === 'ch');
  const es = ORIGIN_COUNTRIES.find((c) => c.id === 'es');

  it('EE. UU.: el 15 % retenido fuera se recupera entero en la Renta', () => {
    // 20.000 € al 3 % = 600 € brutos; fuera 90; IRPF 114; se deducen 90 → pagas 24
    const r = computeDividendIncome({ invested: 20000, yieldPct: 3, originRate: us.rate, treatyCap: us.treatyCap });
    expect(r).toMatchObject({ gross: 600, originWithholding: 90, spanishTax: 114, deduction: 90, spanishToPay: 24, net: 486, lostAbroad: 0 });
    expect(r.netMonthly).toBeCloseTo(40.5, 2);
    expect(r.effectiveRatePct).toBeCloseTo(19, 2); // acabas pagando lo mismo que con una española
  });

  it('Suiza: lo que pasa del 15 % se pierde si no lo reclamas', () => {
    const r = computeDividendIncome({ invested: 20000, yieldPct: 3, originRate: ch.rate, treatyCap: ch.treatyCap });
    expect(r.originWithholding).toBe(210);   // 35 %
    expect(r.deduction).toBe(90);            // tope del convenio: 15 %
    expect(r.lostAbroad).toBe(120);          // 20 % que la Renta no devuelve
    expect(r.net).toBe(600 - 210 - 24);
  });

  it('España: sin retención en origen, solo el IRPF', () => {
    const r = computeDividendIncome({ invested: 10000, yieldPct: 4, originRate: es.rate, treatyCap: es.treatyCap });
    expect(r).toMatchObject({ gross: 400, originWithholding: 0, deduction: 0, spanishToPay: 76, net: 324 });
  });

  it('las otras rentas del ahorro suben el tramo', () => {
    const solo = computeDividendIncome({ invested: 20000, yieldPct: 3 });
    const conOtras = computeDividendIncome({ invested: 20000, yieldPct: 3, otherSavingsIncome: 60000 });
    expect(conOtras.spanishTax).toBeCloseTo(600 * 0.23, 2);
    expect(conOtras.net).toBeLessThan(solo.net);
  });

  it('la deducción nunca supera la cuota española', () => {
    // retención fuera del 15 % pero con IRPF de solo... imposible por debajo del 19 %:
    // se fuerza con un tope del convenio alto para comprobar el límite
    const r = computeDividendIncome({ invested: 1000, yieldPct: 10, originRate: 0.3, treatyCap: 0.3 });
    expect(r.deduction).toBeCloseTo(r.spanishTax, 2);
    expect(r.spanishToPay).toBe(0);
  });

  it('entradas vacías no rompen', () => {
    expect(computeDividendIncome({ invested: '', yieldPct: null }).net).toBe(0);
  });
});

describe('computeFire', () => {
  it('la cifra objetivo es gastos / tasa de retirada (25 veces al 4 %)', () => {
    expect(computeFire({ annualExpenses: 24000, withdrawalRatePct: 4 }).target).toBe(600000);
    expect(computeFire({ annualExpenses: 24000, withdrawalRatePct: 3.5 }).target).toBeCloseTo(685714.29, 2);
  });

  it('calcula cuándo se alcanza con ahorros, aportación y rentabilidad real', () => {
    const r = computeFire({ annualExpenses: 24000, currentSavings: 50000, monthlyContribution: 1000, realReturnPct: 5, withdrawalRatePct: 4 });
    expect(r.reached).toBe(true);
    expect(r.years).toBeGreaterThan(20);
    expect(r.years).toBeLessThan(25);
    // el valor del año en que se cruza el objetivo ya lo supera
    const crossing = r.series.find((p) => p.value >= r.target);
    expect(crossing.year).toBeGreaterThanOrEqual(Math.floor(r.years));
  });

  it('si ya tienes la cifra, has llegado (0 meses)', () => {
    expect(computeFire({ annualExpenses: 10000, currentSavings: 300000 })).toMatchObject({ reached: true, months: 0, years: 0 });
  });

  it('sin aportación ni rentabilidad no se llega nunca: lo dice en vez de inventar', () => {
    const r = computeFire({ annualExpenses: 24000, currentSavings: 1000, monthlyContribution: 0, realReturnPct: 0 });
    expect(r.reached).toBe(false);
    expect(r.years).toBeNull();
    expect(r.series.length).toBe(101); // año 0 + 100 años
  });

  it('con tasa de retirada 0 no hay objetivo calculable', () => {
    expect(computeFire({ annualExpenses: 24000, withdrawalRatePct: 0 }).target).toBeNull();
  });
});

describe('ORIGIN_COUNTRIES — tipos contrastados con fuentes oficiales (2026-10-17)', () => {
  it('Francia retiene 12,8 % a personas físicas y, con tope del 15 %, no se pierde nada', () => {
    const fr = ORIGIN_COUNTRIES.find((c) => c.id === 'fr');
    expect(fr.rate).toBe(0.128);
    expect(fr.treatyCap).toBe(0.15);
    const r = computeDividendIncome({ invested: 10000, yieldPct: 4, originRate: fr.rate, treatyCap: fr.treatyCap });
    expect(r.originWithholding).toBe(51.2);
    expect(r.deduction).toBe(51.2);
    expect(r.lostAbroad).toBe(0);
  });

  it('Reino Unido: sin retención y tope del convenio de 2013 al 10 %', () => {
    const gb = ORIGIN_COUNTRIES.find((c) => c.id === 'gb');
    expect(gb.rate).toBe(0);
    expect(gb.treatyCap).toBe(0.10);
    const r = computeDividendIncome({ invested: 10000, yieldPct: 4, originRate: gb.rate, treatyCap: gb.treatyCap });
    expect(r.lostAbroad).toBe(0);
  });

  it('Reino Unido: con una retención del 15 % el tope del 10 % sí importa (deduce 40, no 60)', () => {
    const gb = ORIGIN_COUNTRIES.find((c) => c.id === 'gb');
    // 10.000 € al 4 % = 400 € brutos; retenido 60 €; tope 10 % = 40 €; cuota española 76 €.
    const r = computeDividendIncome({ invested: 10000, yieldPct: 4, originRate: 0.15, treatyCap: gb.treatyCap });
    expect(r.originWithholding).toBe(60);
    expect(r.deduction).toBe(40);
    expect(r.lostAbroad).toBe(20);
  });
});
