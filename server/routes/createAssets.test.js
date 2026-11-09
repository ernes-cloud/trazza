import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const rpc = vi.fn();
vi.mock('../lib/requireUser.js', () => ({
  requireUser: vi.fn(async (req, res) => {
    if (!req.headers?.authorization?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing Authorization header' });
      return null;
    }
    return { id: 'u1' };
  }),
}));
vi.mock('../lib/adminSupabase.js', () => ({
  supabaseAdmin: { rpc: (...args) => rpc(...args) },
}));
vi.mock('../lib/logBuffer.js', () => ({ addLog: vi.fn() }));

const {
  sanitizeTicker, sanitizeAssets, createAssets, MAX_ASSETS_PER_REQUEST, isAcceptableIsin,
} = await import('./createAssets.js');

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  return res;
}

const ROOT = path.resolve(import.meta.dirname, '../..');

describe('sanitizeTicker / sanitizeAssets', () => {
  it('acepta tickers reales (bolsa, cash, ISIN-keyed, crypto) y rechaza basura', () => {
    expect(sanitizeTicker('AAPL')).toBe('AAPL');
    expect(sanitizeTicker('IWDA.AS')).toBe('IWDA.AS');
    expect(sanitizeTicker('CASH_EUR')).toBe('CASH_EUR');
    expect(sanitizeTicker('CASH_EUR (EUR)')).toBe('CASH_EUR (EUR)');
    expect(sanitizeTicker('US0378331005 (USD)')).toBe('US0378331005 (USD)');
    expect(sanitizeTicker('BTC-USD')).toBe('BTC-USD');
    // r17b: sin upper(); placeholders prod con espacios/()[]/&/
    expect(sanitizeTicker('ISHARES CORE (ACC) S&P/500 [EUR]'))
      .toBe('ISHARES CORE (ACC) S&P/500 [EUR]');
    expect(sanitizeTicker('mixedCase')).toBe('mixedCase');
    expect(sanitizeTicker('  spaced  ')).toBe('spaced');
    // No upper(): el match a existentes (espacios / otro case) es de ensure_asset.
    expect(sanitizeTicker('aapl')).toBe('aapl');
    expect(sanitizeTicker('')).toBeNull();
    expect(sanitizeTicker('x'.repeat(121))).toBeNull();
    expect(sanitizeTicker('bad\n')).toBeNull();
    expect(sanitizeTicker('bad\ttab')).toBeNull();
  });

  it('acepta ISIN ISO y marcadores CASH_*; rechaza basura', () => {
    expect(isAcceptableIsin('US0378331005')).toBe(true);
    expect(isAcceptableIsin('CASH_EUR')).toBe(true);
    expect(isAcceptableIsin('CASH_USDT')).toBe(true);
    expect(isAcceptableIsin('NOTANISIN')).toBe(false);
    expect(isAcceptableIsin('CASH_')).toBe(false);
  });

  it('valida ISIN, currency 3–5, asset_class; ignora current_price; fuerza Cash en CASH_*', () => {
    const rows = sanitizeAssets([
      { ticker: 'AAPL', isin: 'US0378331005', currency: 'usd', asset_class: 'Stock', current_price: 190 },
      { ticker: 'CASH_EUR (EUR)', isin: 'CASH_EUR', currency: 'EUR', asset_class: 'Stock', current_price: 1 },
      { ticker: 'USDT', isin: 'CASH_USDT', currency: 'USDT', asset_class: 'Cash' },
      { ticker: 'BAD', isin: 'NOTANISIN' },
      { ticker: 'NEG', current_price: -1 }, // precio ignorado: la fila entra
      { ticker: 'CLS', asset_class: 'Hacker' },
      { ticker: 'AAPL', company_name: 'dup' }, // dedup
    ]);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      ticker: 'AAPL', isin: 'US0378331005', currency: 'USD', asset_class: 'Stock',
    });
    expect(rows[0]).not.toHaveProperty('current_price');
    expect(rows[1]).toMatchObject({
      ticker: 'CASH_EUR (EUR)', isin: 'CASH_EUR', asset_class: 'Cash', currency: 'EUR',
    });
    expect(rows[2]).toMatchObject({ ticker: 'USDT', isin: 'CASH_USDT', currency: 'USDT', asset_class: 'Cash' });
    expect(rows[3].ticker).toBe('NEG');
  });

  it('DeGiro completo: 3/3 filas (2 acciones + CASH_EUR) pasan sanitize', () => {
    const rows = sanitizeAssets([
      { ticker: 'NL0010273215 (EUR)', isin: 'NL0010273215', currency: 'EUR', asset_class: 'ETF' },
      { ticker: 'US0378331005 (USD)', isin: 'US0378331005', currency: 'USD', asset_class: 'Stock' },
      { ticker: 'CASH_EUR (EUR)', isin: 'CASH_EUR', currency: 'EUR', asset_class: 'Cash', current_price: 1 },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.ticker)).toEqual([
      'NL0010273215 (EUR)', 'US0378331005 (USD)', 'CASH_EUR (EUR)',
    ]);
  });

  it(`cap a ${MAX_ASSETS_PER_REQUEST} por petición`, () => {
    const many = Array.from({ length: MAX_ASSETS_PER_REQUEST + 5 }, (_, i) => ({ ticker: `T${i}` }));
    expect(sanitizeAssets(many)).toHaveLength(MAX_ASSETS_PER_REQUEST);
  });
});

