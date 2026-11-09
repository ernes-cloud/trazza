import { describe, it, expect, vi, beforeEach } from 'vitest';

const upsert = vi.fn(async () => ({ error: null }));
vi.mock('../lib/adminSupabase.js', () => ({
  supabaseAdmin: { from: vi.fn(() => ({ upsert })) },
}));
vi.mock('../lib/requireUser.js', () => ({
  requireUser: vi.fn(async (req, res) => {
    if (req.headers.authorization !== 'Bearer ok') { res.status(401).json({ error: 'no' }); return null; }
    return { id: 'u1' };
  }),
}));
const addLog = vi.fn();
vi.mock('../lib/logBuffer.js', () => ({ addLog: (...a) => addLog(...a) }));

const {
  sanitizeMappings, pickVerifiedTicker, verifyMappings, tickerMappings, MAX_MAPPINGS_PER_REQUEST,
} = await import('./tickerMappings.js');

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

describe('sanitizeMappings', () => {
  it('normaliza y deja pasar ISIN + símbolo válidos', () => {
    expect(sanitizeMappings({ ie00b4l5y983: ' iwda.as ' })).toEqual([{ isin: 'IE00B4L5Y983', ticker: 'IWDA.AS' }]);
  });

  it('descarta ISIN inválido, símbolos raros, CASH_ y valores que no son texto', () => {
    expect(sanitizeMappings({
      NOTANISIN: 'AAPL',
      US0378331005: 'AAPL; drop',
      US5949181045: 'CASH_EUR',
      US0231351067: 42,
      US88160R1014: 'X'.repeat(21),
    })).toEqual([]);
    expect(sanitizeMappings(null)).toEqual([]);
    expect(sanitizeMappings(['US0378331005', 'AAPL'])).toEqual([]);
  });

  it('corta en MAX_MAPPINGS_PER_REQUEST', () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`US${String(i).padStart(9, '0')}0`, 'AAPL']));
    expect(sanitizeMappings(many)).toHaveLength(MAX_MAPPINGS_PER_REQUEST);
  });
});

describe('pickVerifiedTicker', () => {
  it('devuelve el pedido si Yahoo lo lista exacto', () => {
    expect(pickVerifiedTicker('IE00B4L5Y983', 'IWDA.AS', ['SWDA.L', 'IWDA.AS'])).toBe('IWDA.AS');
  });

  it('sin sufijo: elige la bolsa del país del ISIN, no el primero de Yahoo', () => {
    // Yahoo suele poner primero el LSE; para IE preferimos .AS
    expect(pickVerifiedTicker('IE00B4L5Y983', 'IWDA', ['SWDA.L', 'IWDA.AS', 'IWDA.L'])).toBe('IWDA.AS');
    expect(pickVerifiedTicker('GB00B16GWD56', 'HSBA', ['HSBA.L', 'HSBA.DE'])).toBe('HSBA.L');
  });

  it('con sufijo pedido: respeta SAN.MC / VOW3.DE antes que la preferencia del ISIN', () => {
    // ISIN irlandés preferiría .AS; el cliente pidió .MC → se respeta.
    expect(pickVerifiedTicker('IE00B4L5Y983', 'SAN.MC', ['SAN.AS', 'SAN.MC', 'SAN.L'])).toBe('SAN.MC');
    // ISIN alemán preferiría .DE; el cliente pidió .DE aunque Yahoo liste primero otra.
    expect(pickVerifiedTicker('DE0007664039', 'VOW3.DE', ['VOW3.F', 'VOW3.DE'])).toBe('VOW3.DE');
    // Sufijo pedido no está en Yahoo → cae a preferencia del país (IE → .AS).
    expect(pickVerifiedTicker('IE00B4L5Y983', 'SAN.MC', ['SAN.AS', 'SAN.L'])).toBe('SAN.AS');
  });

  it('sin casar base ni exacto: null (no publica el primero)', () => {
    expect(pickVerifiedTicker('IE00B4L5Y983', 'TSLA', ['IWDA.AS', 'SWDA.L'])).toBeNull();
    expect(pickVerifiedTicker('IE00B4L5Y983', 'IWDA', [])).toBeNull();
  });
});

