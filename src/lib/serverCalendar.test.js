import { describe, it, expect, vi } from 'vitest';
import { fetchServerCalendar } from './serverCalendar';

const respond = (status, body) => vi.fn(async () => ({ ok: status < 400, status, json: async () => body }));

describe('fetchServerCalendar', () => {
  it('devuelve las filas del server', async () => {
    const fetchImpl = respond(200, { rows: [{ symbol: 'AAPL' }] });
    expect(await fetchServerCalendar('dividends', { fetchImpl })).toEqual([{ symbol: 'AAPL' }]);
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/market-calendar/dividends');
  });

  it('null ante un error HTTP, un cuerpo vacío o un fallo de red (el llamante cae al día a día)', async () => {
    expect(await fetchServerCalendar('earnings', { fetchImpl: respond(503, {}) })).toBeNull();
    expect(await fetchServerCalendar('earnings', { fetchImpl: respond(200, { rows: [] }) })).toBeNull();
    expect(await fetchServerCalendar('earnings', { fetchImpl: respond(200, null) })).toBeNull();
    expect(await fetchServerCalendar('earnings', { fetchImpl: vi.fn(async () => { throw new TypeError('network'); }) })).toBeNull();
  });
});
