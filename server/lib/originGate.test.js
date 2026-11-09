import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { isOriginAllowed } from './originGate.js';

describe('isOriginAllowed', () => {
  it('sin Origin: solo fuera de producción', () => {
    expect(isOriginAllowed(undefined, { isProd: true })).toBe(false);
    expect(isOriginAllowed(undefined, { isProd: false })).toBe(true);
  });

  it('permite listas allowed/dev', () => {
    expect(isOriginAllowed('https://evil.example', {
      allowed: ['https://example.com'],
      dev: ['http://localhost:3000'],
      isProd: true,
    })).toBe(false);
    expect(isOriginAllowed('https://example.com', {
      allowed: ['https://example.com'],
      isProd: true,
    })).toBe(true);
  });
});

describe('originGate vía createApp (supertest real)', () => {
  let app;
  let prevOrigins;
  let prevNodeEnv;

  beforeAll(async () => {
    prevOrigins = process.env.ALLOWED_ORIGINS;
    prevNodeEnv = process.env.NODE_ENV;
    process.env.ALLOWED_ORIGINS = 'https://example.com';
    process.env.NODE_ENV = 'production';
    process.env.DISABLE_CRONS = '1';
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_URL;
    const mod = await import('../app.js');
    app = mod.createApp();
  });

  afterAll(() => {
    if (prevOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = prevOrigins;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  });

  it('Origin no permitido → 403 en GET y en preflight', async () => {
    const get = await request(app).get('/health').set('Origin', 'https://evil.example');
    expect(get.status).toBe(403);
    expect(get.body).toEqual({ error: 'Forbidden' });

    const pre = await request(app)
      .options('/api/contact')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(pre.status).toBe(403);
  });

  it('Origin permitido llega a la ruta', async () => {
    const res = await request(app).get('/health').set('Origin', 'https://example.com');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('sin Origin no corta (curl / server-to-server)', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });
});
