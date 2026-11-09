/**
 * N1v2 m2 — q[] en admin users/beta → 400; type no string en beta-allowlist → 400;
 * decodeURIComponent inválido en yahoo-profile → 400.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';

const requireAdmin = vi.hoisted(() => vi.fn(async () => ({ id: 'admin-1' })));

vi.mock('./lib/requireUser.js', () => ({
  requireUser: vi.fn(async () => ({ id: 'u1' })),
}));
vi.mock('./lib/requireAdmin.js', () => ({ requireAdmin }));
vi.mock('./lib/adminSupabase.js', () => ({
  supabaseAdmin: {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: 'admin-1' } }, error: null })),
      admin: {
        listUsers: vi.fn(async () => ({ data: { users: [] }, error: null })),
      },
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({ data: { plan: 'admin' }, error: null })),
          order: vi.fn(() => ({
            limit: vi.fn(async () => ({ data: [], error: null })),
          })),
          gte: vi.fn(async () => ({ count: 0, error: null })),
        })),
        order: vi.fn(() => ({
          limit: vi.fn(async () => ({ data: [], error: null })),
        })),
        ilike: vi.fn(() => ({
          // chain continues if needed
        })),
      })),
      upsert: vi.fn(() => ({
        select: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({ data: null, error: null })),
        })),
      })),
    })),
  },
}));
vi.mock('./routes/rateLimiter.js', () => ({
  withRateLimit: () => (req, _res, next) => next(),
  PLAN_LIMITS: {},
  AI_LIMITS: {},
}));
vi.mock('./lib/groqClient.js', () => ({
  getGroq: vi.fn(() => ({ chat: { completions: { create: vi.fn() } } })),
}));
vi.mock('./lib/emailTransport.js', () => ({
  sendEmail: vi.fn(async () => ({ ok: true })),
}));
vi.mock('./lib/logBuffer.js', () => ({ addLog: vi.fn() }));
vi.mock('./jobs/notificationCron.js', () => ({ startNotificationCron: vi.fn() }));
vi.mock('./jobs/portfolioSnapshots.js', () => ({ startPortfolioSnapshotsCron: vi.fn() }));
vi.mock('./jobs/weeklyReport.js', () => ({ startWeeklyReportCron: vi.fn() }));
vi.mock('./jobs/siteVisits.js', () => ({ startSiteVisitsCron: vi.fn() }));
vi.mock('./jobs/activationEmail.js', () => ({ startActivationEmailCron: vi.fn() }));

import { createApp } from './app.js';

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

async function jsonReq(baseUrl, path, opts = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...opts,
    headers: {
      Authorization: 'Bearer admin',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    },
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, body, text };
}

describe('inputValidation.impl — m2', () => {
  let harness;

  beforeAll(async () => {
    harness = await listen(createApp());
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('GET /api/admin/users?q[]=x → 400', async () => {
    const { status, body } = await jsonReq(harness.baseUrl, '/api/admin/users?q[]=x');
    expect(status).toBe(400);
    expect(body?.error).toBeTruthy();
  });

  it('GET /api/admin/beta?q[]=x → 404 (beta fuera de OSS)', async () => {
    const { status } = await jsonReq(harness.baseUrl, '/api/admin/beta?q[]=x');
    expect(status).toBe(404);
  });

  it('POST /api/admin/beta-allowlist → 404 (beta fuera de OSS)', async () => {
    const { status } = await jsonReq(harness.baseUrl, '/api/admin/beta-allowlist', {
      method: 'POST',
      body: JSON.stringify({ type: 5, value: 'evil.com' }),
    });
    expect(status).toBe(404);
  });

  it('GET /api/yahoo-profile/%25zz → 400 (decodeURIComponent try/catch)', async () => {
    const { status, body, text } = await jsonReq(harness.baseUrl, '/api/yahoo-profile/%25zz');
    expect(status).toBe(400);
    expect(body?.error).toBeTruthy();
    expect(text).not.toMatch(/URIError/i);
  }, 10000);
});
