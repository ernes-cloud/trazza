/**
 * Seguridad N1 — async / unhandledRejection / error handler global.
 *
 * Contrato (comportamiento HTTP, no implementación):
 *   - `createApp` desde `server/app.js` sin listen.
 *   - Rutas async + withRateLimit real: rechazo → 5xx controlado, sin hang.
 *   - Error handler central: 500/4xx sin filtrar message/stack.
 *   - Repros fallan por ASERCIÓN (race helper), no por timeout de Vitest.
 */

import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const {
  requireUserMock,
  getGroqMock,
  sendEmailMock,
  isEmailConfiguredMock,
  chatCompletionsCreate,
  getUserMock,
  createClientMock,
  originalAdminEmails,
} = vi.hoisted(() => {
  // rateLimiter/adminSupabase crean el cliente al cargar el módulo
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
    || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test-service-role';

  // Fuente de admin OSS (decisión T8/adminBasic): ADMIN_EMAILS (env, coma-
  // separado) o, si falta, el primer usuario registrado. Se fija ANTES del
  // import de server/app.js (vi.hoisted corre antes que los imports de este
  // fichero) por si algún día se lee al cargar un módulo, no solo por
  // request. Se guarda el valor original para restaurarlo en un afterAll
  // de módulo (fuera de cualquier describe) y no filtrar a otros ficheros.
  const originalAdminEmails = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = 'admin@example.com';

  const chatCompletionsCreate = vi.fn(async () => ({
    choices: [{ message: { content: 'respuesta mock' } }],
  }));
  const getUserMock = vi.fn(async () => ({
    data: { user: { id: 'user-test-1', email: 'admin@example.com', email_confirmed_at: '2020-01-01T00:00:00Z' } },
    error: null,
  }));

  function chainable(terminal) {
    const api = {};
    const self = () => api;
    api.select = vi.fn(self);
    api.eq = vi.fn(self);
    api.in = vi.fn(self);
    api.gte = vi.fn(self);
    api.ilike = vi.fn(self);
    api.order = vi.fn(self);
    api.limit = vi.fn(self);
    api.update = vi.fn(self);
    api.upsert = vi.fn(self);
    api.delete = vi.fn(self);
    api.maybeSingle = vi.fn(async () => terminal);
    api.single = vi.fn(async () => terminal);
    // thenable: await sel
    api.then = (resolve, reject) => Promise.resolve(terminal).then(resolve, reject);
    return api;
  }

  const fromMock = vi.fn((table) => {
    if (table === 'user_preferences') {
      return chainable({ data: {}, error: null });
    }
    if (table === 'ai_usage') {
      return chainable({ data: [], error: null, count: 0 });
    }
    if (table === 'beta_access' || table === 'beta_allowlist') {
      return chainable({ data: [], error: null, count: 0 });
    }
    return chainable({ data: null, error: null });
  });

  const createClientMock = vi.fn(() => ({
    auth: {
      getUser: getUserMock,
      admin: {
        listUsers: vi.fn(async () => ({ data: { users: [], total: 0 }, error: null })),
        getUserById: vi.fn(async () => ({ data: { user: null }, error: null })),
      },
    },
    from: fromMock,
    rpc: vi.fn(async () => ({ data: null, error: null })),
  }));

  return {
    requireUserMock: vi.fn(async () => ({ id: 'user-test-1' })),
    getGroqMock: vi.fn(() => ({
      chat: { completions: { create: chatCompletionsCreate } },
    })),
    sendEmailMock: vi.fn(async () => ({ ok: true, attempts: 1 })),
    isEmailConfiguredMock: vi.fn(() => true),
    chatCompletionsCreate,
    getUserMock,
    createClientMock,
    originalAdminEmails,
  };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args) => createClientMock(...args),
}));

vi.mock('./lib/requireUser.js', () => ({ requireUser: requireUserMock }));
vi.mock('./lib/groqClient.js', () => ({ getGroq: getGroqMock }));
vi.mock('./lib/emailTransport.js', () => ({ sendEmail: sendEmailMock }));
vi.mock('./lib/emailConfig.js', () => ({
  isEmailConfigured: (...args) => isEmailConfiguredMock(...args),
  applyDevEmailEnvDefault: () => {},
}));
vi.mock('./lib/logBuffer.js', () => ({ addLog: vi.fn() }));
vi.mock('./jobs/notificationCron.js', () => ({ startNotificationCron: vi.fn() }));
vi.mock('./jobs/portfolioSnapshots.js', () => ({ startPortfolioSnapshotsCron: vi.fn() }));
vi.mock('./jobs/weeklyReport.js', () => ({ startWeeklyReportCron: vi.fn() }));
vi.mock('./jobs/siteVisits.js', () => ({ startSiteVisitsCron: vi.fn() }));
vi.mock('./jobs/activationEmail.js', () => ({ startActivationEmailCron: vi.fn() }));

