import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyDevEmailEnvDefault, isEmailConfigured } from './emailConfig.js';

const KEYS = ['NODE_ENV', 'EMAIL_HOST', 'EMAIL_USER', 'RESEND_API_KEY'];
let saved;

describe('applyDevEmailEnvDefault — OSS', () => {
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('no fija EMAIL_HOST ni otros defaults de email fuera de production', () => {
    process.env.NODE_ENV = 'development';
    expect(isEmailConfigured()).toBe(false);
    applyDevEmailEnvDefault();
    expect(process.env.EMAIL_HOST, 'OSS no debe inyectar EMAIL_HOST=localhost').toBeUndefined();
    expect(process.env.EMAIL_USER).toBeUndefined();
    expect(process.env.RESEND_API_KEY).toBeUndefined();
    expect(isEmailConfigured()).toBe(false);
  });

  it('en production tampoco toca el entorno', () => {
    process.env.NODE_ENV = 'production';
    applyDevEmailEnvDefault();
    expect(process.env.EMAIL_HOST).toBeUndefined();
  });
});
