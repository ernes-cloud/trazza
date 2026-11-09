import { describe, it, expect } from 'vitest';
import {
  cashTickersForCurrency,
  canonicalCashTicker,
  isCashTickerForCurrency,
  findCashAssetByCurrency,
  findCashPosition,
} from './cashIdentity';

describe('cashTickersForCurrency / canonicalCashTicker', () => {
  it('lists both historical spellings and never bare CASH', () => {
    expect(cashTickersForCurrency('EUR')).toEqual(['CASH_EUR', 'CASH_EUR (EUR)']);
    expect(cashTickersForCurrency('usd')).toEqual(['CASH_USD', 'CASH_USD (USD)']);
    expect(cashTickersForCurrency('EUR').includes('CASH')).toBe(false);
    expect(canonicalCashTicker('EUR')).toBe('CASH_EUR');
  });
});

describe('isCashTickerForCurrency', () => {
  it('accepts both aliases for the currency and rejects the other currency', () => {
    expect(isCashTickerForCurrency('CASH_EUR', 'EUR')).toBe(true);
    expect(isCashTickerForCurrency('CASH_EUR (EUR)', 'EUR')).toBe(true);
    expect(isCashTickerForCurrency('CASH_USD (USD)', 'USD')).toBe(true);
    expect(isCashTickerForCurrency('CASH_EUR', 'USD')).toBe(false);
    expect(isCashTickerForCurrency('CASH_EUR (EUR)', 'USD')).toBe(false);
  });

  it('never matches bare CASH (no currency)', () => {
    expect(isCashTickerForCurrency('CASH', 'EUR')).toBe(false);
    expect(isCashTickerForCurrency('cash', 'USD')).toBe(false);
    expect(isCashTickerForCurrency(null, 'EUR')).toBe(false);
  });

  it('requires explicit currency column (CASH_EUR + null is false)', () => {
    expect(isCashTickerForCurrency('CASH_EUR', null)).toBe(false);
  });
});

describe('findCashAssetByCurrency', () => {
  it('finds CASH_EUR when the map is keyed by the standard ticker', () => {
    const asset = { id: 'a1', ticker: 'CASH_EUR', currency: 'EUR', asset_class: 'Cash' };
    expect(findCashAssetByCurrency({ CASH_EUR: asset }, 'EUR')).toBe(asset);
  });

  it('finds DeGiro-style CASH_EUR (EUR) when looking up EUR', () => {
    const asset = { id: 'a2', ticker: 'CASH_EUR (EUR)', currency: 'EUR', asset_class: 'Cash' };
    expect(findCashAssetByCurrency({ 'CASH_EUR (EUR)': asset }, 'EUR')).toBe(asset);
  });

  it('does not treat bare CASH as a match for EUR', () => {
    const bare = { id: 'a3', ticker: 'CASH', currency: 'EUR', asset_class: 'Cash' };
    expect(findCashAssetByCurrency({ CASH: bare }, 'EUR')).toBeNull();
  });
});

describe('findCashPosition', () => {
  it('reuses CASH_EUR (EUR) for EUR and skips bare CASH', () => {
    const degiro = {
      id: 'p-eur',
      broker_id: 'b1',
      assets: { ticker: 'CASH_EUR (EUR)', currency: 'EUR', asset_class: 'Cash' },
    };
    const bare = {
      id: 'p-bare',
      broker_id: 'b1',
      assets: { ticker: 'CASH', currency: 'EUR', asset_class: 'Cash' },
    };
    expect(findCashPosition([bare, degiro], { currency: 'EUR', brokerId: 'b1' })?.id).toBe('p-eur');
    expect(findCashPosition([bare], { currency: 'EUR', brokerId: 'b1' })).toBeNull();
  });

  it('does not cross currencies', () => {
    const usd = {
      id: 'p-usd',
      broker_id: 'b1',
      assets: { ticker: 'CASH_USD (USD)', currency: 'USD', asset_class: 'Cash' },
    };
    expect(findCashPosition([usd], { currency: 'EUR', brokerId: 'b1' })).toBeNull();
    expect(findCashPosition([usd], { currency: 'USD', brokerId: 'b1' })?.id).toBe('p-usd');
  });
});
