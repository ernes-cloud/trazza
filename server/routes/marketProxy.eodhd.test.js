import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Regresion de seguridad: /api/eodhd-secure/* inyecta una API key de PAGO en la
 * peticion saliente, asi que ninguna peticion sin sesion verificada puede
 * llegar a EODHD.
 *
 * El fallo original: `resolveEodhdKey` devolvia `EODHD_PLATFORM_KEY` en su
 * primera sentencia y el handler solo exigia cabecera Authorization "si no
 * habia platform key". Con la key configurada -- que es la configuracion de
 * produccion -- el endpoint era un proxy ABIERTO: cualquiera en internet
 * gastaba la cuota de pago sin autenticarse.
 */

const { httpsGet, requireUserMock } = vi.hoisted(() => ({
  httpsGet: vi.fn(),
  requireUserMock: vi.fn(),
}));

vi.mock('https', () => ({ default: { get: httpsGet } }));
vi.mock('../lib/requireUser.js', () => ({ requireUser: requireUserMock }));
vi.mock('../lib/adminSupabase.js', () => ({ supabaseAdmin: null }));

const { eodhdSecure } = await import('./marketProxy.js');

function mockRes() {
  return {
    headersSent: false,
    statusCode: 200,
    body: null,
    setHeader: vi.fn(),
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
    type() { return this; },
    send(b) { this.body = b; this.headersSent = true; return this; },
  };
}

const req = (headers = {}) => ({
  headers,
  originalUrl: '/api/eodhd-secure/calendar/earnings?fmt=json&from=2026-09-01',
});

// Respuesta upstream falsa para que proxyGet resuelva su promesa.
function fakeUpstream() {
  httpsGet.mockImplementation((_opts, cb) => {
    cb({
      headers: { 'content-type': 'application/json' },
      statusCode: 200,
      pipe: () => {},
      on: (ev, fn) => { if (ev === 'end') setImmediate(fn); },
    });
    return { setTimeout: () => {}, on: () => {} };
  });
}

describe('eodhdSecure: la autenticacion va antes que la key', () => {
  const PLATFORM_KEY = 'platform-key-de-pago';

  beforeEach(() => {
    httpsGet.mockReset();
    requireUserMock.mockReset();
    fakeUpstream();
    // La configuracion VULNERABLE: platform key presente.
    process.env.EODHD_PLATFORM_KEY = PLATFORM_KEY;
  });

  afterEach(() => { delete process.env.EODHD_PLATFORM_KEY; });

  it('no contacta con EODHD cuando el usuario no esta autenticado, aunque haya platform key', async () => {
    // requireUser responde 401 y devuelve null (contrato de lib/requireUser.js)
    const res = mockRes();
    requireUserMock.mockImplementation(async (_r, response) => {
      response.status(401).json({ error: 'Missing Authorization header' });
      return null;
    });

    await eodhdSecure(req(), res);

    expect(requireUserMock).toHaveBeenCalledOnce();
    // Lo que fija la regresion: la key de pago NUNCA sale del server.
    expect(httpsGet).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('exige la verificacion tambien cuando la platform key esta configurada', async () => {
    // Antes del arreglo, `EODHD_PLATFORM_KEY` cortocircuitaba la verificacion
    // entera: requireUser ni siquiera se invocaba.
    const res = mockRes();
    requireUserMock.mockImplementation(async (_r, response) => {
      response.status(401).json({ error: 'Invalid or expired session' });
      return null;
    });

    await eodhdSecure(req({ authorization: 'Bearer token-falsificado' }), res);

    expect(requireUserMock).toHaveBeenCalledOnce();
    expect(httpsGet).not.toHaveBeenCalled();
  });

  it('proxyea con la platform key una vez el usuario esta verificado', async () => {
    const res = mockRes();
    requireUserMock.mockResolvedValue({ id: 'user-1' });

    await eodhdSecure(req({ authorization: 'Bearer token-bueno' }), res);

    expect(httpsGet).toHaveBeenCalledOnce();
    const opts = httpsGet.mock.calls[0][0];
    expect(opts.hostname).toBe('eodhd.com');
    expect(opts.path).toContain('/api/calendar/earnings');
    expect(opts.path).toContain(`api_token=${PLATFORM_KEY}`);
  });

  it('falla cerrado con 503 eodhd_not_configured si el usuario esta verificado pero no hay ninguna key', async () => {
    delete process.env.EODHD_PLATFORM_KEY;   // y supabaseAdmin esta mockeado a null
    const res = mockRes();
    requireUserMock.mockResolvedValue({ id: 'user-1' });

    await eodhdSecure(req({ authorization: 'Bearer token-bueno' }), res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'eodhd_not_configured' });
    expect(httpsGet).not.toHaveBeenCalled();
  });
});