const RACE_DEADLINE_MS = 1500;
const AUTH = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };

// Restaura ADMIN_EMAILS (fijado en vi.hoisted de arriba) al terminar TODO
// este fichero, para no filtrar el valor de prueba a otros ficheros de test
// que compartan proceso.
afterAll(() => {
  if (originalAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = originalAdminEmails;
});

/**
 * Race: respuesta fetch | primer unhandledRejection/uncaughtException | deadline.
 * @param {(signal: AbortSignal) => Promise<Response>} runFetch
 * @returns {Promise<{ response?: Response, rejection?: unknown, timedOut: boolean }>}
 */
export async function raceRequest(runFetch, deadlineMs = RACE_DEADLINE_MS) {
  let rejection;
  let settled = false;
  const ac = new AbortController();

  const onRejection = (reason) => {
    if (settled) return;
    rejection = reason;
  };
  const onException = (err) => {
    if (settled) return;
    rejection = rejection ?? err;
  };
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);

  try {
    const outcome = await new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        settled = true;
        resolve(value);
      };

      Promise.resolve()
        .then(() => runFetch(ac.signal))
        .then((response) => finish({ response, timedOut: false }))
        .catch((err) => {
          if (err?.name === 'AbortError' || ac.signal.aborted) finish({ timedOut: true, rejection });
          else finish({ rejection: rejection ?? err, timedOut: false });
        });

      const poll = setInterval(() => {
        if (rejection !== undefined) {
          clearInterval(poll);
          ac.abort();
          finish({ rejection, timedOut: false });
        }
      }, 15);

      setTimeout(() => {
        clearInterval(poll);
        ac.abort();
        finish({ timedOut: true, rejection });
      }, deadlineMs);
    });

    await new Promise((r) => setImmediate(r));
    if (outcome.rejection === undefined && rejection !== undefined) {
      return { response: outcome.response, rejection, timedOut: Boolean(outcome.timedOut) };
    }
    return {
      response: outcome.response,
      rejection: outcome.rejection,
      timedOut: Boolean(outcome.timedOut),
    };
  } finally {
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onException);
  }
}

async function loadCreateApp() {
  try {
    const mod = await import('./app.js');
    return { createApp: mod.createApp, err: null, mod };
  } catch (appErr) {
    const indexPath = fileURLToPath(new URL('./index.js', import.meta.url));
    const src = fs.readFileSync(indexPath, 'utf8');
    const exportsCreateApp = /export\s+(async\s+)?function\s+createApp\b/.test(src)
      || /export\s+const\s+createApp\b/.test(src)
      || /export\s*\{[^}]*\bcreateApp\b/.test(src);
    if (!exportsCreateApp) {
      return {
        createApp: undefined,
        err: new Error(
          `Falta server/app.js (o export createApp en index.js sin listen al importar). Detalle: ${appErr.message}`,
        ),
        mod: null,
      };
    }
    try {
      const mod = await import('./index.js');
      return { createApp: mod.createApp, err: null, mod };
    } catch (e) {
      return { createApp: undefined, err: e, mod: null };
    }
  }
}

function listenEphemeral(app) {
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res, rej) => server.close((e) => (e ? rej(e) : res()))),
      });
    });
    server.on('error', reject);
  });
}

/** Carga perezosa por test: fallo = aserción clara, nunca skip / beforeAll. */
async function ensureHarness(state) {
  if (state.harness) return state.harness;
  const loaded = await loadCreateApp();
  expect(
    typeof loaded.createApp,
    loaded.err
      ? `createApp ausente: ${loaded.err.message}`
      : 'createApp ausente: exportar createApp desde server/app.js (sin listen)',
  ).toBe('function');
  state.createApp = loaded.createApp;
  const app = loaded.createApp({ disableCrons: true });
  state.harness = await listenEphemeral(app);
  return state.harness;
}

