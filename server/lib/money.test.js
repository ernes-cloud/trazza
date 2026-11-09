import { describe, it, expect } from 'vitest';
import { formatMoney } from './money.js';

const nb = (s) => s.replace(/ /g, ' ');

describe('formatMoney', () => {
  it('cada divisa con su símbolo (antes "$" para todo)', () => {
    expect(formatMoney(1.413, 'CAD', { decimals: 4 })).toBe('C$1,4130');
    expect(formatMoney(0.25, 'USD', { decimals: 4 })).toBe('$0,2500');
    expect(nb(formatMoney(1.5, 'EUR'))).toBe('1,50 €');
    expect(formatMoney(3, 'GBP')).toBe('£3,00');
  });

  it('miles con punto también en 4 cifras', () => {
    expect(nb(formatMoney(2465.01, 'EUR'))).toBe('2.465,01 €');
  });

  it('objetivo de una alerta: sin decimales sobrantes', () => {
    expect(formatMoney(150, 'USD', { decimals: 2, minDecimals: 0 })).toBe('$150');
    expect(formatMoney(150.5, 'USD', { decimals: 2, minDecimals: 0 })).toBe('$150,5');
  });

  it('divisa desconocida o ausente: código ISO o solo el número', () => {
    expect(formatMoney(10, 'CHF')).toBe('10,00 CHF');
    expect(formatMoney(10, null)).toBe('10,00');
    expect(formatMoney(NaN, 'EUR')).toBe('');
  });
});
