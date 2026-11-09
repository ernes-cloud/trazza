import { describe, it, expect } from 'vitest';
import { DEFAULT_CURRENCY, preferredCurrencyOf } from './preferredCurrency';

describe('preferredCurrencyOf', () => {
  it('una cuenta sin preferencias ve euros, no dólares', () => {
    expect(DEFAULT_CURRENCY).toBe('EUR');
    expect(preferredCurrencyOf(null)).toBe('EUR');
    expect(preferredCurrencyOf({})).toBe('EUR');
  });
  it('respeta la divisa elegida', () => {
    expect(preferredCurrencyOf({ preferred_currency: 'USD' })).toBe('USD');
    expect(preferredCurrencyOf({ preferred_currency: 'gbp' })).toBe('GBP');
  });
  it('un valor corrupto cae al defecto', () => {
    expect(preferredCurrencyOf({ preferred_currency: 'dólares' })).toBe('EUR');
  });
});
