import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { performanceService, cagrWorkedExample } from './performanceService';

describe('performanceService.calculateDailyTWR', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns an empty array for null or empty transactions', () => {
    vi.setSystemTime(new Date('2024-01-15T00:00:00Z'));
    expect(performanceService.calculateDailyTWR(null)).toEqual([]);
    expect(performanceService.calculateDailyTWR([])).toEqual([]);
  });

  it('parses DB-format transaction_date (ISO with T-separator) into YYYY-MM-DD', () => {
    vi.setSystemTime(new Date('2024-01-03T00:00:00Z'));
    const result = performanceService.calculateDailyTWR(
      [{
        transaction_date: '2024-01-01T14:30:00.000Z',
        type: 'BUY',
        cantidad: 10, precio: 50, moneda: 'EUR',
        producto: 'MSFT', isin: 'PERF_ISO001',
      }],
      { 'PERF_ISO001': [{ time: '2024-01-01', close: 50 }] }
    );
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].date).toBe('2024-01-01');
  });

  it('spans from the first transaction date through today', () => {
    vi.setSystemTime(new Date('2024-01-05T00:00:00Z'));
    const result = performanceService.calculateDailyTWR(
      [{
        transaction_date: '2024-01-03T00:00:00Z',
        type: 'BUY',
        cantidad: 5, precio: 100, moneda: 'EUR',
        producto: 'AAPL', isin: 'PERF_SPAN01',
      }],
      {
        'PERF_SPAN01': [
          { time: '2024-01-03', close: 100 },
          { time: '2024-01-04', close: 105 },
          { time: '2024-01-05', close: 110 },
        ],
      }
    );
    expect(result[0].date).toBe('2024-01-03');
    expect(result[result.length - 1].date).toBe('2024-01-05');
    expect(result.length).toBe(3);
  });

  it('each output point contains all required fields', () => {
    vi.setSystemTime(new Date('2024-01-02T00:00:00Z'));
    const result = performanceService.calculateDailyTWR(
      [{
        transaction_date: '2024-01-01T00:00:00Z',
        type: 'BUY',
        cantidad: 10, precio: 50, moneda: 'EUR',
        producto: 'META', isin: 'PERF_SHPE01',
      }],
      { 'PERF_SHPE01': [{ time: '2024-01-01', close: 50 }] }
    );
    expect(result.length).toBeGreaterThan(0);
    const pt = result[0];
    expect(pt).toHaveProperty('date');
    expect(pt).toHaveProperty('value');
    expect(pt).toHaveProperty('yield');
    expect(pt).toHaveProperty('dailyReturn');
    expect(pt).toHaveProperty('simpleROI');
    expect(pt).toHaveProperty('breakdown');
    expect(pt).toHaveProperty('displayYield');
  });

  it('yield is 0 on the buy day because there are no prior holdings to measure against', () => {
    vi.setSystemTime(new Date('2024-03-01T00:00:00Z'));
    const result = performanceService.calculateDailyTWR(
      [{
        transaction_date: '2024-03-01T00:00:00Z',
        type: 'BUY',
        cantidad: 10, precio: 100, moneda: 'EUR',
        producto: 'GOOG', isin: 'PERF_ZERO01',
      }],
      { 'PERF_ZERO01': [{ time: '2024-03-01', close: 100 }] }
    );
    expect(result[0].yield).toBe(0);
  });

  it('TWR chains daily sub-period returns and is unaffected by the size of new cash flows', () => {
    // Asset price path: 10 → 15 → 15 → 20 (doubles over four days).
    // A second BUY of equal size is made on day 3 at the intermediate price.
    //   Sub-period 1 (day 1→2): return = (15−10)/10 = +50%
    //   Sub-period 2 (day 3→4): return = (20−15)/15 = +33.3%
    //   TWR = (1.50 × 1.333...) − 1 = +100%
    //
    // A simple money-weighted return would be less than 100% because the second
    // BUY deployed more capital at the already-higher price. TWR strips out that
    // distortion — it measures per-unit price appreciation only.
    vi.setSystemTime(new Date('2024-02-04T00:00:00Z'));
    const transactions = [
      {
        transaction_date: '2024-02-01T00:00:00Z',
        type: 'BUY', cantidad: 100, precio: 10, moneda: 'EUR',
        producto: 'TWR_ASSET', isin: 'PERF_TWR001',
      },
      {
        transaction_date: '2024-02-03T00:00:00Z',
        type: 'BUY', cantidad: 100, precio: 15, moneda: 'EUR',
        producto: 'TWR_ASSET', isin: 'PERF_TWR001',
      },
    ];
    const prices = {
      'PERF_TWR001': [
        { time: '2024-02-01', close: 10 },
        { time: '2024-02-02', close: 15 },
        { time: '2024-02-03', close: 15 },
        { time: '2024-02-04', close: 20 },
      ],
    };
    const result = performanceService.calculateDailyTWR(transactions, prices);
    const last = result[result.length - 1];
    expect(last.date).toBe('2024-02-04');
    expect(last.yield).toBeCloseTo(100, 0);
  });

  it('TTWROR includes the currency return of foreign-currency assets (yield chain does not)', () => {
    vi.setSystemTime(new Date('2024-01-03T00:00:00Z'));
    // USD asset (plain ticker → inferTickerCurrency = USD), flat price, USD/EUR +10%.
    // A EUR investor gained 10% purely from FX — the TTWROR chain must show it.
    const result = performanceService.calculateDailyTWR(
      [{
        transaction_date: '2024-01-01T00:00:00Z',
        type: 'BUY', cantidad: 10, precio: 100, moneda: 'USD',
        producto: 'NVDA',
      }],
      {
        'NVDA': [
          { time: '2024-01-01', close: 100 },
          { time: '2024-01-02', close: 100 },
          { time: '2024-01-03', close: 100 },
        ],
      },
      {
        USD: [
          { time: '2024-01-01', close: 1.00 },
          { time: '2024-01-02', close: 1.05 },
          { time: '2024-01-03', close: 1.10 },
        ],
      },
      { USD: 1.10 },
      'EUR'
    );
    const last = result[result.length - 1];
    expect(last.ttwror).toBeCloseTo(10, 1);  // +10% FX gain captured
    expect(last.yield).toBeCloseTo(0, 1);    // price-only chain blind to FX
  });

  it('keeps TTWROR flat after a full sale (sold assets stop compounding, no jump)', () => {
    vi.setSystemTime(new Date('2024-01-04T00:00:00Z'));
    const result = performanceService.calculateDailyTWR(
      [
        {
          transaction_date: '2024-01-01T00:00:00Z',
          type: 'BUY', cantidad: 10, precio: 100, moneda: 'EUR',
          producto: 'SAP.DE',
        },
        {
          transaction_date: '2024-01-02T00:00:00Z',
          type: 'SELL', cantidad: 10, precio: 110, moneda: 'EUR',
          producto: 'SAP.DE',
        },
      ],
      {
        'SAP.DE': [
          { time: '2024-01-01', close: 100 },
          { time: '2024-01-02', close: 110 },
          { time: '2024-01-03', close: 150 }, // post-sale rally must NOT count
          { time: '2024-01-04', close: 150 },
        ],
      },
      {}, {}, 'EUR'
    );
    const last = result[result.length - 1];
    expect(last.ttwror).toBeCloseTo(10, 1); // +10% locked at sale; 150€ rally ignored
  });
});

