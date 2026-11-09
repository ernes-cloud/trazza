import { describe, it, expect, vi, beforeEach } from 'vitest';

const from = vi.fn();
const getSession = vi.fn();
vi.mock('@/lib/customSupabaseClient', () => ({ supabase: { from, auth: { getSession } } }));

const { saveTickerMappings } = await import('./tickerMappingService');

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('saveTickerMappings — el catálogo compartido se escribe por el server', () => {
  beforeEach(() => {
    from.mockReset();
    getSession.mockReset();
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ saved: 1, rejected: 0 }) }));
  });

  it('manda los pares válidos a /api/ticker-mappings con la sesión, nunca a la tabla', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
    saveTickerMappings({ IE00B4L5Y983: 'IWDA.AS', NOTANISIN: 'X', US5949181045: 'CASH_EUR' });
    await flush();
    expect(from).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/ticker-mappings');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual({ mappings: { IE00B4L5Y983: 'IWDA.AS' } });
  });

  it('sin sesión (demo o fuera de sesión) no manda nada', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    saveTickerMappings({ IE00B4L5Y983: 'IWDA.AS' });
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it('parte en lotes de 25 (el tope del server)', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`US${String(i).padStart(9, '0')}0`, 'AAPL']));
    saveTickerMappings(many);
    await flush(); await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(Object.keys(JSON.parse(fetch.mock.calls[0][1].body).mappings)).toHaveLength(25);
    expect(Object.keys(JSON.parse(fetch.mock.calls[1][1].body).mappings)).toHaveLength(5);
  });
});
