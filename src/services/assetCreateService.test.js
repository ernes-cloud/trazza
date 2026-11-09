import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpc = vi.fn();
const getSession = vi.fn();
vi.mock('@/lib/customSupabaseClient', () => ({
  supabase: {
    rpc: (...a) => rpc(...a),
    from: () => ({ insert: () => { throw new Error('from(assets).insert prohibido'); } }),
    auth: { getSession },
  },
}));

const { createAssets } = await import('./assetCreateService.js');

describe('createAssets (cliente)', () => {
  beforeEach(() => {
    rpc.mockReset();
    getSession.mockReset();
  });

  it('sin sesión (demo): ensure_asset vía supabase mock (sin insert)', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    rpc.mockResolvedValue({ data: 'd1', error: null });
    const out = await createAssets([{ ticker: 'CASH_EUR', asset_class: 'Cash', currency: 'EUR', current_price: 1 }]);
    expect(out).toEqual([{ id: 'd1', ticker: 'CASH_EUR' }]);
    expect(rpc).toHaveBeenCalledWith('ensure_asset', {
      p_ticker: 'CASH_EUR',
      p_company_name: null,
      p_asset_class: 'Cash',
      p_currency: 'EUR',
      p_isin: null,
    });
  });

  it('sin sesión: ensure_asset sin id aborta (no insert directo)', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(createAssets([{ ticker: 'X' }]))
      .rejects.toThrow(/ensure_asset returned no id for X/);
  });

  it('con JWT: POST /api/assets y no toca la tabla', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ assets: [{ id: 'a1', ticker: 'AAPL' }] }),
    }));
    const out = await createAssets(
      [{ ticker: 'AAPL', company_name: 'Apple', asset_class: 'Stock', currency: 'USD', current_price: 190 }],
      { fetchImpl },
    );
    expect(out).toEqual([{ id: 'a1', ticker: 'AAPL' }]);
    expect(fetchImpl).toHaveBeenCalledWith('/api/assets', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
    }));
    expect(rpc).not.toHaveBeenCalled();
  });

  it('con JWT: un HTTP no-OK aborta con contexto', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Could not save assets' }),
    }));
    await expect(createAssets([{ ticker: 'X' }], { fetchImpl }))
      .rejects.toThrow(/Assets insert.*Could not save assets/);
  });
});

describe('ningún caller de producción inserta assets a pelo', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const ROOT = path.resolve(import.meta.dirname, '../..');

  function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      return /\.(jsx?|mjs)$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : [];
    });
  }

  it('NADIE en src/ hace from(assets).insert', () => {
    const offenders = walk(path.join(ROOT, 'src')).filter((f) => (
      /from\(\s*['"]assets['"]\s*\)[\s\S]{0,120}?\.insert\(/.test(fs.readFileSync(f, 'utf8'))
    ));
    expect(offenders).toEqual([]);
  });
});
