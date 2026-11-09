import { describe, it, expect } from 'vitest';
import { countryFromIsin, countryFromTicker } from './listingCountry';

describe('countryFromIsin', () => {
  it('lee el prefijo ISO', () => {
    expect(countryFromIsin('US0378331005')).toBe('United States');
    expect(countryFromIsin('es0113900J37')).toBe('Spain');
    expect(countryFromIsin('IE00B4L5Y983')).toBe('Ireland');
  });
  it('null si no lo conoce o no hay ISIN', () => {
    expect(countryFromIsin('XS1234567890')).toBeNull();
    expect(countryFromIsin('')).toBeNull();
    expect(countryFromIsin(undefined)).toBeNull();
  });
});

describe('countryFromTicker', () => {
  it.each([
    ['VUAA.L', 'United Kingdom'], ['MC.PA', 'France'], ['ASML.AS', 'Netherlands'],
    ['SAP.DE', 'Germany'], ['SAN.MC', 'Spain'], ['7203.T', 'Japan'],
    ['CSU.TO', 'Canada'], ['0700.HK', 'Hong Kong'], ['RELIANCE.NS', 'India'],
  ])('%s → %s', (ticker, country) => {
    expect(countryFromTicker(ticker)).toBe(country);
  });

  it('cripto es Global, liquidez null, símbolo sin sufijo es EE. UU.', () => {
    expect(countryFromTicker('BTC-USD')).toBe('Global');
    expect(countryFromTicker('CASH_EUR')).toBeNull();
    expect(countryFromTicker('aapl')).toBe('United States');
  });

  it('null para lo que no reconoce', () => {
    expect(countryFromTicker('IE00B4L5Y983')).toBeNull();
    expect(countryFromTicker('')).toBeNull();
  });
});
