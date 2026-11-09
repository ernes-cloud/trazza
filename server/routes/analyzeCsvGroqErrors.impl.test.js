import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

// Synthetic credential: enables the gate only; provider calls remain mocked.
const SAVED_GROQ_API_KEY = process.env.GROQ_API_KEY;
beforeAll(() => { process.env.GROQ_API_KEY = 'TDD_FAKE_GROQ_API_KEY_NOT_A_REAL_CREDENTIAL'; });
afterAll(() => {
  if (SAVED_GROQ_API_KEY === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = SAVED_GROQ_API_KEY;
});


const groqJsonCall = vi.hoisted(() => vi.fn());

vi.mock('../lib/groqJson.js', () => ({ groqJsonCall }));
vi.mock('../lib/logBuffer.js', () => ({ addLog: vi.fn() }));

import { analyzeCsv } from './analyzeCsv.js';

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

const csvText = 'fecha,isin,type,total\n01-01-2026,US0378331005,BUY,-100';

describe('analyzeCsv Groq outage mapping (m-4)', () => {
  beforeEach(() => {
    groqJsonCall.mockReset();
  });

  it('returns AI_OVERLOADED when all chunks fail with 429', async () => {
    groqJsonCall.mockImplementation(async () => {
      const err = new Error('rate limited');
      err.status = 429;
      throw err;
    });
    const req = { body: { csvText, broker: 'degiro' }, incrementUsage: vi.fn(async () => {}) };
    const res = makeRes();

    await analyzeCsv(req, res);

    expect(groqJsonCall).toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'AI_OVERLOADED', code: 'AI_OVERLOADED' });
  });

  it('returns AI_UNAVAILABLE when all chunks fail with 403', async () => {
    groqJsonCall.mockImplementation(async () => {
      const err = new Error('geo blocked');
      err.status = 403;
      throw err;
    });
    const req = { body: { csvText, broker: 'degiro' }, incrementUsage: vi.fn(async () => {}) };
    const res = makeRes();

    await analyzeCsv(req, res);

    expect(groqJsonCall).toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'AI_UNAVAILABLE', code: 'AI_UNAVAILABLE' });
  });
});
