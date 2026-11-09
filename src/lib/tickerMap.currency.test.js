import { describe, it, expect } from 'vitest';
import { inferTickerCurrency } from './tickerMap';
import { isPenceCurrency } from '../services/yahooFinance';

// Regresión del bug reportado: ETFs del LSE denominados en USD (SMH.L, VUAA.L)
// se trataban como peniques por el sufijo .L → $111.20 se convertía en £1.11.

describe('isPenceCurrency — solo GBp/GBX son peniques', () => {
  it('GBp (minúscula, como lo devuelve Yahoo) y GBX son peniques', () => {
    expect(isPenceCurrency('GBp')).toBe(true);
    expect(isPenceCurrency('GBX')).toBe(true);
  });

  it('GBP (libras), USD y EUR NO son peniques', () => {
    expect(isPenceCurrency('GBP')).toBe(false);
    expect(isPenceCurrency('USD')).toBe(false);
    expect(isPenceCurrency('EUR')).toBe(false);
    expect(isPenceCurrency(undefined)).toBe(false);
    expect(isPenceCurrency(null)).toBe(false);
  });
});

describe('inferTickerCurrency — desambiguación de .L por moneda del asset', () => {
  it('SMH.L con asset USD → USD (no GBP)', () => {
    expect(inferTickerCurrency('SMH.L', 'USD')).toBe('USD');
    expect(inferTickerCurrency('VUAA.L', 'USD')).toBe('USD');
  });

  it('.L sin moneda de asset → GBP (comportamiento por defecto)', () => {
    expect(inferTickerCurrency('LLOY.L')).toBe('GBP');
    expect(inferTickerCurrency('LLOY.L', null)).toBe('GBP');
  });

  it('.L con asset GBP o GBX → GBP (los peniques ya vienen normalizados a GBP)', () => {
    expect(inferTickerCurrency('LLOY.L', 'GBP')).toBe('GBP');
    expect(inferTickerCurrency('ZEG.L', 'GBX')).toBe('GBP');
  });

  it('el resto de sufijos no cambia', () => {
    expect(inferTickerCurrency('ASML.AS')).toBe('EUR');
    expect(inferTickerCurrency('CSU.TO')).toBe('CAD');
    expect(inferTickerCurrency('AAPL')).toBe('USD');
    expect(inferTickerCurrency('BTC-EUR')).toBe('EUR');
  });
});