describe('verifyMappings', () => {
  beforeEach(() => { addLog.mockClear(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });

  it('solo publica el par cuyo símbolo sale al buscar ESE ISIN; un fallo de búsqueda es unverified', async () => {
    const lookup = vi.fn(async (isin) => {
      if (isin === 'IE00B4L5Y983') return ['IWDA.AS', 'SWDA.L'];
      if (isin === 'US0378331005') return ['AAPL'];
      throw new Error('Yahoo search HTTP 500');
    });
    const out = await verifyMappings([
      { isin: 'IE00B4L5Y983', ticker: 'IWDA.AS' },
      { isin: 'US0378331005', ticker: 'TSLA' },     // asignación falsa → rejected
      { isin: 'US5949181045', ticker: 'MSFT' },     // Yahoo caído → unverified
    ], lookup);
    expect(out).toEqual({
      verified: [{ isin: 'IE00B4L5Y983', ticker: 'IWDA.AS' }],
      rejected: 1,
      unverified: 1,
    });
    expect(console.warn).toHaveBeenCalled();
    expect(addLog).toHaveBeenCalledWith('warn', 'import', expect.stringContaining('US5949181045'), expect.any(Object));
  });

  it('un 429 corta el bucle: el resto sin mirar cuenta como unverified, no rejected', async () => {
    const lookup = vi.fn(async (isin) => {
      if (isin === 'IE00B4L5Y983') return ['IWDA.AS'];
      throw new Error('Yahoo search HTTP 429');
    });
    const out = await verifyMappings([
      { isin: 'IE00B4L5Y983', ticker: 'IWDA.AS' },
      { isin: 'US0378331005', ticker: 'AAPL' },
      { isin: 'US5949181045', ticker: 'MSFT' },
    ], lookup);
    expect(out).toEqual({
      verified: [{ isin: 'IE00B4L5Y983', ticker: 'IWDA.AS' }],
      rejected: 0,
      unverified: 2,
    });
    expect(lookup).toHaveBeenCalledTimes(2); // no mira el tercero
  });

  it('prefers the exchange listing for the ISIN country when the client omits the suffix', async () => {
    const out = await verifyMappings(
      [{ isin: 'IE00B4L5Y983', ticker: 'IWDA' }],
      async () => ['SWDA.L', 'IWDA.L', 'IWDA.AS'],
    );
    expect(out.verified).toEqual([{ isin: 'IE00B4L5Y983', ticker: 'IWDA.AS' }]);
  });
});

describe('POST /api/ticker-mappings', () => {
  beforeEach(() => { upsert.mockClear(); upsert.mockResolvedValue({ error: null }); });

  it('sin sesión: 401 y no escribe', async () => {
    const res = fakeRes();
    await tickerMappings({ headers: {}, body: { mappings: { IE00B4L5Y983: 'IWDA.AS' } } }, res, { lookup: async () => ['IWDA.AS'] });
    expect(res.statusCode).toBe(401);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('inserta solo lo verificado, como auto y sin sobrescribir lo que ya existe', async () => {
    const res = fakeRes();
    await tickerMappings(
      { headers: { authorization: 'Bearer ok' }, body: { mappings: { IE00B4L5Y983: 'IWDA.AS', US0378331005: 'TSLA' } } },
      res,
      { lookup: async (isin) => (isin === 'IE00B4L5Y983' ? ['IWDA.AS'] : ['AAPL']) },
    );
    expect(res.body).toEqual({ saved: 1, rejected: 1, unverified: 0 });
    expect(upsert).toHaveBeenCalledWith(
      [{ isin: 'IE00B4L5Y983', ticker: 'IWDA.AS', source: 'auto' }],
      { onConflict: 'isin', ignoreDuplicates: true },
    );
  });

  it('nada verificable: no toca la tabla', async () => {
    const res = fakeRes();
    await tickerMappings({ headers: { authorization: 'Bearer ok' }, body: { mappings: { US0378331005: 'TSLA' } } }, res, { lookup: async () => ['AAPL'] });
    expect(res.body).toEqual({ saved: 0, rejected: 1, unverified: 0 });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('si el upsert falla: 500 y no miente con saved', async () => {
    upsert.mockResolvedValueOnce({ error: { message: 'permission denied' } });
    const res = fakeRes();
    await tickerMappings(
      { headers: { authorization: 'Bearer ok' }, body: { mappings: { IE00B4L5Y983: 'IWDA.AS' } } },
      res,
      { lookup: async () => ['IWDA.AS'] },
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Could not save mappings' });
  });
});

describe('migración 20261026000200_ticker_mappings_server_only', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const ROOT = path.resolve(import.meta.dirname, '../..');
  const sql = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20261026000200_ticker_mappings_server_only.sql'), 'utf8')
    .split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

  it('quita las políticas de escritura y los privilegios del cliente', () => {
    expect(sql).toMatch(/DROP POLICY IF EXISTS ticker_mappings_insert ON public\.ticker_mappings;/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS ticker_mappings_update ON public\.ticker_mappings;/);
    expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public\.ticker_mappings FROM PUBLIC, anon, authenticated;/);
    expect(sql).toMatch(/REVOKE SELECT ON public\.ticker_mappings FROM anon;/);
    expect(sql).not.toMatch(/CREATE POLICY/i);
    expect(sql).not.toMatch(/GRANT[^;]*(authenticated|anon)/i);
  });

  it('ningún fichero de src/ escribe la tabla directamente', () => {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      return /\.(jsx?|mjs)$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : [];
    });
    const offenders = walk(path.join(ROOT, 'src')).filter((f) =>
      /from\(\s*['"]ticker_mappings['"]\s*\)[\s\S]{0,80}?\.(insert|upsert|update|delete)\(/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
