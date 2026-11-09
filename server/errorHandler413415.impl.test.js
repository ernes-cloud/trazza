import { describe, it, expect } from 'vitest';
import { errorHandler } from './app.js';

function mkRes() {
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

describe('errorHandler413415.impl — typed 4xx without leaks', () => {
  it('413 returns typed payload and never leaks err.message/stack', () => {
    const err = new Error('LEAK_413_SECRET');
    err.status = 413;
    err.stack = 'STACK_413_SECRET';

    const res = mkRes();
    errorHandler(err, {}, res, () => {});

    expect(res.statusCode).toBe(413);
    expect(res.body).toEqual({ error: 'Payload too large' });
    const bodyText = JSON.stringify(res.body);
    expect(bodyText).not.toContain('LEAK_413_SECRET');
    expect(bodyText).not.toContain('STACK_413_SECRET');
    expect(res.body.message).toBeUndefined();
    expect(res.body.stack).toBeUndefined();
  });

  it('415 returns typed payload and never leaks err.message/stack', () => {
    const err = new Error('LEAK_415_SECRET');
    err.statusCode = 415;
    err.stack = 'STACK_415_SECRET';

    const res = mkRes();
    errorHandler(err, {}, res, () => {});

    expect(res.statusCode).toBe(415);
    expect(res.body).toEqual({ error: 'Unsupported media type' });
    const bodyText = JSON.stringify(res.body);
    expect(bodyText).not.toContain('LEAK_415_SECRET');
    expect(bodyText).not.toContain('STACK_415_SECRET');
    expect(res.body.message).toBeUndefined();
    expect(res.body.stack).toBeUndefined();
  });
});
