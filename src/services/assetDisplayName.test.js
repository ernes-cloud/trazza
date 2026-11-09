import { describe, it, expect } from 'vitest';
import { assetDisplayName } from './assetDisplayName';
import { curatedFundDisplayName, curatedFundForSymbol } from './import/fundNavEnricher';

describe('curatedFundDisplayName', () => {
  it('traduce el nombre recortado del extracto de MyInvestor al legible', () => {
    expect(curatedFundDisplayName('BGIF EM MKT GOVER BOND INDEX D'))
      .toBe('iShares Emerging Markets Government Bond Index Fund (LU) D2 EUR');
  });

  it('acepta el nombre como se guarda en assets (sufijo de divisa y [importe])', () => {
    expect(curatedFundDisplayName('VANGUARD 20 (EUR)')).toBe('Vanguard 20+ Year Euro Treasury Index Fund EUR Acc');
    expect(curatedFundDisplayName('VANGUARD 20 [importe] (EUR)')).toBe('Vanguard 20+ Year Euro Treasury Index Fund EUR Acc');
  });

  it('entiende las grafías alternativas (alias) del mismo fondo', () => {
    expect(curatedFundDisplayName('ISHARES US INDEX FUND (IE) - S')).toBe('iShares US Equity Index Fund (IE) S Acc EUR');
  });

  it('un fondo no curado no tiene nombre legible', () => {
    expect(curatedFundDisplayName('APPLE INC')).toBeNull();
    expect(curatedFundDisplayName(null)).toBeNull();
  });
});

describe('curatedFundForSymbol', () => {
  it('reconoce la clase USD con la que se valora un fondo EUR', () => {
    expect(curatedFundForSymbol('0P0001DCMP')).toEqual({
      name: 'iShares Emerging Markets Government Bond Index Fund (LU) D2 EUR',
      isUsdProxy: true,
    });
  });

  it('el símbolo curado de la clase EUR no es un proxy', () => {
    expect(curatedFundForSymbol('0P0001XF3Z.F')).toEqual({
      name: 'iShares Emerging Markets Index Fund (IE) S Acc EUR',
      isUsdProxy: false,
    });
  });

  it('un símbolo cualquiera no es un fondo curado', () => {
    expect(curatedFundForSymbol('AAPL')).toBeNull();
  });
});

describe('assetDisplayName', () => {
  it('un fondo curado se enseña con su nombre legible', () => {
    expect(assetDisplayName({ ticker: 'BGIF EM MKT GOVER BOND INDEX D (EUR)', company_name: 'BGIF EM MKT GOVER BOND INDEX D' }))
      .toBe('iShares Emerging Markets Government Bond Index Fund (LU) D2 EUR');
  });

  it('cualquier otro activo conserva su nombre, o el ticker si no tiene', () => {
    expect(assetDisplayName({ ticker: 'AAPL', company_name: 'Apple Inc.' })).toBe('Apple Inc.');
    expect(assetDisplayName({ ticker: 'AAPL' })).toBe('AAPL');
    expect(assetDisplayName(null)).toBeNull();
  });
});
