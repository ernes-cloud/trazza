import { describe, it, expect } from 'vitest';
import { positionGroupKey } from './positionGroupKey';
import { TICKER_MAP, resolveTicker } from './tickerMap';

const deps = { tickerMap: TICKER_MAP, resolveTicker };
const pos = (ticker, isin = '', extra = {}) => ({ assets: { ticker, isin }, ...extra });

describe('positionGroupKey', () => {
  it('Amazon de DeGiro (con ISIN) y de IBKR (sin ISIN) son la MISMA fila', () => {
    // Caso real: IBKR solo saca el ISIN de los dividendos y Amazon no paga.
    const degiro = positionGroupKey(pos('US0231351067 (USD)', 'US0231351067'), deps);
    const ibkr = positionGroupKey(pos('AMZN (USD)', ''), deps);
    expect(degiro).toBe(ibkr);
  });

  it('dos brokers con el mismo ISIN siguen juntándose', () => {
    expect(positionGroupKey(pos('US5949181045 (USD)', 'US5949181045'), deps))
      .toBe(positionGroupKey(pos('US5949181045 (USD)', 'US5949181045'), deps));
  });

  it('valores distintos no se mezclan', () => {
    expect(positionGroupKey(pos('AMZN (USD)'), deps)).not.toBe(positionGroupKey(pos('UBER (USD)'), deps));
  });

  it('usa el mapa de tickers de la sesión (fondos resueltos al importar)', () => {
    const key = positionGroupKey(pos('MI FONDO GLOBAL (EUR)'), { ...deps, dynamicTickerMap: { 'MI FONDO GLOBAL': '0P0000XXXX.F' } });
    expect(key).toBe('0P0000XXXX.F');
  });

  it('sin nada resoluble cae al ISIN y luego al id', () => {
    const noResolve = { tickerMap: {}, resolveTicker: () => null };
    expect(positionGroupKey(pos('', 'XS0000000000'), noResolve)).toBe('XS0000000000');
    expect(positionGroupKey({ assets: {}, asset_id: 'a1' }, noResolve)).toBe('a1');
  });
});
