import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

vi.mock('./routes/rateLimiter.js', () => ({
  withRateLimit: () => (req, _res, next) => {
    req.userId = 'u1';
    req.userPlan = 'free';
    req.incrementUsage = async () => {};
    next();
  },
  PLAN_LIMITS: {},
  AI_LIMITS: {},
}));

vi.mock('./lib/groqClient.js', () => ({
  getGroq: vi.fn(() => ({ chat: { completions: { create: vi.fn() } } })),
}));

vi.mock('./lib/logBuffer.js', () => ({ addLog: vi.fn() }));

import { createApp } from './app.js';

describe('smoke mocked auth input validation (m-9b)', () => {
  it('portfolio-chat keeps exact 400 contract body for malformed messages payload', async () => {
    const app = createApp();

    const res = await request(app)
      .post('/api/portfolio-chat')
      .send({ context: {}, messages: [null] });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'messages must be objects with role and content strings' });
    expect(res.text).not.toMatch(/\b(stack|at\s+|TypeError|ReferenceError|SyntaxError)\b/i);
    expect(res.text).not.toContain('err.message');
  });

  it('score-portfolio keeps exact 400 contract body for malformed breakdown payload', async () => {
    const app = createApp();

    const res = await request(app)
      .post('/api/score-portfolio')
      .send({ score: 1, breakdown: 1 });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'score and breakdown are required' });
    expect(res.text).not.toMatch(/\b(stack|at\s+|TypeError|ReferenceError|SyntaxError)\b/i);
    expect(res.text).not.toContain('err.message');
  });
});