describe('POST /api/assets', () => {
  beforeEach(() => { rpc.mockReset(); });

  it('401 sin Bearer', async () => {
    const res = mockRes();
    await createAssets({ headers: {}, body: { assets: [{ ticker: 'AAPL' }] } }, res);
    expect(res.statusCode).toBe(401);
  });

  it('devuelve existentes vía ensure_asset sin fijar precio (no sobrescribe)', async () => {
    rpc.mockResolvedValueOnce({ data: 'a1', error: null });
    const res = mockRes();
    await createAssets(
      { headers: { authorization: 'Bearer tok' }, body: { assets: [{ ticker: 'AAPL', current_price: 0.01, company_name: 'HACK' }] } },
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ assets: [{ id: 'a1', ticker: 'AAPL' }] });
    expect(rpc).toHaveBeenCalledWith('ensure_asset', {
      p_ticker: 'AAPL',
      p_company_name: 'HACK',
      p_asset_class: 'Stock',
      p_currency: null,
      p_isin: null,
    });
    expect(rpc.mock.calls[0][1]).not.toHaveProperty('p_current_price');
    expect(rpc.mock.calls[0][1]).not.toHaveProperty('current_price');
  });

  it('ensure_asset por ticker que falta (service role)', async () => {
    rpc.mockResolvedValueOnce({ data: 'n1', error: null });
    const res = mockRes();
    await createAssets(
      {
        headers: { authorization: 'Bearer tok' },
        body: { assets: [{ ticker: 'MSFT', company_name: 'Microsoft', asset_class: 'Stock', currency: 'USD', current_price: 420 }] },
      },
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.assets).toEqual([{ id: 'n1', ticker: 'MSFT' }]);
    expect(rpc).toHaveBeenCalledWith('ensure_asset', expect.objectContaining({
      p_ticker: 'MSFT',
      p_company_name: 'Microsoft',
      p_currency: 'USD',
    }));
    expect(JSON.stringify(rpc.mock.calls[0][1])).not.toMatch(/420|current_price|p_current_price/);
  });

  it('DeGiro 3/3: CASH_EUR + 2 ISIN llegan a ensure_asset', async () => {
    rpc
      .mockResolvedValueOnce({ data: 'id1', error: null })
      .mockResolvedValueOnce({ data: 'id2', error: null })
      .mockResolvedValueOnce({ data: 'id3', error: null });
    const res = mockRes();
    await createAssets(
      {
        headers: { authorization: 'Bearer tok' },
        body: {
          assets: [
            { ticker: 'NL0010273215 (EUR)', isin: 'NL0010273215', currency: 'EUR', asset_class: 'ETF' },
            { ticker: 'US0378331005 (USD)', isin: 'US0378331005', currency: 'USD', asset_class: 'Stock' },
            { ticker: 'CASH_EUR (EUR)', isin: 'CASH_EUR', currency: 'EUR', asset_class: 'Cash', current_price: 1 },
          ],
        },
      },
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.assets).toHaveLength(3);
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc.mock.calls[2][1]).toMatchObject({
      p_ticker: 'CASH_EUR (EUR)',
      p_isin: 'CASH_EUR',
      p_asset_class: 'Cash',
    });
  });

  it('Binance USDT/EUR pasan por POST /api/assets (currency 4 letras + isin CASH_*)', async () => {
    rpc
      .mockResolvedValueOnce({ data: 'u1', error: null })
      .mockResolvedValueOnce({ data: 'e1', error: null });
    const res = mockRes();
    await createAssets(
      {
        headers: { authorization: 'Bearer tok' },
        body: {
          assets: [
            { ticker: 'USDT', isin: 'CASH_USDT', currency: 'USDT', asset_class: 'Cash' },
            { ticker: 'EUR', isin: 'CASH_EUR', currency: 'EUR', asset_class: 'Cash' },
          ],
        },
      },
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.assets).toEqual([
      { id: 'u1', ticker: 'USDT' },
      { id: 'e1', ticker: 'EUR' },
    ]);
    expect(rpc).toHaveBeenCalledWith('ensure_asset', expect.objectContaining({
      p_ticker: 'USDT', p_currency: 'USDT', p_isin: 'CASH_USDT',
    }));
  });

  it('500 si ensure_asset falla', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    const res = mockRes();
    await createAssets(
      { headers: { authorization: 'Bearer tok' }, body: { assets: [{ ticker: 'X' }] } },
      res,
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Could not save assets' });
  });
});

