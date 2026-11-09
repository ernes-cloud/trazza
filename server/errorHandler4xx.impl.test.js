import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp, errorHandler } from './app.js';

function makeRes() {
  return {
    statusCode: null,
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
}

describe('errorHandler4xx.impl — generic 4xx branch does not leak messages', () => {
  it('direct call: preserves 404/422/409 and always returns generic body without SECRET leak', () => {
    for (const status of [404, 422, 409]) {
      const err = new Error(`SECRET-4XX-LEAK-${status}`);
      err.status = status;
      const res = makeRes();

      errorHandler(err, {}, res, () => {});

      expect(res.statusCode).toBe(status);
      expect(res.body).toEqual({ error: 'Bad request' });
      expect(JSON.stringify(res.body)).not.toContain('SECRET-4XX-LEAK');
    }
  });

  it('direct call: 400 without expose uses generic body', () => {
    const err = Object.assign(new Error('SECRET-4XX-LEAK'), { status: 400 });
    const res = makeRes();

    errorHandler(err, {}, res, () => {});

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Bad request' });
    expect(JSON.stringify(res.body)).not.toContain('SECRET-4XX-LEAK');
  });

  it('direct call: 400 with expose=true still returns generic body', () => {
    const err = Object.assign(new Error('Typed msg'), { status: 400, expose: true });
    const res = makeRes();

    errorHandler(err, {}, res, () => {});

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Bad request' });
  });

  it('createApp route throw: 404/422/409 preserve status, keep generic body, never leak SECRET', async () => {
    const app = createApp();
    app.get('/__test/throw-4xx/:status', (req, _res, next) => {
      const err = new Error('SECRET-4XX-LEAK');
      err.status = Number(req.params.status);
      next(err);
    });
    // createApp mounts errorHandler before custom test routes; mount again to catch these.
    app.use(errorHandler);

    for (const status of [404, 422, 409]) {
      const res = await request(app).get(`/__test/throw-4xx/${status}`);
      expect(res.status).toBe(status);
      expect(res.body).toEqual({ error: 'Bad request' });
      expect(JSON.stringify(res.body)).not.toContain('SECRET-4XX-LEAK');
    }
  });
});
