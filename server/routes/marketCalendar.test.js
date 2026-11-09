import { describe, it, expect, vi } from 'vitest';
import { createCalendarStore } from './marketCalendar.js';

const ROWS = [{ symbol: 'AAPL', exDate: '2026-11-10' }];

function setup(fetchImpl, { ttlMs = 1000, failTtlMs = 100 } = {}) {
  let t = 0;
  const fetcher = vi.fn(fetchImpl);
  const get = createCalendarStore({ fetchers: { dividends: fetcher }, ttlMs, failTtlMs, now: () => t });
  return { get, fetcher, advance: (ms) => { t += ms; } };
}

describe('createCalendarStore', () => {
  it('construye una vez y sirve de caché mientras está fresco', async () => {
    const { get, fetcher, advance } = setup(async () => ROWS);
    expect(await get('dividends')).toMatchObject({ status: 200, rows: ROWS });
    advance(999);
    await get('dividends');
    expect(fetcher).toHaveBeenCalledTimes(1);
    advance(2);
    await get('dividends');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('las peticiones simultáneas comparten UNA construcción', async () => {
    let release;
    const { get, fetcher } = setup(() => new Promise((r) => { release = () => r(ROWS); }));
    const all = Promise.all([get('dividends'), get('dividends'), get('dividends')]);
    release();
    const results = await all;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('un calendario vacío no se guarda: 503 y no se reintenta hasta pasado failTtl', async () => {
    const { get, fetcher, advance } = setup(async () => []);
    expect((await get('dividends')).status).toBe(503);
    advance(50);
    expect((await get('dividends')).status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(1);
    advance(60);
    await get('dividends');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('si la renovación falla, sirve los datos anteriores', async () => {
    let fail = false;
    const { get, advance } = setup(async () => { if (fail) throw new Error('nasdaq 403'); return ROWS; });
    await get('dividends');
    fail = true;
    advance(2000); // caducado
    expect(await get('dividends')).toMatchObject({ status: 200, rows: ROWS });
  });

  it('un tipo desconocido es 404 y no llama a nada', async () => {
    const { get, fetcher } = setup(async () => ROWS);
    expect((await get('splits')).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
