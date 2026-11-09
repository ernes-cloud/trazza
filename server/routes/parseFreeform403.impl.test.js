import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// Synthetic credential: enables the gate only; provider calls remain mocked.
const SAVED_GROQ_API_KEY = process.env.GROQ_API_KEY;
beforeAll(() => { process.env.GROQ_API_KEY = 'TDD_FAKE_GROQ_API_KEY_NOT_A_REAL_CREDENTIAL'; });
afterAll(() => {
  if (SAVED_GROQ_API_KEY === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = SAVED_GROQ_API_KEY;
});


const groqJsonCall = vi.hoisted(() => vi.fn(async () => {
  const err = new Error('geo blocked');
  err.status = 403;
  throw err;
}));

vi.mock('../lib/groqJson.js', () => ({ groqJsonCall }));
vi.mock('../lib/logBuffer.js', () => ({ addLog: vi.fn() }));

import { parseFreeform } from './parseFreeform.js';

function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

describe('parseFreeform 403 contract (m-4)', () => {
  it('returns AI_REGION_BLOCKED when every text chunk fails with 403', async () => {
    const req = {
      body: {
        text: Array.from({ length: 120 }, (_, i) => `01/01/2026 Compra Fondo Global ${i + 1}`).join('\n'),
      },
      incrementUsage: vi.fn(async () => {}),
    };
    const res = makeRes();

    await parseFreeform(req, res);

    expect(groqJsonCall).toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      error: 'AI_REGION_BLOCKED',
      code: 'AI_REGION_BLOCKED',
    });
  });
});