describe('asyncSafety — createApp + rutas AI', () => {
  const state = { createApp: null, harness: null };

  afterAll(async () => {
    if (state.harness) await state.harness.close();
  });

  beforeEach(() => {
    requireUserMock.mockClear();
    getGroqMock.mockClear();
    chatCompletionsCreate.mockClear();
    sendEmailMock.mockClear();
    getUserMock.mockReset();
    getUserMock.mockResolvedValue({
      data: { user: { id: 'user-test-1', email: 'admin@example.com', email_confirmed_at: '2020-01-01T00:00:00Z' } },
      error: null,
    });
    chatCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: 'respuesta mock' } }],
    });
  });

  // ── (a) Repros Reviewer — race helper ─────────────────────────────────────

  it('POST /api/portfolio-chat con messages:[null] → 400 (no hang) y GET /health 200', async () => {
    const { baseUrl } = await ensureHarness(state);
    const outcome = await raceRequest((signal) => fetch(`${baseUrl}/api/portfolio-chat`, { signal, 
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ context: {}, messages: [null] }),
    }));
    expect(
      outcome.rejection,
      `unhandledRejection/uncaughtException: ${outcome.rejection && (outcome.rejection.stack || String(outcome.rejection))}`,
    ).toBeUndefined();
    expect(outcome.timedOut, 'timeout: la ruta se colgó (rechazo no capturado)').toBe(false);
    expect(outcome.response?.status, 'messages:[null] debe ser 400').toBe(400);

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
  });

  it('POST /api/score-portfolio con score/breakdown no-objeto → 400 (no hang) y GET /health 200', async () => {
    const { baseUrl } = await ensureHarness(state);
    const outcome = await raceRequest((signal) => fetch(`${baseUrl}/api/score-portfolio`, { signal, 
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ score: 1, breakdown: 1 }),
    }));
    expect(
      outcome.rejection,
      `unhandledRejection/uncaughtException: ${outcome.rejection && (outcome.rejection.stack || String(outcome.rejection))}`,
    ).toBeUndefined();
    expect(outcome.timedOut, 'timeout: la ruta se colgó (rechazo no capturado)').toBe(false);
    expect(outcome.response?.status, 'breakdown:1 debe ser 400').toBe(400);

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
  });

  it('withRateLimit: getUser que rechaza → 5xx controlado (no hang); /health 200', async () => {
    const { baseUrl } = await ensureHarness(state);
    getUserMock.mockRejectedValueOnce(new Error('supabase-auth-down'));

    const outcome = await raceRequest((signal) => fetch(`${baseUrl}/api/portfolio-chat`, { signal, 
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ context: {}, messages: [{ role: 'user', content: 'hola' }] }),
    }));

    expect(
      outcome.rejection,
      `unhandledRejection: ${outcome.rejection && (outcome.rejection.stack || String(outcome.rejection))}`,
    ).toBeUndefined();
    expect(outcome.timedOut, 'timeout: withRateLimit se colgó al rechazar getUser (fuera de try)').toBe(false);
    expect(outcome.response, 'debe haber Response HTTP').toBeTruthy();
    expect(outcome.response.status).toBeGreaterThanOrEqual(500);
    expect(outcome.response.status).toBeLessThan(600);

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
  });

  // ── (b) Validación + error seguro ─────────────────────────────────────────

  describe.each([
    ['/api/portfolio-chat', { context: {}, messages: [{ role: 'user', content: 'hola' }] }],
    ['/api/score-portfolio', {
      score: 50,
      breakdown: {
        diversification: { score: 10, max: 30, hhi: 0.2 },
        performance: { score: 10, max: 30, gainPct: 5 },
        costs: { score: 5, max: 20, feeRatio: 0.1 },
        liquidity: { score: 5, max: 20, cashPct: 10 },
        income: { dividendYield: 0 },
      },
    }],
  ])('%s', (path, validBody) => {
    it('JSON mal formado → 4xx', async () => {
      const { baseUrl } = await ensureHarness(state);
      const outcome = await raceRequest((signal) => fetch(`${baseUrl}${path}`, { signal, 
        method: 'POST',
        headers: AUTH,
        body: '{"context":',
      }));
      expect(outcome.rejection).toBeUndefined();
      expect(outcome.timedOut).toBe(false);
      expect(outcome.response.status).toBeGreaterThanOrEqual(400);
      expect(outcome.response.status).toBeLessThan(500);
    });

    it('body invalido (tipos / campos ausentes) → 4xx', async () => {
      const { baseUrl } = await ensureHarness(state);
      const cases = path.includes('portfolio-chat')
        ? [
            {},
            { context: 'no-obj', messages: [] },
            { context: {}, messages: 'no-array' },
            { context: {}, messages: [{ role: 'assistant', content: 'solo assistant' }] },
          ]
        : [
            {},
            { score: 'x', breakdown: {} },
            { score: 1 },
            { score: 1, breakdown: null },
            { score: 1, breakdown: 'x' },
          ];
      for (const body of cases) {
        const outcome = await raceRequest((signal) => fetch(`${baseUrl}${path}`, { signal, 
          method: 'POST',
          headers: AUTH,
          body: JSON.stringify(body),
        }));
        expect(outcome.timedOut, `body=${JSON.stringify(body)}`).toBe(false);
        expect(outcome.response.status, `body=${JSON.stringify(body)}`).toBeGreaterThanOrEqual(400);
        expect(outcome.response.status, `body=${JSON.stringify(body)}`).toBeLessThan(500);
      }
    });

    it('handler que rechaza → 500 JSON sin err.message ni stack; health sigue', async () => {
      await ensureHarness(state);
      let asyncHandler;
      let asyncHandlerErr = null;
      try {
        ({ asyncHandler } = await import('./lib/asyncHandler.js'));
      } catch (e) {
        asyncHandler = null;
        asyncHandlerErr = e;
      }
      expect(
        typeof asyncHandler,
        asyncHandlerErr
          ? `asyncHandler ausente: ${asyncHandlerErr.message}. Develop debe exportar asyncHandler desde server/lib/asyncHandler.js`
          : 'Develop debe exportar asyncHandler desde server/lib/asyncHandler.js',
      ).toBe('function');

      const secret = 'SECRET_LEAK_DO_NOT_EXPOSE';
      const app = state.createApp({ disableCrons: true });
      app.post('/__test/async-reject', asyncHandler(async () => {
        throw new Error(secret);
      }));
      const local = await listenEphemeral(app);
      try {
        const outcome = await raceRequest((signal) => fetch(`${local.baseUrl}/__test/async-reject`, { signal, 
          method: 'POST',
          headers: AUTH,
          body: JSON.stringify(validBody),
        }));
        expect(outcome.rejection).toBeUndefined();
        expect(outcome.timedOut).toBe(false);
        expect(outcome.response.status).toBe(500);
        const text = await outcome.response.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        expect(json, '500 debe ser JSON').toBeTruthy();
        expect(JSON.stringify(json)).not.toContain(secret);
        expect(JSON.stringify(json)).not.toMatch(/at\s+\w+/);
        expect(json.stack).toBeUndefined();

        const health = await fetch(`${local.baseUrl}/health`);
        expect(health.status).toBe(200);
      } finally {
        await local.close();
      }
    });
  });

  // ── (c) process listeners + petición posterior ────────────────────────────

  it('repro TypeError no dispara unhandledRejection; server responde después', async () => {
    const { baseUrl } = await ensureHarness(state);
    const a = await raceRequest((signal) => fetch(`${baseUrl}/api/portfolio-chat`, { signal, 
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ context: {}, messages: [null] }),
    }));
    const b = await raceRequest((signal) => fetch(`${baseUrl}/api/score-portfolio`, { signal, 
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ score: 1, breakdown: 1 }),
    }));
    expect(a.rejection, String(a.rejection || '')).toBeUndefined();
    expect(b.rejection, String(b.rejection || '')).toBeUndefined();
    expect(a.timedOut || b.timedOut).toBe(false);

    const later = await fetch(`${baseUrl}/health`);
    expect(later.status).toBe(200);
  });

  // ── (e) process.on('unhandledRejection') ──────────────────────────────────

  it('createApp/app.js registra process.on("unhandledRejection")', async () => {
    await ensureHarness(state);
    const before = process.listenerCount('unhandledRejection');
    state.createApp({ disableCrons: true });
    const after = process.listenerCount('unhandledRejection');
    let src = '';
    try {
      src = fs.readFileSync(fileURLToPath(new URL('./app.js', import.meta.url)), 'utf8');
    } catch {
      src = fs.readFileSync(fileURLToPath(new URL('./index.js', import.meta.url)), 'utf8');
    }
    const staticallyRegisters = /process\.on\(\s*['"]unhandledRejection['"]/.test(src);
    expect(
      after > before || staticallyRegisters,
      'createApp/app.js debe registrar process.on("unhandledRejection")',
    ).toBe(true);
  });

  // ── (f) Regresión /api/contact ────────────────────────────────────────────

  it('POST /api/contact con body valido → 200 (email mockeado vía isEmailConfigured)', async () => {
    // Planner: mockear isEmailConfigured=true; NO fijar EMAIL_HOST (applyDevEmailEnvDefault es no-op en OSS).
    isEmailConfiguredMock.mockReturnValue(true);
    const { baseUrl } = await ensureHarness(state);
    const outcome = await raceRequest((signal) => fetch(`${baseUrl}/api/contact`, { signal, 
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Ana',
        email: 'ana@example.com',
        message: 'hola desde asyncSafety',
      }),
    }));
    expect(outcome.timedOut).toBe(false);
    expect(outcome.response.status).toBe(200);
    expect(sendEmailMock).toHaveBeenCalled();
    expect(isEmailConfiguredMock).toHaveBeenCalled();
  });

  it('POST /api/contact campos ausentes → 400', async () => {
    const { baseUrl } = await ensureHarness(state);
    const outcome = await raceRequest((signal) => fetch(`${baseUrl}/api/contact`, { signal, 
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', email: 'x', message: '' }),
    }));
    expect(outcome.timedOut).toBe(false);
    expect(outcome.response.status).toBe(400);
  });
});

