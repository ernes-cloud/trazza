/**
 * Error handler REAL de createApp (no réplica): JSON mal formado → 400 claro;
 * 413/415 de body-parser; TypeError async → 500 genérico sin filtrar err.message.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Synthetic credential: enables the gate only; provider calls remain mocked.
const SAVED_GROQ_API_KEY = process.env.GROQ_API_KEY;
beforeAll(() => { process.env.GROQ_API_KEY = 'TDD_FAKE_GROQ_API_KEY_NOT_A_REAL_CREDENTIAL'; });
afterAll(() => {
  if (SAVED_GROQ_API_KEY === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = SAVED_GROQ_API_KEY;
});

import request from 'supertest';

let app;
let errorHandler;

function fakeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

beforeAll(async () => {
  process.env.DISABLE_CRONS = '1';
  process.env.NODE_ENV = 'development';
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  const mod = await import('./app.js');
  app = mod.createApp();
  errorHandler = mod.errorHandler;
});

describe('error handler (createApp)', () => {
  it('body JSON inválido responde 400 con mensaje claro (no Internal server error)', async () => {
    const res = await request(app)
      .post('/api/contact')
      .set('Content-Type', 'application/json')
      .send('{not-json');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid JSON' });
    expect(res.body.error).not.toMatch(/Internal server error|SyntaxError|Unexpected/i);
  });

  it('body > límite 512kb → 413 Payload too large', async () => {
    const big = JSON.stringify({ name: 'x', email: 'a@example.com', message: 'm'.repeat(600 * 1024) });
    const res = await request(app)
      .post('/api/contact')
      .set('Content-Type', 'application/json')
      .send(big);
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'Payload too large' });
  });

  it('TypeError async en ruta (score-portfolio breakdown vacío) → 500; /health ok', async () => {
    // {} es truthy: pasa el check `!breakdown` y al leer performance.gainPct
    // lanza. asyncHandler + error handler real; no filtrar mensaje interno.
    const res = await request(app)
      .post('/api/score-portfolio')
      .send({ score: 1, breakdown: {} });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toMatch(/gainPct|TypeError|Cannot read/i);

    const health = await request(app).get('/health');
    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');
  });

  it("'Invalid JSON' solo cuando err.type === 'entity.parse.failed'", () => {
    const parse = Object.assign(new SyntaxError('Unexpected token n in JSON at position 1'), { status: 400, type: 'entity.parse.failed' });
    const r1 = fakeRes();
    errorHandler(parse, {}, r1, () => {});
    expect(r1.statusCode).toBe(400);
    expect(r1.body).toEqual({ error: 'Invalid JSON' });

    // 400 sin ese type no se etiqueta como JSON inválido
    const other = Object.assign(new Error('request aborted'), { status: 400, type: 'request.aborted' });
    const r2 = fakeRes();
    errorHandler(other, {}, r2, () => {});
    expect(r2.statusCode).toBe(400);
    expect(r2.body.error).not.toBe('Invalid JSON');
  });

  it('cualquier 400 que no sea entity.parse.failed responde Bad request sin err.message (I-1)', () => {
    const typed = Object.assign(new Error('unsupported charset "X"'), { status: 400, expose: true, type: 'charset.unsupported' });
    const res = fakeRes();
    errorHandler(typed, {}, res, () => {});
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Bad request' });
    expect(JSON.stringify(res.body)).not.toContain('unsupported charset');

    // gzip roto: zlib lanza 'incorrect header check'
    const gz = Object.assign(new Error('incorrect header check'), { status: 400, errno: -3, code: 'Z_DATA_ERROR' });
    const r2 = fakeRes();
    errorHandler(gz, {}, r2, () => {});
    expect(r2.statusCode).toBe(400);
    expect(r2.body).toEqual({ error: 'Bad request' });
    expect(JSON.stringify(r2.body)).not.toContain('incorrect header check');
  });
});
