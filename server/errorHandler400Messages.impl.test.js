import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { gzipSync } from 'node:zlib';
import { createApp, errorHandler } from './app.js';

function makeRes() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

describe('errorHandler 400 contract (I-4)', () => {
  it('entity.parse.failed keeps canonical Invalid JSON body', () => {
    const res = makeRes();
    errorHandler({ status: 400, type: 'entity.parse.failed', message: 'Unexpected token x in JSON' }, {}, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid JSON' });
  });

  it('other 400 errors always return the generic body', () => {
    const res = makeRes();
    errorHandler({ status: 400, message: 'Invalid ticker', expose: true }, {}, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Bad request' });
  });
});

describe('errorHandler 400 contract over HTTP (I-1)', () => {
  it('broken gzip body returns generic 400 without leaking zlib details', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/contact')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .send(Buffer.from('not-a-gzip-stream'));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Bad request' });
  });

  it('truncated gzip body returns generic 400 without leaking zlib details', async () => {
    const app = createApp();
    const full = gzipSync(Buffer.from('{"name":"Ana","email":"ana@example.com","message":"hola"}'));
    const truncated = full.subarray(0, Math.max(1, full.length - 6));
    const res = await request(app)
      .post('/api/contact')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .send(Buffer.from(truncated));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Bad request' });
  });
});
