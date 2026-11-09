import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';

// vi.mock is hoisted above all imports — yahooFinanceService will be mocked
// when currencyService.js imports it.
// importOriginal: getHistoricalRateOnOrBefore usa barDateFromTimestamp (la
// única definición de "fecha de una barra"); solo se sustituye el servicio.
vi.mock('./yahooFinance', async (importOriginal) => ({
  ...(await importOriginal()),
  yahooFinanceService: { getQuote: vi.fn() },
}));

import { currencyService } from './currencyService';
import { yahooFinanceService } from './yahooFinance';

// localStorage is undefined in the node test environment.
// Provide a synchronous in-memory replacement so the caching layer works.
const store = {};
const mockLS = {
  getItem:    (k) => store[k] ?? null,
  setItem:    (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
  clear:      () => { Object.keys(store).forEach(k => delete store[k]); },
};

beforeAll(() => vi.stubGlobal('localStorage', mockLS));
beforeEach(() => {
  vi.clearAllMocks();
  mockLS.clear();
});

// ─── getExchangeRate ──────────────────────────────────────────────────────────

describe('currencyService.getExchangeRate', () => {
  it('returns 1 instantly for the same currency without calling the API', async () => {
    const rate = await currencyService.getExchangeRate('EUR', 'EUR');
    expect(rate).toBe(1);
    expect(yahooFinanceService.getQuote).not.toHaveBeenCalled();
  });

  it('returns 1 when either currency argument is null or undefined', async () => {
    expect(await currencyService.getExchangeRate(null, 'USD')).toBe(1);
    expect(await currencyService.getExchangeRate('EUR', null)).toBe(1);
    expect(yahooFinanceService.getQuote).not.toHaveBeenCalled();
  });

  it('calls Yahoo Finance for an uncached pair and returns the fetched rate', async () => {
    yahooFinanceService.getQuote.mockResolvedValueOnce({ current: 1.08 });
    // Use a fictitious pair so the module-level cache is guaranteed cold for this pair.
    const rate = await currencyService.getExchangeRate('APICALL', 'USD');
    expect(rate).toBe(1.08);
    expect(yahooFinanceService.getQuote).toHaveBeenCalledWith('APICALLUSD=X');
  });

  it('uses the in-memory cache on the second call — API invoked only once per pair', async () => {
    yahooFinanceService.getQuote.mockResolvedValueOnce({ current: 0.75 });
    const r1 = await currencyService.getExchangeRate('MEMTEST1', 'GBP');
    const r2 = await currencyService.getExchangeRate('MEMTEST1', 'GBP');
    expect(r1).toBe(0.75);
    expect(r2).toBe(0.75);
    expect(yahooFinanceService.getQuote).toHaveBeenCalledTimes(1);
  });

  it('warms the in-memory cache from localStorage when memory is cold', async () => {
    // Simulate a fresh entry written by a previous page load.
    const pair = 'LSCACHE1USD=X';
    store['trazza_fx_rates'] = JSON.stringify({ [pair]: { rate: 1.23, timestamp: Date.now() } });

    const rate = await currencyService.getExchangeRate('LSCACHE1', 'USD');
    expect(rate).toBe(1.23);
    expect(yahooFinanceService.getQuote).not.toHaveBeenCalled();
  });

  it('returns a hardcoded fallback rate for well-known pairs when the API throws', async () => {
    yahooFinanceService.getQuote.mockRejectedValueOnce(new Error('Network error'));
    // The module defines EURUSD=X → 1.08 as a hardcoded fallback.
    const rate = await currencyService.getExchangeRate('EUR', 'USD');
    expect(rate).toBe(1.08);
  });

  it('returns 1 when the API throws and the pair has no hardcoded fallback', async () => {
    yahooFinanceService.getQuote.mockRejectedValueOnce(new Error('Network error'));
    const rate = await currencyService.getExchangeRate('UNKNOWN1', 'UNKNOWN2');
    expect(rate).toBe(1);
  });
});

// ─── convert ─────────────────────────────────────────────────────────────────

describe('currencyService.convert', () => {
  it('returns the original amount unchanged when both currencies are equal', async () => {
    const result = await currencyService.convert(250, 'USD', 'USD');
    expect(result).toBe(250);
    expect(yahooFinanceService.getQuote).not.toHaveBeenCalled();
  });

  it('multiplies the amount by the fetched exchange rate', async () => {
    yahooFinanceService.getQuote.mockResolvedValueOnce({ current: 2 });
    const result = await currencyService.convert(100, 'CONV1X', 'CONV2X');
    expect(result).toBe(200);
  });
});

// ─── getHistoricalRate ────────────────────────────────────────────────────────

describe('currencyService.getHistoricalRate', () => {
  afterEach(() => {
    // Remove any fetch stub added inside individual tests, then re-apply the
    // localStorage mock (vi.unstubAllGlobals also removes the beforeAll stub).
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', mockLS);
  });

  it('returns null when from and to currencies are the same', async () => {
    expect(await currencyService.getHistoricalRate('EUR', 'EUR', '2024-01-01')).toBeNull();
  });

  it('returns null when required params are missing', async () => {
    expect(await currencyService.getHistoricalRate(null, 'USD', '2024-01-01')).toBeNull();
    expect(await currencyService.getHistoricalRate('EUR', 'USD', '')).toBeNull();
  });

  it('returns a rate from localStorage without making any network call', async () => {
    // Historical rates are cached permanently — same rate from a year ago is still valid.
    store['wf_hist_EUR_USD_2024-01-01'] = '1.0850';
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const rate = await currencyService.getHistoricalRate('EUR', 'USD', '2024-01-01');
    expect(rate).toBe(1.085);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches the rate from the Yahoo Finance chart endpoint on a cache miss', async () => {
    // Build a minimal Yahoo chart response with one data point close to 2024-06-01.
    const targetTs = Math.floor(new Date('2024-06-01T00:00:00Z').getTime() / 1000);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        chart: {
          result: [{
            timestamp: [targetTs],
            indicators: { quote: [{ close: [1.09] }] },
          }],
        },
      }),
    }));

    const rate = await currencyService.getHistoricalRate('EUR', 'USD', '2024-06-01');
    expect(rate).toBe(1.09);
  });

  it('returns null when both Yahoo Finance and Frankfurter are unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const rate = await currencyService.getHistoricalRate('EUR', 'USD', '2024-07-01');
    expect(rate).toBeNull();
  });
});

