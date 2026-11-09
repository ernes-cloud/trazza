import { describe, it, expect } from 'vitest';
import { convertQuotePrice, stalePriceDate } from './quotePricing';

describe('convertQuotePrice', () => {
  it('returns the raw price when quote and stored currency match', () => {
    // Arrange
    const rates = { USD: 0.86, EUR: 1 };

    // Act
    const price = convertQuotePrice(200, 'USD', 'USD', rates);

    // Assert
    expect(price).toBe(200);
  });

  it('converts a USD quote into an EUR-stored asset (GOOGL on DeGiro)', () => {
    // Arrange — rates are against the preferred currency (EUR here)
    const rates = { USD: 0.86, EUR: 1 };

    // Act
    const price = convertQuotePrice(200, 'USD', 'EUR', rates);

    // Assert
    expect(price).toBeCloseTo(172, 10);
  });

  it('converts an EUR quote into a USD-stored asset (inverse direction)', () => {
    const rates = { USD: 0.86, EUR: 1 };

    const price = convertQuotePrice(172, 'EUR', 'USD', rates);

    expect(price).toBeCloseTo(200, 10);
  });

  it('is case-insensitive on the currency codes', () => {
    const rates = { USD: 0.86, EUR: 1 };

    expect(convertQuotePrice(200, 'usd', 'eur', rates)).toBeCloseTo(172, 10);
  });

  it('leaves the price untouched when a rate is missing', () => {
    // A missing rate must never scale the price to 0 — that would look like a
    // 100% collapse to every consumer downstream.
    expect(convertQuotePrice(200, 'USD', 'JPY', { USD: 0.86 })).toBe(200);
  });

  it('leaves the price untouched when the target rate is zero', () => {
    expect(convertQuotePrice(200, 'USD', 'EUR', { USD: 0.86, EUR: 0 })).toBe(200);
  });

  it('returns 0 for non-numeric prices', () => {
    expect(convertQuotePrice(undefined, 'USD', 'EUR', { USD: 0.86, EUR: 1 })).toBe(0);
    expect(convertQuotePrice(null, 'USD', 'EUR', { USD: 0.86, EUR: 1 })).toBe(0);
    expect(convertQuotePrice('abc', 'USD', 'EUR', { USD: 0.86, EUR: 1 })).toBe(0);
  });

  it('parses numeric strings', () => {
    expect(convertQuotePrice('200', 'USD', 'EUR', { USD: 0.86, EUR: 1 })).toBeCloseTo(172, 10);
  });

  it('returns the raw price when a currency code is absent', () => {
    expect(convertQuotePrice(200, null, 'EUR', { EUR: 1 })).toBe(200);
    expect(convertQuotePrice(200, 'USD', '', { USD: 0.86 })).toBe(200);
  });
});

describe('stalePriceDate — de qué día es el precio de un fondo', () => {
  const NOW = new Date(2026, 9, 15, 22, 0); // 15-oct 22:00 local
  const at = (iso) => Math.floor(new Date(iso).getTime() / 1000);

  it('un fondo con NAV del 13 oct consultado el 15 → "2026-10-13"', () => {
    expect(stalePriceDate({ type: 'MUTUALFUND', marketTime: at('2026-10-13T20:00:00Z') }, NOW)).toBe('2026-10-13');
  });

  it('un fondo con el NAV de hoy no lleva fecha', () => {
    expect(stalePriceDate({ type: 'MUTUALFUND', marketTime: at('2026-10-15T15:00:00Z') }, NOW)).toBeNull();
  });

  it('una acción nunca lleva fecha (cotiza en vivo; el fin de semana no es un retraso)', () => {
    expect(stalePriceDate({ type: 'EQUITY', marketTime: at('2026-10-13T20:00:00Z') }, NOW)).toBeNull();
  });

  it('sin hora de mercado, nada', () => {
    expect(stalePriceDate({ type: 'MUTUALFUND', marketTime: null }, NOW)).toBeNull();
    expect(stalePriceDate(null, NOW)).toBeNull();
  });
});