// ── I4 T1/T2 — error handler global (body sin leaks) ────────────────────────

describe('asyncSafety — error handler global (T1/T2)', () => {
  const state = { createApp: null, harness: null };

  afterAll(async () => {
    if (state.harness) await state.harness.close();
  });

  it('T1: Origin no permitido → 403 y body sin message/stack ni evil.example', async () => {
    const { baseUrl } = await ensureHarness(state);
    const outcome = await raceRequest((signal) => fetch(`${baseUrl}/health`, { signal, 
      headers: { Origin: 'https://evil.example' },
    }));
    expect(outcome.rejection).toBeUndefined();
    expect(outcome.timedOut).toBe(false);
    expect(outcome.response.status).toBe(403);
    const text = await outcome.response.text();
    expect(text).not.toContain('evil.example');
    expect(text).not.toContain('not allowed');
    expect(text).not.toMatch(/\bat\s+/);
  });

  it('T1b: ruta que lanza Error(secret-xyz) → 500 sin secret ni stack en body', async () => {
    await ensureHarness(state);
    let asyncHandler;
    try {
      ({ asyncHandler } = await import('./lib/asyncHandler.js'));
    } catch {
      asyncHandler = null;
    }
    expect(typeof asyncHandler, 'asyncHandler ausente').toBe('function');

    const app = state.createApp({ disableCrons: true });
    // Montar SIN asyncHandler para ejercitar el errorHandler vía next(err) si
    // Develop unifica a .catch(next); con wrapper actual también debe sanitizar.
    app.get('/__test/secret-leak', asyncHandler(async () => {
      throw new Error('secret-xyz');
    }));
    const local = await listenEphemeral(app);
    try {
      const outcome = await raceRequest((signal) => fetch(`${local.baseUrl}/__test/secret-leak`, { signal }));
      expect(outcome.rejection).toBeUndefined();
      expect(outcome.timedOut).toBe(false);
      expect(outcome.response.status).toBe(500);
      const text = await outcome.response.text();
      expect(text).not.toContain('secret-xyz');
      expect(text).not.toMatch(/\bat\s+/);
    } finally {
      await local.close();
    }
  });

  it('T2: JSON roto → 400 {"error":"Invalid JSON"} sin texto del parser, body crudo ni stack', async () => {
    const { baseUrl } = await ensureHarness(state);
    const raw = '{"messages":zzq-raw-777';
    const outcome = await raceRequest((signal) => fetch(`${baseUrl}/api/portfolio-chat`, { signal,
      method: 'POST',
      headers: AUTH,
      body: raw,
    }));
    expect(outcome.rejection).toBeUndefined();
    expect(outcome.timedOut).toBe(false);
    expect(outcome.response.status).toBe(400);
    const text = await outcome.response.text();
    expect(JSON.parse(text)).toEqual({ error: 'Invalid JSON' });
    expect(text).not.toMatch(/Unexpected token/i);
    expect(text).not.toMatch(/position\s*\d+|line\s*\d+|column\s*\d+/i);
    expect(text).not.toContain('zzq-raw-777');
    expect(text).not.toMatch(/\bat\s+/);
  });
});

