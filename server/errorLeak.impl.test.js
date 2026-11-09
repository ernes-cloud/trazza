/**
 * N1v2 paso6 — T1/T2/T3 del informe Reviewer:
 * T1: 500 no contiene err.message ni stack
 * T2: 4xx no contiene err.message; Origin malo no filtra texto CORS
 * T3: GET /api/yahoo-profile/%25zz → 400
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';

vi.mock('./lib/requireUser.js', () => ({
  requireUser: vi.fn(async () => ({ id: 'u1' })),
}));
vi.mock('./lib/adminSupabase.js', () => ({
  supabaseAdmin: {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } }, error: null })) },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({ data: { plan: 'admin' }, error: null })),
          gte: vi.fn(async () => ({ count: 0, error: null })),
        })),
      })),
      upsert: vi.fn(async () => ({ error: null })),
    })),
  },
}));
vi.mock('./routes/rateLimiter.js', () => ({
  withRateLimit: () => (req, _res, next) => {
    req.userId = 'u1';
    req.incrementUsage = async () => {};
    next();
  },
  PLAN_LIMITS: {},
  AI_LIMITS: {},
}));
vi.mock('./lib/groqClient.js', () => ({
  getGroq: vi.fn(() => ({
    chat: { completions: { create: vi.fn(async () => ({ choices: [{ message: { content: 'x' } }] })) } },
  })),
}));
vi.mock('./lib/emailTransport.js', () => ({
  sendEmail: vi.fn(async () => ({ ok: true, attempts: 1 })),
}));
vi.mock('./lib/logBuffer.js', () => ({ addLog: vi.fn() }));
vi.mock('./jobs/notificationCron.js', () => ({ startNotificationCron: vi.fn() }));
vi.mock('./jobs/portfolioSnapshots.js', () => ({ startPortfolioSnapshotsCron: vi.fn() }));
vi.mock('./jobs/weeklyReport.js', () => ({ startWeeklyReportCron: vi.fn() }));
vi.mock('./jobs/siteVisits.js', () => ({ startSiteVisitsCron: vi.fn() }));
vi.mock('./jobs/activationEmail.js', () => ({ startActivationEmailCron: vi.fn() }));

import express from 'express';
import { createApp, errorHandler } from './app.js';
import { asyncHandler } from './lib/asyncHandler.js';

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
    server.on('error', reject);
  });
}

async function req(baseUrl, path, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 1500;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, { ...opts, signal: ac.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`request timeout after ${timeoutMs}ms: ${path}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, text, json };
}

describe('errorLeak.impl — T1/T2/T3', () => {
  let harness;

  beforeAll(async () => {
    const app = createApp();
    const SECRET = 'SECRET_LEAK_DO_NOT_EXPOSE_T1';
    app.get('/__test/throw-500', asyncHandler(async () => {
      throw new Error(SECRET);
    }));
    harness = await listen(app);
    harness.SECRET = SECRET;
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('T1: 500 JSON sin err.message ni stack', async () => {
    const { status, text, json } = await req(harness.baseUrl, '/__test/throw-500');
    expect(status).toBe(500);
    expect(json).toEqual({ error: 'Internal server error' });
    expect(text).not.toContain(harness.SECRET);
    expect(text).not.toMatch(/at\s+\w+/);
    expect(json.stack).toBeUndefined();
    expect(json.message).toBeUndefined();
  });

  it('T2: 4xx tipado sin err.message; Origin malo no filtra CORS', async () => {
    const badJson = await req(harness.baseUrl, '/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    expect(badJson.status).toBe(400);
    expect(badJson.json).toEqual({ error: 'Invalid JSON' });
    expect(badJson.text).not.toContain('SyntaxError');
    expect(badJson.text).not.toContain('Unexpected token');
    expect(badJson.text).not.toContain('Expected property name');

    const cors = await req(harness.baseUrl, '/health', {
      headers: { Origin: 'https://evil.example' },
    });
    expect(cors.status).toBe(403);
    expect(cors.json).toEqual({ error: 'Forbidden' });
    expect(cors.text).not.toMatch(/CORS/i);
    expect(cors.text).not.toContain('evil.example');
    expect(cors.text).not.toContain('not allowed');
  });

  it('T3: GET /api/yahoo-profile/%25zz → 400', async () => {
    const { status, json, text } = await req(harness.baseUrl, '/api/yahoo-profile/%25zz');
    expect(status).toBe(400);
    expect(json?.error).toBeTruthy();
    expect(text).not.toMatch(/URIError|URI malformed/i);
  });

  it('400 sin entity.parse.failed → Bad request; solo entity.parse.failed → Invalid JSON; nunca err.message', () => {
    // Rutas montadas tras createApp no alcanzan el errorHandler vía next(err);
    // invocamos el handler 4-arg exportado (mismo que body-parser usa).
    const mkRes = () => {
      const res = {
        statusCode: null,
        body: null,
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; },
      };
      return res;
    };

    const generic = new Error('LEAK_GENERIC_400_DETAIL');
    generic.status = 400;
    const resGeneric = mkRes();
    errorHandler(generic, {}, resGeneric, () => {});
    expect(resGeneric.statusCode).toBe(400);
    expect(resGeneric.body).toEqual({ error: 'Bad request' });
    expect(JSON.stringify(resGeneric.body)).not.toContain('LEAK_GENERIC_400_DETAIL');
    expect(JSON.stringify(resGeneric.body)).not.toContain('Invalid JSON');

    const parseFailed = new Error('Unexpected token X in JSON at position 0');
    parseFailed.status = 400;
    parseFailed.type = 'entity.parse.failed';
    const resParse = mkRes();
    errorHandler(parseFailed, {}, resParse, () => {});
    expect(resParse.statusCode).toBe(400);
    expect(resParse.body).toEqual({ error: 'Invalid JSON' });
    expect(JSON.stringify(resParse.body)).not.toContain('Unexpected token');
  });

  it('rama 500: Error(secreto-xyz) sin status → body exacto sin leak ni stack', () => {
    const mkRes = () => {
      const res = {
        statusCode: null,
        body: null,
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; },
      };
      return res;
    };
    const err = new Error('secreto-xyz');
    const res = mkRes();
    errorHandler(err, {}, res, () => {});
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toContain('secreto-xyz');
    expect(res.body.stack).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/\bat\s/);
  });

  it('rama 500 vía middleware síncrono next(err) con status 503', async () => {
    const app = express();
    app.get('/__test/sync-503', (_req, _res, next) => {
      const err = new Error('secreto-xyz');
      err.status = 503;
      next(err);
    });
    app.use(errorHandler);
    const { baseUrl, close } = await listen(app);
    try {
      const { status, text, json } = await req(baseUrl, '/__test/sync-503');
      expect(status).toBe(500);
      expect(json).toEqual({ error: 'Internal server error' });
      expect(text).not.toContain('secreto-xyz');
      expect(text).not.toMatch(/\bat\s/);
      expect(json.stack).toBeUndefined();
    } finally {
      await close();
    }
  });
});
