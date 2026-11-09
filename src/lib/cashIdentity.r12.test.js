/**
 * R1/R2 — cash identity by canonical ticker only.
 * R1: CASH_XXX (XXX) aliases resolve as the same cash as CASH_XXX.
 * R2: no asset_class / currency-alone fallback; negatives never match.
 */
import { describe, it, expect } from 'vitest';
import {
  matchesCashIdentity,
  isCashTickerForCurrency,
  findCashAssetByCurrency,
  findCashPosition,
  cashTickersForCurrency,
} from './cashIdentity';
import { isCashPosition } from './positionKind';

const ALIAS_CURRENCIES = ['CAD', 'CHF', 'DKK', 'EUR', 'GBP', 'USD'];

describe('R1 — aliases CASH_XXX (XXX) ≡ CASH_XXX', () => {
  for (const cur of ALIAS_CURRENCIES) {
    it(`${cur}: CASH_${cur} and CASH_${cur} (${cur}) resolve as the same cash`, () => {
      const canonical = `CASH_${cur}`;
      const decorated = `CASH_${cur} (${cur})`;
      expect(cashTickersForCurrency(cur)).toEqual([canonical, decorated]);

      expect(matchesCashIdentity(canonical, cur)).toBe(true);
      expect(matchesCashIdentity(decorated, cur)).toBe(true);
      expect(isCashTickerForCurrency(canonical, cur)).toBe(true);
      expect(isCashTickerForCurrency(decorated, cur)).toBe(true);

      const aCanon = { id: `a-${cur}`, ticker: canonical, currency: cur, asset_class: 'Cash' };
      const aDeco = { id: `a-${cur}-d`, ticker: decorated, currency: cur, asset_class: 'Cash' };
      expect(findCashAssetByCurrency({ [canonical]: aCanon }, cur)).toBe(aCanon);
      expect(findCashAssetByCurrency({ [decorated]: aDeco }, cur)).toBe(aDeco);
      // Looking up EUR/… finds the decorated form when that is what is stored.
      expect(findCashAssetByCurrency({ other: aDeco }, cur)).toBe(aDeco);

      const pCanon = { id: `p-${cur}`, broker_id: 'b1', assets: aCanon };
      const pDeco = { id: `p-${cur}-d`, broker_id: 'b1', assets: aDeco };
      expect(findCashPosition([pCanon], { currency: cur, brokerId: 'b1' })?.id).toBe(`p-${cur}`);
      expect(findCashPosition([pDeco], { currency: cur, brokerId: 'b1' })?.id).toBe(`p-${cur}-d`);
      expect(isCashPosition(pCanon)).toBe(true);
      expect(isCashPosition(pDeco)).toBe(true);
    });
  }
});

describe('R2 — negatives never resolve as cash', () => {
  const negatives = [
    { ticker: 'CADHKD=X', currency: 'EUR', label: 'FX pair CADHKD=X (EUR)' },
    { ticker: 'CSHX', currency: 'EUR', label: 'CSHX (EUR)' },
    { ticker: 'CASH_NET_EUR', currency: 'EUR', label: 'CASH_NET_EUR (EUR)' },
    { ticker: 'CASH', currency: 'USD', label: "bare 'CASH' (USD)" },
    { ticker: 'CASH_-', currency: '-', label: "'CASH_-' ('-')" },
    {
      ticker: 'CASH_USD',
      currency: 'EUR',
      asset_class: 'Cash',
      label: 'CASH_USD with currency EUR (even with asset_class cash)',
    },
  ];

  for (const row of negatives) {
    it(`${row.label}`, () => {
      expect(matchesCashIdentity(row.ticker, row.currency)).toBe(false);
      expect(isCashTickerForCurrency(row.ticker, row.currency)).toBe(false);

      const asset = {
        id: 'a-neg',
        ticker: row.ticker,
        currency: row.currency,
        asset_class: row.asset_class || 'Cash',
      };
      expect(findCashAssetByCurrency({ [row.ticker]: asset, other: asset }, row.currency)).toBeNull();
      // Also when looking up the ticker's "would-be" currency for CASH_USD/EUR mismatch.
      if (row.ticker === 'CASH_USD' && row.currency === 'EUR') {
        expect(findCashAssetByCurrency({ CASH_USD: asset }, 'EUR')).toBeNull();
        expect(findCashAssetByCurrency({ CASH_USD: asset }, 'USD')).toBeNull();
      }

      const pos = { id: 'p-neg', broker_id: 'b1', assets: asset };
      expect(findCashPosition([pos], { currency: row.currency, brokerId: 'b1' })).toBeNull();
      // Classification is intentionally broader than identity matching.
      expect(isCashPosition(pos)).toBe(true);
    });
  }

  it('ticker EUR with asset_class Cash fails identity matching, while classification still marks cash', () => {
    const asset = { id: 'a-cls', ticker: 'EUR', currency: 'EUR', asset_class: 'Cash' };
    expect(matchesCashIdentity(asset.ticker, asset.currency)).toBe(false);
    expect(findCashAssetByCurrency({ EUR: asset }, 'EUR')).toBeNull();
    expect(isCashPosition({ id: 'p', assets: asset })).toBe(true);
  });
});
