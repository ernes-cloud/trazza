import { describe, it, expect } from 'vitest';
import { barDateFromTimestamp } from './yahooFinance';

/**
 * Real timestamps captured from Yahoo's chart API (2026-07-30). The weekly
 * bars of ^IBEX and ^GSPC are the SAME trading week; read as UTC they land on
 * different days, which emptied the backtest's date intersection.
 */
describe('barDateFromTimestamp', () => {
  it('puts a European weekly bar on the Monday, not the Sunday before', () => {
    // ^IBEX, week of 2025-07-28, stamped at Madrid midnight (UTC+2)
    expect(barDateFromTimestamp(1753653600, 7200)).toBe('2025-07-28');
  });

  it('keeps a US weekly bar on the same Monday', () => {
    // ^GSPC, same week, stamped at New York midnight (UTC-4)
    expect(barDateFromTimestamp(1753675200, -14400)).toBe('2025-07-28');
  });

  it('aligns European and US weekly bars of the same week (the ^IBEX + ^GSPC bug)', () => {
    expect(barDateFromTimestamp(1753653600, 7200)).toBe(barDateFromTimestamp(1753675200, -14400));
  });

  it('rolls a month-start bar stamped the previous evening into the 1st', () => {
    // VUAA.L monthly bar for April 2026: 2026-03-31T23:00:00Z at UTC+1
    expect(barDateFromTimestamp(Date.parse('2026-03-31T23:00:00Z') / 1000, 3600)).toBe('2026-04-01');
  });

  it('leaves daily bars on their trading date (open is hours from midnight)', () => {
    // ^IBEX 09:00 Madrid / AAPL 09:30 New York, same session date
    expect(barDateFromTimestamp(Date.parse('2026-07-28T07:00:00Z') / 1000, 7200)).toBe('2026-07-28');
    expect(barDateFromTimestamp(Date.parse('2026-07-28T13:30:00Z') / 1000, -14400)).toBe('2026-07-28');
  });

  it('leaves 24/7 series untouched (crypto reports offset 0)', () => {
    expect(barDateFromTimestamp(Date.parse('2026-07-29T00:00:00Z') / 1000, 0)).toBe('2026-07-29');
  });

  it('tolerates a missing or invalid offset, and rejects a bad timestamp', () => {
    expect(barDateFromTimestamp(Date.parse('2026-07-28T13:30:00Z') / 1000)).toBe('2026-07-28');
    expect(barDateFromTimestamp(Date.parse('2026-07-28T13:30:00Z') / 1000, null)).toBe('2026-07-28');
    expect(barDateFromTimestamp(undefined, 7200)).toBeNull();
  });
});
