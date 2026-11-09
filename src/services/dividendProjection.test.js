import { describe, it, expect } from 'vitest';
import { remainingPaymentsThisYear, projectedPerShareThisYear } from './dividendProjection';

// "Hoy" fijo: 15 de octubre de 2026 (fecha local).
const TODAY = new Date(2026, 9, 15);

describe('remainingPaymentsThisYear', () => {
  it('trimestral con el próximo ex-div el 26 oct: queda UN pago este año', () => {
    // ASML en la demo: 1,88 €/acc. y 7,54 €/año → 4 pagos al año
    expect(remainingPaymentsThisYear({ exDate: '2026-10-26', amount: 1.88, annualDividend: 7.54 }, TODAY)).toBe(1);
  });

  it('mensual con ex-div el 20 oct: oct, nov y dic', () => {
    expect(remainingPaymentsThisYear({ exDate: '2026-10-20', amount: 0.1, annualDividend: 1.2 }, TODAY)).toBe(3);
  });

  it('anual cuyo último ex-div fue en marzo: ninguno más este año', () => {
    expect(remainingPaymentsThisYear({ exDate: '2026-03-10', amount: 2, annualDividend: 2 }, TODAY)).toBe(0);
  });

  it('un ex-div ya pasado se adelanta por su frecuencia (trimestral: 10 ago → 9 nov)', () => {
    expect(remainingPaymentsThisYear({ exDate: '2026-08-10', amount: 0.25, annualDividend: 1 }, TODAY)).toBe(1);
  });

  it('un ex-div del año que viene no cuenta para este', () => {
    expect(remainingPaymentsThisYear({ exDate: '2027-01-05', amount: 0.25, annualDividend: 1 }, TODAY)).toBe(0);
  });
});

describe('projectedPerShareThisYear', () => {
  it('son los pagos que quedan por el importe de cada uno', () => {
    expect(projectedPerShareThisYear({ exDate: '2026-10-20', amount: 0.1, annualDividend: 1.2 }, TODAY)).toBeCloseTo(0.3, 6);
  });

  it('nunca es el dividendo de un año entero en octubre (el fallo que inflaba la previsión)', () => {
    const ev = { exDate: '2026-10-26', amount: 1.88, annualDividend: 7.54 };
    expect(projectedPerShareThisYear(ev, TODAY)).toBeCloseTo(1.88, 6);
    expect(projectedPerShareThisYear(ev, TODAY)).toBeLessThan(ev.annualDividend);
  });

  it('sin fecha ex-div, prorratea el anual por lo que queda de año', () => {
    // del 15 oct al 31 dic quedan 78 de 365 días
    expect(projectedPerShareThisYear({ exDate: null, amount: null, annualDividend: 3.65 }, TODAY)).toBeCloseTo(0.78, 2);
  });

  it('sin datos, cero', () => {
    expect(projectedPerShareThisYear({ exDate: null, amount: null, annualDividend: null }, TODAY)).toBe(0);
  });
});
