import { describe, it, expect } from 'vitest';
import { buildCsvChunks, sanitiseCsvRow, csvRowHash } from './csvAiPipeline.js';

const csvOf = (rows) => ['col1,col2,col3', ...rows].join('\n');

describe('buildCsvChunks', () => {
  it('returns a single chunk for small files, not truncated', () => {
    const csv = csvOf(['a,1,2', 'b,3,4']);
    const out = buildCsvChunks(csv);
    expect(out.chunks).toHaveLength(1);
    expect(out.chunks[0]).toBe(csv);
    expect(out.truncated).toBe(false);
    expect(out.totalRows).toBe(2);
    expect(out.analyzedRows).toBe(2);
  });

  it('repeats the header row in every chunk', () => {
    const rows = Array.from({ length: 25 }, (_, i) => `row${i},1,2`);
    const out = buildCsvChunks(csvOf(rows), { chunkRows: 10, maxChunks: 6 });
    expect(out.chunks).toHaveLength(3);
    for (const chunk of out.chunks) {
      expect(chunk.split('\n')[0]).toBe('col1,col2,col3');
    }
    // No data row lost or duplicated across chunks
    const dataLines = out.chunks.flatMap(c => c.split('\n').slice(1));
    expect(dataLines).toEqual(rows);
  });

  it('caps at maxChunks and flags truncation with accurate row counts', () => {
    const rows = Array.from({ length: 50 }, (_, i) => `row${i},1,2`);
    const out = buildCsvChunks(csvOf(rows), { chunkRows: 10, maxChunks: 3 });
    expect(out.chunks).toHaveLength(3);
    expect(out.truncated).toBe(true);
    expect(out.totalRows).toBe(50);
    expect(out.analyzedRows).toBe(30);
  });

  it('strips \\r and blank lines (Windows CSVs)', () => {
    const out = buildCsvChunks('h1,h2\r\n\r\na,1\r\n');
    expect(out.chunks).toEqual(['h1,h2\na,1']);
    expect(out.totalRows).toBe(1);
  });

  it('handles empty and header-only input without throwing', () => {
    expect(buildCsvChunks('')).toEqual({ chunks: [], truncated: false, totalRows: 0, analyzedRows: 0 });
    const headerOnly = buildCsvChunks('col1,col2');
    expect(headerOnly.chunks).toEqual(['col1,col2']);
    expect(headerOnly.truncated).toBe(false);
  });
});

describe('sanitiseCsvRow', () => {
  const validRow = {
    fecha: '24-05-2026', hora: '10:30', type: 'BUY', producto: 'Apple Inc',
    isin: 'US0378331005', cantidad: 10, precio: 150.5, total: -1505, moneda: 'USD', comisiones: 2,
  };

  it('passes a valid row through unchanged', () => {
    expect(sanitiseCsvRow(validRow)).toEqual(validRow);
  });

  it('discards rows with unknown type, missing fecha or missing isin', () => {
    expect(sanitiseCsvRow({ ...validRow, type: 'TRANSFER' })).toBeNull();
    expect(sanitiseCsvRow({ ...validRow, fecha: 'no date' })).toBeNull();
    expect(sanitiseCsvRow({ ...validRow, isin: '' })).toBeNull();
    expect(sanitiseCsvRow(null)).toBeNull();
    expect(sanitiseCsvRow('BUY')).toBeNull();
  });

  it('maps the FEE/DIV aliases the model sometimes emits', () => {
    expect(sanitiseCsvRow({ ...validRow, type: 'FEE' }).type).toBe('FEES');
    expect(sanitiseCsvRow({ ...validRow, type: 'div' }).type).toBe('DIVIDEND');
  });

  it('normalises ISO and slash dates to DD-MM-YYYY (downstream contract)', () => {
    expect(sanitiseCsvRow({ ...validRow, fecha: '2026-05-24' }).fecha).toBe('24-05-2026');
    expect(sanitiseCsvRow({ ...validRow, fecha: '2026-05-24T10:30:00' }).fecha).toBe('24-05-2026');
    expect(sanitiseCsvRow({ ...validRow, fecha: '24/05/2026' }).fecha).toBe('24-05-2026');
    expect(sanitiseCsvRow({ ...validRow, fecha: '4-5-2026' }).fecha).toBe('04-05-2026');
  });

  it('defaults hora to 00:00 when missing or malformed', () => {
    expect(sanitiseCsvRow({ ...validRow, hora: undefined }).hora).toBe('00:00');
    expect(sanitiseCsvRow({ ...validRow, hora: 'mediodía' }).hora).toBe('00:00');
    expect(sanitiseCsvRow({ ...validRow, hora: '9:05:33' }).hora).toBe('09:05');
  });

  it('coerces numeric strings and rejects NaN into 0', () => {
    const r = sanitiseCsvRow({ ...validRow, cantidad: '10', precio: '150,5', comisiones: 'abc' });
    expect(r.cantidad).toBe(10);
    expect(r.precio).toBe(150.5);
    expect(r.comisiones).toBe(0);
  });

  it('enforces money signs by type regardless of what the model returned', () => {
    expect(sanitiseCsvRow({ ...validRow, type: 'BUY', total: 1505 }).total).toBe(-1505);
    expect(sanitiseCsvRow({ ...validRow, type: 'FEES', total: 3 }).total).toBe(-3);
    expect(sanitiseCsvRow({ ...validRow, type: 'SELL', total: -900 }).total).toBe(900);
    expect(sanitiseCsvRow({ ...validRow, type: 'DIVIDEND', total: -12 }).total).toBe(12);
  });

  it('discards rows with no numeric signal at all', () => {
    expect(sanitiseCsvRow({ ...validRow, cantidad: 0, precio: 0, total: 0 })).toBeNull();
  });

  it('validates the currency code and falls back to empty string', () => {
    expect(sanitiseCsvRow({ ...validRow, moneda: 'usd' }).moneda).toBe('USD');
    expect(sanitiseCsvRow({ ...validRow, moneda: 'dollars' }).moneda).toBe('');
    expect(sanitiseCsvRow({ ...validRow, moneda: null }).moneda).toBe('');
  });

  it('falls back producto to the isin when missing', () => {
    expect(sanitiseCsvRow({ ...validRow, producto: '  ' }).producto).toBe('US0378331005');
  });
});

describe('csvRowHash', () => {
  it('is stable for identical rows and distinct for different ones', () => {
    const base = { fecha: '24-05-2026', hora: '10:30', type: 'BUY', isin: 'US1', cantidad: 1, precio: 2, total: -2 };
    expect(csvRowHash(base)).toBe(csvRowHash({ ...base }));
    expect(csvRowHash(base)).not.toBe(csvRowHash({ ...base, cantidad: 3 }));
    expect(csvRowHash(base)).not.toBe(csvRowHash({ ...base, type: 'SELL', total: 2 }));
  });
});