// ─── getHistoricalRateOnOrBefore (informe fiscal) ────────────────────────────
// Para Hacienda vale el tipo del día de la operación o, si no hubo mercado, el
// del ÚLTIMO día hábil anterior — nunca uno posterior. getHistoricalRate coge
// el cierre MÁS CERCANO (puede ser el lunes siguiente): esta variante no.

describe('currencyService.getHistoricalRateOnOrBefore', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', mockLS);
  });

  // Barras diarias de FX de Yahoo: selladas a medianoche de Londres (23:00Z del
  // día anterior en verano) con gmtoffset 3600.
  const fxBar = (isoDay) => {
    const [y, m, d] = isoDay.split('-').map(Number);
    return Date.UTC(y, m - 1, d) / 1000 - 3600;
  };
  const yahooResp = (days, closes, meta = { gmtoffset: 3600 }) => ({
    ok: true,
    json: async () => ({
      chart: { result: [{ meta, timestamp: days.map(fxBar), indicators: { quote: [{ close: closes }] } }] },
    }),
  });

  it('en domingo devuelve el viernes aunque el lunes esté más cerca', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      yahooResp(['2024-06-06', '2024-06-07', '2024-06-10'], [1.081, 1.082, 1.090])
    ));
    const r = await currencyService.getHistoricalRateOnOrBefore('USD', 'EUR', '2024-06-09');
    expect(r).toEqual({ rate: 1.082, date: '2024-06-07' });
  });

  it('el mismo día hábil usa su propio cierre', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      yahooResp(['2024-06-06', '2024-06-07'], [1.081, 1.082])
    ));
    const r = await currencyService.getHistoricalRateOnOrBefore('USD', 'EUR', '2024-06-07');
    expect(r).toEqual({ rate: 1.082, date: '2024-06-07' });
  });

  it('no usa la caché de getHistoricalRate (cierre más cercano) y cachea la suya', async () => {
    store['wf_hist_USD_EUR_2024-06-09'] = '9.99';
    const mockFetch = vi.fn().mockResolvedValueOnce(yahooResp(['2024-06-07'], [1.082]));
    vi.stubGlobal('fetch', mockFetch);
    const r1 = await currencyService.getHistoricalRateOnOrBefore('USD', 'EUR', '2024-06-09');
    const r2 = await currencyService.getHistoricalRateOnOrBefore('USD', 'EUR', '2024-06-09');
    expect(r1).toEqual({ rate: 1.082, date: '2024-06-07' });
    expect(r2).toEqual(r1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(store['wf_hist_USD_EUR_2024-06-09']).toBe('9.99');
  });

  it('si Yahoo solo tiene barras posteriores, pasa a Frankfurter (día hábil anterior)', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(yahooResp(['2024-06-10'], [1.090]))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ date: '2024-06-07', rates: { EUR: 0.925 } }) }));
    const r = await currencyService.getHistoricalRateOnOrBefore('USD', 'EUR', '2024-06-09');
    expect(r).toEqual({ rate: 0.925, date: '2024-06-07' });
  });

  it('sin gmtoffset no se fía de Yahoo (la fecha UTC de la barra sería la del día anterior)', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(yahooResp(['2024-06-10'], [1.090], {}))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ date: '2024-06-07', rates: { EUR: 0.925 } }) }));
    const r = await currencyService.getHistoricalRateOnOrBefore('USD', 'EUR', '2024-06-09');
    expect(r).toEqual({ rate: 0.925, date: '2024-06-07' });
  });

  it('rechaza un tipo de Frankfurter con fecha posterior a la pedida', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockRejectedValueOnce(new Error('429'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ date: '2024-06-10', rates: { EUR: 0.93 } }) }));
    const r = await currencyService.getHistoricalRateOnOrBefore('USD', 'EUR', '2024-06-09');
    expect(r).toBeNull();
  });

  it('null si las dos fuentes fallan, y misma divisa o sin fecha → null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await currencyService.getHistoricalRateOnOrBefore('USD', 'EUR', '2024-06-09')).toBeNull();
    expect(await currencyService.getHistoricalRateOnOrBefore('EUR', 'EUR', '2024-06-09')).toBeNull();
    expect(await currencyService.getHistoricalRateOnOrBefore('USD', 'EUR', '')).toBeNull();
  });
});
