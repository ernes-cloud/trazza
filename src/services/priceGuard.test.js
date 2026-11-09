import { describe, it, expect } from 'vitest';
import { isPlausiblePriceUpdate } from './priceGuard';

describe('isPlausiblePriceUpdate — bloquea colapsos de precio (corrupción ÷100)', () => {
  it('bloquea el patrón del bug de peniques: $111.20 → 1.11 (÷100)', () => {
    expect(isPlausiblePriceUpdate(111.20, 1.11)).toBe(false);
  });

  it('permite movimientos de mercado normales (±50%)', () => {
    expect(isPlausiblePriceUpdate(100, 55)).toBe(true);
    expect(isPlausiblePriceUpdate(100, 150)).toBe(true);
    expect(isPlausiblePriceUpdate(100, 99.5)).toBe(true);
  });

  it('permite subidas grandes (curación de un precio corrupto: 1.11 → 111.20)', () => {
    expect(isPlausiblePriceUpdate(1.11, 111.20)).toBe(true);
  });

  it('bloquea justo por debajo del umbral y permite justo por encima', () => {
    expect(isPlausiblePriceUpdate(100, 14.9)).toBe(false);
    expect(isPlausiblePriceUpdate(100, 15.1)).toBe(true);
  });

  it('no bloquea cuando falta alguno de los dos precios', () => {
    expect(isPlausiblePriceUpdate(0, 50)).toBe(true);      // sin precio previo (asset nuevo)
    expect(isPlausiblePriceUpdate(null, 50)).toBe(true);
    expect(isPlausiblePriceUpdate(100, 0)).toBe(true);      // el 0 lo filtra el RPC (> 0)
    expect(isPlausiblePriceUpdate(undefined, undefined)).toBe(true);
  });
});
