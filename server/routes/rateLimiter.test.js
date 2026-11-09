import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * M-D: en producción, sin supabaseAdmin o con fallo de ai_usage → 503
 * (cerrar, no abrir). En desarrollo se mantiene el paso libre.
 */

const { createClient, adminApi, isUserAdminMock } = vi.hoisted(() => {
  const adminApi = {
    auth: { getUser: vi.fn(), admin: { listUsers: vi.fn() } },
    from: vi.fn(),
    rpc: vi.fn(),
  };
  return {
    adminApi,
    createClient: vi.fn(() => adminApi),
    isUserAdminMock: vi.fn(),
  };
});

vi.mock('@supabase/supabase-js', () => ({ createClient }));
vi.mock('ws', () => ({ default: class WebSocket {} }));
vi.mock('../lib/adminResolver.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    isUserAdmin: (...args) => isUserAdminMock(...args),
  };
});

function fakeRes() {
  const res = { statusCode: 200, body: null, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; res.headersSent = true; return res; };
  return res;
}

function fakeReq(headers = {}) {
  return { headers, userId: undefined, incrementUsage: undefined };
}

const ENV_KEYS = [
  'NODE_ENV',
  'SUPABASE_URL',
  'VITE_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ADMIN_EMAILS',
  'GROQ_API_KEY',
];

const QUOTA_TEST_USER = {
  id: 'user-1',
  email: 'quota-user@example.com',
  email_confirmed_at: '2024-01-01T00:00:00.000Z',
};

let savedEnv;

function snapshotEnv() {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
}

function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

async function loadLimiter({ production, withAdmin }) {
  vi.resetModules();
  createClient.mockClear();
  createClient.mockImplementation(() => adminApi);
  adminApi.auth.getUser.mockReset();
  adminApi.auth.admin.listUsers.mockReset();
  adminApi.auth.admin.listUsers.mockResolvedValue({ data: { users: [QUOTA_TEST_USER] }, error: null });
  adminApi.from.mockReset();
  adminApi.rpc.mockReset();
  isUserAdminMock.mockReset();
  isUserAdminMock.mockResolvedValue(false);

  process.env.NODE_ENV = production ? 'production' : 'development';
  if (withAdmin) {
    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJservice-role-test';
    // Admin explícito distinto: el usuario de cuotas no debe saltarse ai_usage.
    process.env.ADMIN_EMAILS = 'ops-owner@example.com';
  } else {
    delete process.env.SUPABASE_URL;
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.ADMIN_EMAILS;
  }

  return import('./rateLimiter.js');
}

describe('withRateLimit (fail-closed en producción)', () => {
  beforeEach(() => {
    snapshotEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  it('producción sin supabaseAdmin responde 503 y no llama next()', async () => {
    const { withRateLimit } = await loadLimiter({ production: true, withAdmin: false });
    const req = fakeReq();
    const res = fakeRes();
    const next = vi.fn();

    await withRateLimit('chat')(req, res, next);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'service_unavailable' });
    expect(next).not.toHaveBeenCalled();
  });

  it('producción con error en ai_usage responde 503', async () => {
    const { withRateLimit } = await loadLimiter({ production: true, withAdmin: true });

    adminApi.auth.getUser.mockResolvedValue({
      data: { user: QUOTA_TEST_USER },
      error: null,
    });
    adminApi.from.mockImplementation((table) => {
      if (table === 'user_preferences') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { plan: 'free' }, error: null }),
            }),
          }),
        };
      }
      if (table === 'ai_usage') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                in: async () => ({ data: null, error: { message: 'relation "ai_usage" does not exist' } }),
              }),
            }),
          }),
        };
      }
      throw new Error(`tabla inesperada: ${table}`);
    });

    const req = fakeReq({ authorization: 'Bearer tok' });
    const res = fakeRes();
    const next = vi.fn();

    await withRateLimit('chat')(req, res, next);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'service_unavailable' });
    expect(next).not.toHaveBeenCalled();
    expect(adminApi.auth.admin.listUsers).not.toHaveBeenCalled();
  });

  it('desarrollo sin supabaseAdmin mantiene el paso', async () => {
    const { withRateLimit } = await loadLimiter({ production: false, withAdmin: false });
    const req = fakeReq();
    const res = fakeRes();
    const next = vi.fn();

    await withRateLimit('chat')(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.headersSent).toBe(false);
    expect(typeof req.incrementUsage).toBe('function');
  });

  it('app.js error handler no filtra err.message', async () => {
    const indexPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app.js');
    const src = fs.readFileSync(indexPath, 'utf8');

    const noComments = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(noComments).toMatch(/app\.use\(\s*errorHandler\s*\)/);
    expect(noComments).toMatch(/export\s+(async\s+)?function\s+errorHandler\b|export\s+(const|let)\s+errorHandler\b|export\s*\{[^}]*\berrorHandler\b/);

    // Comportamiento: el body genérico del 500 sale del propio errorHandler y no filtra err.message.
    const { errorHandler } = await import('../app.js');
    expect(typeof errorHandler).toBe('function');
    const res = { statusCode: 200, body: undefined };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    const err = new Error('SECRETO-cors-interno-xyz');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { errorHandler(err, {}, res, () => {}); } finally { spy.mockRestore(); }
    expect(res.statusCode).toBe(500);
    expect(typeof res.body?.error).toBe('string');
    expect(JSON.stringify(res.body)).not.toMatch(/SECRETO-cors-interno-xyz|\.js:\d+|\bat\s/);

    // Rechazo CORS → 403 (cb(null, false) o status 403), no Error que acaba en 500.
    const corsStart = src.indexOf('app.use(cors(');
    expect(corsStart).toBeGreaterThan(-1);
    const corsSlice = src.slice(corsStart, corsStart + 800);
    expect(corsSlice).not.toMatch(/cb\(\s*new Error/);
    // El 403 lo pone originGate (cors con cb(null,false) no corta la ruta):
    // tiene que estar montado en createApp y responder 403 de verdad.
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).toMatch(/app\.use\(\s*originGate\(/);
    const gatePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lib/originGate.js');
    expect(fs.readFileSync(gatePath, 'utf8')).toMatch(/status\(403\)/);
  });
});


