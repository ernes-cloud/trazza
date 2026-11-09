import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const KEYS = ['APP_URL', 'VITE_APP_URL'];
let saved;

async function loadGetAppUrl() {
  vi.resetModules();
  const mod = await import('./appUrl.js');
  return mod.getAppUrl;
}

describe('getAppUrl — APP_URL esquema', () => {
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

  it('acepta https:// en cualquier host', async () => {
    process.env.APP_URL = 'https://app.example.com/';
    const getAppUrl = await loadGetAppUrl();
    expect(getAppUrl()).toBe('https://app.example.com');
  });

  it('acepta http://localhost con puerto', async () => {
    process.env.APP_URL = 'http://localhost:5173';
    const getAppUrl = await loadGetAppUrl();
    expect(getAppUrl()).toBe('http://localhost:5173');
  });

  it('acepta http://127.0.0.1 con puerto', async () => {
    process.env.APP_URL = 'http://127.0.0.1:3000';
    const getAppUrl = await loadGetAppUrl();
    expect(getAppUrl()).toBe('http://127.0.0.1:3000');
  });

  it('rechaza http:// en host no local', async () => {
    process.env.APP_URL = 'http://evil.example';
    const getAppUrl = await loadGetAppUrl();
    expect(() => getAppUrl()).toThrow(/APP_URL|https|http/i);
  });

  it('rechaza http://example.com', async () => {
    process.env.APP_URL = 'http://example.com';
    const getAppUrl = await loadGetAppUrl();
    expect(() => getAppUrl()).toThrow(/APP_URL|https|http/i);
  });

  it('rechaza //evil.example (sin esquema)', async () => {
    process.env.APP_URL = '//evil.example';
    const getAppUrl = await loadGetAppUrl();
    expect(() => getAppUrl()).toThrow(/APP_URL|https|http/i);
  });
});
