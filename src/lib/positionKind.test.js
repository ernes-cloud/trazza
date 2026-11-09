import { describe, it, expect } from 'vitest';
import { isCashPosition, isHeldInvestedPosition } from './positionKind';

const pos = (assets, quantity = 10) => ({ id: 'p', quantity, assets });

describe('isCashPosition', () => {
  it('detects the canonical cash row', () => {
    expect(isCashPosition(pos({ ticker: 'CASH_EUR', currency: 'EUR', asset_class: 'Cash' }))).toBe(true);
    expect(isCashPosition(pos({ ticker: 'CASH_EUR (EUR)', currency: 'EUR', asset_class: 'Cash' }))).toBe(true);
  });

  it('treats Cash class rows as cash, even with a non-canonical ticker', () => {
    for (const cls of ['cash', 'CASH', 'Cash', ' Cash ']) {
      expect(isCashPosition(pos({ ticker: 'EUR', currency: 'EUR', asset_class: cls }))).toBe(true);
    }
  });

  it('detects cash by the CASH_ ticker convention when currency matches', () => {
    expect(isCashPosition(pos({ ticker: 'CASH_USD', currency: 'USD', asset_class: null }))).toBe(true);
    expect(isCashPosition(pos({ ticker: 'cash_usd', currency: 'usd' }))).toBe(true);
    expect(isCashPosition(pos({ ticker: ' CASH_EUR', currency: 'EUR' }))).toBe(true);
  });

  it('treats CASH_ tickers as cash regardless of currency metadata', () => {
    expect(isCashPosition(pos({ ticker: 'CASH_USD', currency: 'EUR', asset_class: 'Stock' }))).toBe(true);
    expect(isCashPosition(pos({ ticker: 'CASH_USD' }))).toBe(true);
  });

  it('does not treat a normal stock as cash, but keeps legacy CASH* rows as cash', () => {
    expect(isCashPosition(pos({ ticker: 'MSFT', asset_class: 'Stock', currency: 'USD' }))).toBe(false);
    expect(isCashPosition(pos({ ticker: 'CSH', asset_class: 'Stock' }))).toBe(false);
    expect(isCashPosition(pos({ ticker: 'CASH_NET_EUR', currency: 'EUR', asset_class: 'Stock' }))).toBe(true);
    expect(isCashPosition(pos({ ticker: 'CASH', currency: 'EUR', asset_class: 'Stock' }))).toBe(true);
  });

  it('tolerates missing assets / null rows', () => {
    expect(isCashPosition({ id: 'x' })).toBe(false);
    expect(isCashPosition(null)).toBe(false);
    expect(isCashPosition(undefined)).toBe(false);
  });
});

describe('isHeldInvestedPosition — what "N posiciones" counts', () => {
  it('excludes canonical liquidity', () => {
    expect(isHeldInvestedPosition(pos({ ticker: 'CASH_EUR', currency: 'EUR', asset_class: 'Cash' }, 12450.6))).toBe(false);
  });

  it('excludes a non-canonical Cash-class row from invested holdings', () => {
    expect(isHeldInvestedPosition(pos({ ticker: 'EUR', currency: 'EUR', asset_class: 'cash' }, 12450.6))).toBe(false);
  });

  it('excludes closed rows kept by sells / CSV smart-closing', () => {
    expect(isHeldInvestedPosition(pos({ ticker: 'MSFT', asset_class: 'Stock' }, 0))).toBe(false);
    expect(isHeldInvestedPosition(pos({ ticker: 'MSFT', asset_class: 'Stock' }, 0.00001))).toBe(false);
  });

  it('counts a held asset, including string quantities from PostgREST', () => {
    expect(isHeldInvestedPosition(pos({ ticker: 'MSFT', asset_class: 'Stock' }, 10))).toBe(true);
    expect(isHeldInvestedPosition(pos({ ticker: 'MSFT', asset_class: 'Stock' }, '0.45'))).toBe(true);
  });
});