// ── m2 / T3 — decodeURIComponent / query array / body type ──────────────────

describe('asyncSafety — m2/T3 inputs maliciosos o mal tipados', () => {
  const state = { createApp: null, harness: null };

  afterAll(async () => {
    if (state.harness) await state.harness.close();
  });

  it('GET /api/yahoo-profile/%25zz → 4xx; proceso vivo; sin unhandledRejection', async () => {
    const { baseUrl } = await ensureHarness(state);
    const outcome = await raceRequest((signal) => fetch(`${baseUrl}/api/yahoo-profile/%25zz`, { signal }));
    expect(
      outcome.rejection,
      `unhandledRejection: ${outcome.rejection && (outcome.rejection.stack || String(outcome.rejection))}`,
    ).toBeUndefined();
    expect(outcome.timedOut).toBe(false);
    expect(outcome.response.status).toBeGreaterThanOrEqual(400);
    expect(outcome.response.status).toBeLessThan(500);

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
  });

  it('GET /api/admin/users?q[]=a → 400 (no 500)', async () => {
    const { baseUrl } = await ensureHarness(state);
    const outcome = await raceRequest((signal) => fetch(`${baseUrl}/api/admin/users?q[]=a`, { signal, 
      headers: { Authorization: 'Bearer test-token' },
    }));
    expect(outcome.rejection).toBeUndefined();
    expect(outcome.timedOut).toBe(false);
    expect(outcome.response.status, `got ${outcome.response?.status}`).toBe(400);
  });

  it('GET /api/admin/beta?q[]=a → 404 (beta fuera de OSS)', async () => {
    const { baseUrl } = await ensureHarness(state);
    const outcome = await raceRequest((signal) => fetch(`${baseUrl}/api/admin/beta?q[]=a`, { signal, 
      headers: { Authorization: 'Bearer test-token' },
    }));
    expect(outcome.rejection).toBeUndefined();
    expect(outcome.timedOut).toBe(false);
    expect(outcome.response.status, `got ${outcome.response?.status}`).toBe(404);
  });

  it('POST /api/admin/beta-allowlist → 404 (beta fuera de OSS)', async () => {
    const { baseUrl } = await ensureHarness(state);
    const outcome = await raceRequest((signal) => fetch(`${baseUrl}/api/admin/beta-allowlist`, { signal, 
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ type: 5, value: 'example.com' }),
    }));
    expect(outcome.rejection).toBeUndefined();
    expect(outcome.timedOut).toBe(false);
    expect(outcome.response.status, `got ${outcome.response?.status}`).toBe(404);
  });
});

