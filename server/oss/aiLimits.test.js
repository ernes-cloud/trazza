/** Planner route 38: authenticated, read-only server quota configuration.
 * Response follows getAiLimits' existing public shape, without user records.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
const { supabase, users } = vi.hoisted(() => {
  const users = {
    'token-a': { id: 'limits-user-a', email: 'a@example.com', email_confirmed_at: '2020-01-01T00:00:00Z' },
    'token-b': { id: 'limits-user-b', email: 'b@example.com', email_confirmed_at: '2020-01-01T00:00:00Z' },
  };
  return { users, supabase: {
    auth: { getUser: vi.fn(async (token) => ({ data: { user: users[token] || null }, error: users[token] ? null : { message: 'invalid synthetic token' } })) },
    from: vi.fn(() => { throw new Error('limits configuration must not query user records'); }),
    rpc: vi.fn(() => { throw new Error('read-only limits must not mutate via RPC'); }),
  } };
});
vi.mock('../lib/adminSupabase.js', () => ({ supabaseAdmin: supabase }));
vi.mock('dotenv', () => ({ default: { config: vi.fn(() => ({ parsed: {} })) } }));
const CONFIG = {
  NODE_ENV: 'test', ADMIN_EMAILS: 'different-admin@example.com',
  GROQ_API_KEY: 'TDD_FAKE_GROQ_API_KEY_NOT_A_REAL_CREDENTIAL',
  AI_DAILY_LIMIT_CHAT: '7', AI_MONTHLY_LIMIT_CHAT: '71',
  AI_DAILY_LIMIT_ANALYSIS: '11', AI_MONTHLY_LIMIT_ANALYSIS: '111',
  AI_DAILY_LIMIT_IMPORT: '13', AI_MONTHLY_LIMIT_IMPORT: '131',
};
const EXPECTED = { enabled: true,
  chat: { daily: 7, monthly: 71 }, analysis: { daily: 11, monthly: 111 }, import: { daily: 13, monthly: 131 } };
let saved; let app;
beforeEach(async () => {
  saved = Object.fromEntries(Object.keys(CONFIG).map((key) => [key, process.env[key]]));
  Object.assign(process.env, CONFIG);
  vi.clearAllMocks(); vi.resetModules();
  const { createApp } = await import('../app.js');
  app = createApp();
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
describe('GET /api/ai/limits — authenticated read-only server configuration', () => {
  it('401 without a session', async () => {
    const response = await request(app).get('/api/ai/limits');
    expect(response.status).toBe(401);
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
  it('401 with an invalid token', async () => {
    const response = await request(app).get('/api/ai/limits').set('Authorization', 'Bearer invalid-token');
    expect(response.status).toBe(401);
  });
  it('200 for a normal non-admin user, returning configured server limits', async () => {
    const response = await request(app).get('/api/ai/limits').set('Authorization', 'Bearer token-a');
    expect(response.status).toBe(200);
    expect(supabase.auth.getUser).toHaveBeenCalledWith('token-a');
    expect(response.body).toEqual(EXPECTED);
  });
  it('returns no other users data and does not trust query-supplied userId or limits', async () => {
    for (const [token, other] of [['token-a', users['token-b']], ['token-b', users['token-a']]]) {
      const response = await request(app).get('/api/ai/limits')
        .query({ userId: other.id, AI_DAILY_LIMIT_CHAT: 999999 }).set('Authorization', `Bearer ${token}`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual(EXPECTED);
      expect(JSON.stringify(response.body)).not.toContain(other.id);
      expect(JSON.stringify(response.body)).not.toContain(other.email);
    }
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
  for (const method of ['post', 'put', 'delete']) {
    it(`${method.toUpperCase()} is 404/405 and cannot mutate limits or user data`, async () => {
      const response = await request(app)[method]('/api/ai/limits').set('Authorization', 'Bearer token-a')
        .send({ userId: users['token-b'].id, AI_DAILY_LIMIT_CHAT: 999999 });
      expect([404, 405]).toContain(response.status);
      expect(process.env.AI_DAILY_LIMIT_CHAT).toBe('7');
      expect(supabase.from).not.toHaveBeenCalled();
      expect(supabase.rpc).not.toHaveBeenCalled();
    });
  }
});