describe('withRateLimit — fallo de resolución admin → límite normal (nunca 500 ni bypass)', () => {
  beforeEach(() => {
    snapshotEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  function mockAiUsageOverDaily() {
    adminApi.auth.getUser.mockResolvedValue({
      data: { user: QUOTA_TEST_USER },
      error: null,
    });
    adminApi.from.mockImplementation((table) => {
      if (table === 'ai_usage') {
        const today = new Date().toISOString().split('T')[0];
        const month = today.slice(0, 7);
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                in: async () => ({
                  data: [
                    { period: today, count: 10_000 },
                    { period: month, count: 1 },
                  ],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      };
    });
  }

  async function loadProdWithGroq() {
    const mod = await loadLimiter({ production: true, withAdmin: true });
    process.env.GROQ_API_KEY = 'test-groq-key';
    return mod;
  }

  it('si isUserAdmin lanza, no responde 500: aplica límite normal y con cuota agotada → 429', async () => {
    const { withRateLimit } = await loadProdWithGroq();
    isUserAdminMock.mockRejectedValue(new Error('admin_resolve_boom'));
    mockAiUsageOverDaily();

    const req = fakeReq({ authorization: 'Bearer tok' });
    const res = fakeRes();
    const next = vi.fn();
    await withRateLimit('chat')(req, res, next);

    expect(res.statusCode, `body=${JSON.stringify(res.body)}`).toBe(429);
    expect(res.body?.reason === 'daily' || /limit/i.test(String(res.body?.error || ''))).toBe(true);
    expect(next).not.toHaveBeenCalled();
    expect(req.userPlan).not.toBe('admin');
  });

  it('si isUserAdmin hace timeout, no 500 ni bypass: cuota agotada → 429', async () => {
    const { withRateLimit } = await loadProdWithGroq();
    isUserAdminMock.mockRejectedValue(new Error('listUsers_timeout'));
    mockAiUsageOverDaily();

    const req = fakeReq({ authorization: 'Bearer tok' });
    const res = fakeRes();
    const next = vi.fn();
    await withRateLimit('chat')(req, res, next);

    expect(res.statusCode).toBe(429);
    expect(next).not.toHaveBeenCalled();
  });

  it('si la resolución admin falla pero hay cuota, next() como usuario normal (sin bypass admin)', async () => {
    const { withRateLimit } = await loadProdWithGroq();
    isUserAdminMock.mockRejectedValue(new Error('admin_unavailable'));
    adminApi.auth.getUser.mockResolvedValue({
      data: { user: QUOTA_TEST_USER },
      error: null,
    });
    const today = new Date().toISOString().split('T')[0];
    const month = today.slice(0, 7);
    adminApi.from.mockImplementation((table) => {
      if (table === 'ai_usage') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                in: async () => ({
                  data: [
                    { period: today, count: 0 },
                    { period: month, count: 0 },
                  ],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        }),
      };
    });

    const req = fakeReq({ authorization: 'Bearer tok' });
    const res = fakeRes();
    const next = vi.fn();
    await withRateLimit('chat')(req, res, next);

    expect(res.statusCode).not.toBe(500);
    expect(next).toHaveBeenCalledOnce();
    expect(req.userPlan).toBe('user');
    expect(req.userId).toBe(QUOTA_TEST_USER.id);
  });
});