// ── m1 — unhandledRejection handler: loguea, no process.exit ────────────────

describe('asyncSafety — m1 unhandledRejection handler', () => {
  it('handler registrado al importar app.js loguea y NO llama process.exit', async () => {
    const loaded = await loadCreateApp();
    expect(
      typeof loaded.createApp,
      loaded.err
        ? `createApp ausente: ${loaded.err.message}`
        : 'createApp ausente: server/app.js',
    ).toBe('function');

    // Asegura que el listener de app.js está registrado
    loaded.createApp({ disableCrons: true });

    const listeners = process.listeners('unhandledRejection');
    expect(
      listeners.length,
      'debe haber al menos un listener unhandledRejection tras importar app.js',
    ).toBeGreaterThan(0);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let addLog;
    try {
      ({ addLog } = await import('./lib/logBuffer.js'));
    } catch {
      addLog = null;
    }
    const addLogSpy = addLog && typeof addLog === 'function' ? addLog : null;

    const beforeExitCalls = exitSpy.mock.calls.length;
    const beforeErrCalls = errorSpy.mock.calls.length;
    const beforeLogCalls = addLogSpy?.mock?.calls?.length ?? 0;

    const boom = new Error('m1-synthetic-rejection');
    for (const listener of listeners) {
      try {
        listener(boom);
      } catch {
        // el handler no debe lanzar
      }
    }

    const logged = (errorSpy.mock.calls.length > beforeErrCalls)
      || (addLogSpy && addLogSpy.mock.calls.length > beforeLogCalls);
    expect(logged, 'el handler debe loguear (console.error o addLog)').toBe(true);
    expect(exitSpy.mock.calls.length, 'NO debe llamar process.exit').toBe(beforeExitCalls);

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
