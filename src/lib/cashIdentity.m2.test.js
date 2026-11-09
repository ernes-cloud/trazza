import { describe, it, expect } from 'vitest';
import {
  decoratedCashTicker,
  cashTickersForCurrency,
  isCashTickerForCurrency,
  matchesCashIdentity,
  findCashAssetByCurrency,
  findCashPosition,
  currencyFromCanonicalCashTicker,
  currencyHintFromCashTicker,
} from './cashIdentity';

describe('m1 — decoratedCashTicker único', () => {
  it('es la forma CASH_X (X) y la usan los aliases', () => {
    expect(decoratedCashTicker('EUR')).toBe('CASH_EUR (EUR)');
    expect(cashTickersForCurrency('chf')).toEqual(['CASH_CHF', 'CASH_CHF (CHF)']);
  });
});

describe('isCashTickerForCurrency — trim/upper (mata isTicker-sin-upper)', () => {
  it("acepta ' cash_eur ' y CASH_eur", () => {
    expect(isCashTickerForCurrency(' cash_eur ', 'EUR')).toBe(true);
    expect(isCashTickerForCurrency('CASH_eur', 'EUR')).toBe(true);
    expect(isCashTickerForCurrency(' cash_chf ', 'CHF')).toBe(true);
  });
});

describe('m2 — solo ticker canónico (sin fallback clase+divisa)', () => {
  it('CASH_USD etiquetado EUR no casa para lookup EUR', () => {
    const mislabeled = {
      id: 'a-bad', ticker: 'CASH_USD', currency: 'EUR', asset_class: 'Cash',
    };
    expect(currencyFromCanonicalCashTicker('CASH_USD')).toBe('USD');
    // Parenthetical must repeat the encoded currency — CASH_USD (EUR) is not canonical.
    expect(currencyFromCanonicalCashTicker('CASH_USD (EUR)')).toBeNull();
    expect(currencyHintFromCashTicker('CASH_USD')).toBe('USD');
    expect(findCashAssetByCurrency({ CASH_USD: mislabeled }, 'EUR')).toBeNull();
    expect(matchesCashIdentity('CASH_USD', 'EUR')).toBe(false);
  });

  it('CASH sin divisa sigue sin coincidir', () => {
    const bare = { id: 'a-bare', ticker: 'CASH', currency: 'EUR', asset_class: 'Cash' };
    expect(findCashAssetByCurrency({ CASH: bare }, 'EUR')).toBeNull();
  });

  it('CASH_EUR con currency EUR sigue coincidiendo por scan', () => {
    // Keyed under a non-alias key so the exact loop misses; scan must hit.
    const ok = { id: 'a-ok', ticker: 'CASH_EUR', currency: 'EUR', asset_class: 'Cash' };
    expect(findCashAssetByCurrency({ other: ok }, 'EUR')).toBe(ok);
  });

  it('currency null se infiere del ticker canónico y reutiliza en alias/barrido/posición', () => {
    const nullCur = { id: 'a-null', ticker: 'CASH_EUR', currency: null, asset_class: 'Cash' };
    expect(findCashAssetByCurrency({ CASH_EUR: nullCur }, 'EUR')).toBe(nullCur);
    expect(findCashAssetByCurrency({ other: nullCur }, 'EUR')).toBe(nullCur);
    expect(findCashPosition([{
      id: 'p-null',
      broker_id: 'b1',
      assets: nullCur,
    }], { currency: 'EUR', brokerId: 'b1' })?.id).toBe('p-null');
  });

  it('clave alias con value no canónico NO cuenta (R2: ticker del value manda)', () => {
    const viaKey = { id: 'a-key', ticker: 'PLACEHOLDER', currency: 'XXX', asset_class: 'Other' };
    expect(findCashAssetByCurrency({ CASH_EUR: viaKey }, 'EUR')).toBeNull();
  });

  it('CASH_NET_EUR nunca es liquidez aunque currency=EUR y class Cash', () => {
    const net = {
      id: 'a-net', ticker: 'CASH_NET_EUR', currency: 'EUR', asset_class: 'Cash',
    };
    expect(findCashAssetByCurrency({ x: net }, 'EUR')).toBeNull();
    expect(findCashPosition([{
      id: 'p-net', broker_id: 'b1', assets: net,
    }], { currency: 'EUR', brokerId: 'b1' })).toBeNull();
  });
});

describe('findCashPosition — canónico + guarda broker', () => {
  it('Stock EUR no es liquidez (ticker no canónico)', () => {
    const p = {
      id: 'p-stock',
      broker_id: 'b1',
      assets: { ticker: 'VWCE', currency: 'EUR', asset_class: 'Cash' },
    };
    expect(findCashPosition([p], { currency: 'EUR', brokerId: 'b1' })).toBeNull();
  });

  it('CASH_EUR (EUR) con currency EUR sí', () => {
    const p = {
      id: 'p-degiro',
      broker_id: 'b1',
      assets: { ticker: 'CASH_EUR (EUR)', currency: 'EUR', asset_class: 'Cash' },
    };
    expect(findCashPosition([p], { currency: 'EUR', brokerId: 'b1' })?.id).toBe('p-degiro');
  });
});