describe('cagrWorkedExample — la cuenta que explica la anualizada', () => {
  // Caso real del owner (2026-10-16): TWR +75,08 % en 1,99 años → +32,45 % anual.
  it('reconstruye el TWR, la media que da "de más" y la evolución de 100', () => {
    const ex = cagrWorkedExample({ cagrPct: 32.45, years: 1.99 });
    expect(ex.twrPct).toBeCloseTo(75.0, 0);
    expect(ex.naiveAvgPct).toBeCloseTo(37.7, 0);       // TWR ÷ años: lo que uno espera ver
    expect(ex.naiveAvgPct).toBeGreaterThan(32.45);       // y siempre sale de más
    expect(ex.afterFirstYear).toBeCloseTo(132.45, 2);    // 100 → 132,45 el primer año
    expect(ex.final).toBeCloseTo(100 + ex.twrPct, 6);    // … y al final, 100 + TWR
  });

  it('con menos de un año no hay "primer año" que enseñar', () => {
    expect(cagrWorkedExample({ cagrPct: 20, years: 0.7 }).afterFirstYear).toBeNull();
  });

  it('sin datos, null', () => {
    expect(cagrWorkedExample({ cagrPct: null, years: 2 })).toBeNull();
    expect(cagrWorkedExample({ cagrPct: 10, years: 0 })).toBeNull();
  });
});