describe('migración FASE 1 20261027000100 (ensure_asset aditivo)', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20261027000100_assets_insert_server_only.sql'), 'utf8');
  const sql = raw.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

  it('crea UNIQUE(ticker) + ensure_asset; NO dropea la policy ni REVOKE de tabla', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS assets_ticker_key/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.ensure_asset\s*\(/);
    // r18: sin árbitro, para absorber también assets_ticker_norm_key.
    expect(sql).toMatch(/ON CONFLICT DO NOTHING/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS assets_ticker_norm_key ON public\.assets \(lower\(btrim\(ticker\)\)\)/);
    expect(sql).toMatch(/indisunique/);
    expect(sql.indexOf('duplicados bajo lower(btrim(ticker))')).toBeGreaterThan(-1);
    expect(sql.indexOf('duplicados bajo lower(btrim(ticker))'))
      .toBeLessThan(sql.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS assets_ticker_norm_key'));
    expect(sql).toMatch(/CASH_/);
    expect(sql).toMatch(/\[A-Z\]\{3,5\}/);
    expect(sql).toMatch(/v_price := 1/);
    // r17c: sin upper(ticker); lookup exacto O lower(btrim); solo altas ≤120/cntrl.
    expect(sql).toMatch(/t := btrim\(coalesce\(p_ticker, ''\)\);/);
    expect(sql).not.toMatch(/t := upper\(btrim/);
    expect(sql).toMatch(
      /SELECT a\.id INTO aid FROM public\.assets a WHERE a\.ticker = t OR lower\(btrim\(a\.ticker\)\) = lower\(t\) ORDER BY \(a\.ticker = t\) DESC LIMIT 1;/,
    );
    expect(sql).toMatch(/IF FOUND THEN/);
    expect(sql).toMatch(/LIKE 'CASH\\_%'/);
    expect(sql).not.toMatch(/LIKE 'CASH_%'/);
    expect(sql).toMatch(/\[\[:cntrl:\]\]/);
    expect(sql).toMatch(/char_length\(t\) > 120/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.ensure_asset\(text, text, text, text, text\) TO service_role/);
    expect(sql).toMatch(/REVOKE EXECUTE ON FUNCTION public\.ensure_asset/);
    expect(sql).not.toMatch(/DROP POLICY/);
    expect(sql).not.toMatch(/REVOKE INSERT/);
    expect(sql).not.toMatch(/CREATE POLICY/i);
    // Cabecera apunta a FASE 2 ≥ 20261029000300.
    expect(raw).toMatch(/20261029000300_assets_insert_revoke/);
  });
});

describe('migración FASE 2 20261029000300 (DROP POLICY + REVOKE)', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20261029000300_assets_insert_revoke.sql'), 'utf8')
    .split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

  it('quita la política de INSERT (sin IF EXISTS) y REVOKE de assets', () => {
    expect(sql).toMatch(/DROP POLICY "assets_insert_authenticated" ON public\.assets;/);
    expect(sql).not.toMatch(/DROP POLICY IF EXISTS "assets_insert_authenticated"/);
    expect(sql).toMatch(/REVOKE INSERT, DELETE, TRUNCATE ON public\.assets FROM PUBLIC, anon, authenticated;/);
    expect(sql).toMatch(/REVOKE UPDATE, REFERENCES, TRIGGER ON public\.assets FROM PUBLIC, anon, authenticated;/);
    expect(sql).toMatch(/REVOKE SELECT ON public\.assets FROM anon;/);
    expect(sql).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON public\.assets TO service_role;/);
    expect(sql).toMatch(/GRANT SELECT ON public\.assets TO authenticated;/);
    expect(sql).not.toMatch(/ensure_asset/);
  });
});

describe('rate limiters separados assets vs ticker-mappings', () => {
  it('app.js usa assetsLimiter en /api/assets y mappingsLimiter en /api/ticker-mappings', () => {
    // Rutas viven en createApp (server/app.js) tras el extract N1; limiters siguen separados.
    const src = fs.readFileSync(path.join(ROOT, 'server/app.js'), 'utf8');
    expect(src).toMatch(/const assetsLimiter = rateLimit\(/);
    expect(src).toMatch(/const mappingsLimiter = rateLimit\(/);
    expect(src).toMatch(/app\.post\('\/api\/assets',\s*(?:asyncHandler\()?assetsLimiter/);
    expect(src).toMatch(/app\.post\('\/api\/ticker-mappings',\s*(?:asyncHandler\()?mappingsLimiter/);
    // No compartir el mismo limitador entre ambos.
    expect(src).not.toMatch(/app\.post\('\/api\/assets',\s*(?:asyncHandler\()?mappingsLimiter/);
  });
});

describe('harness PG no descarga binarios', () => {
  it('pg20261026.harness.js usa PG_BIN y no apt-get/dpkg en código ejecutable', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/lib/pg20261026.harness.js'), 'utf8')
      .split('\n').map((l) => l.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');
    // Quitar block comments multilínea restantes
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).toMatch(/PG_BIN/);
    expect(code).not.toMatch(/apt-get/);
    expect(code).not.toMatch(/dpkg-deb/);
    expect(code).not.toMatch(/spawnSync\(\s*['"]apt-get['"]/);
  });
});
