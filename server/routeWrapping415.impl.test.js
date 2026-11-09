import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { fileURLToPath } from 'node:url';

const portfolioChat = vi.hoisted(() => vi.fn(async () => {
  throw new Error('portfolio-chat-dependency-crash');
}));
const contactForm = vi.hoisted(() => vi.fn(async () => {
  throw new Error('contact-form-dependency-crash');
}));

vi.mock('./routes/portfolioChat.js', () => ({ portfolioChat }));
vi.mock('./routes/contactForm.js', () => ({ contactForm }));

let app;
const APP_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'app.js');

beforeAll(async () => {
  process.env.NODE_ENV = 'development';
  delete process.env.SUPABASE_URL;
  delete process.env.VITE_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const mod = await import('./app.js');
  app = mod.createApp();
});

describe('m-3 route wrapping and 415 contract', () => {
  it('app.js wraps /api/portfolio-chat and /api/contact with asyncHandler', () => {
    const src = fs.readFileSync(APP_PATH, 'utf8');
    expect(src).toMatch(/app\.post\('\/api\/portfolio-chat',\s*asyncHandler\(withRateLimit\('chat'\)\),\s*asyncHandler\(portfolioChat\)\);/);
    expect(src).toMatch(/app\.post\('\/api\/contact',\s*asyncHandler\(contactLimiter\),\s*asyncHandler\(contactForm\)\);/);
  });

  it('unsupported content-encoding returns 415 typed payload', async () => {
    const res = await request(app)
      .post('/api/contact')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'zstd')
      .send('{"name":"A","email":"a@example.com","message":"hi"}');

    expect(res.status).toBe(415);
    expect(res.body).toEqual({ error: 'Unsupported media type' });
  });

  it('/api/portfolio-chat throw path returns generic 500 quickly', async () => {
    const t0 = Date.now();
    const res = await request(app)
      .post('/api/portfolio-chat')
      .set('Content-Type', 'application/json')
      .send({ context: {}, messages: [{ role: 'user', content: 'hola' }] });
    const dt = Date.now() - t0;

    expect(portfolioChat).toHaveBeenCalled();
    expect(dt).toBeLessThan(1000);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  it('/api/contact throw path returns generic 500 quickly', async () => {
    const t0 = Date.now();
    const res = await request(app)
      .post('/api/contact')
      .set('Content-Type', 'application/json')
      .send({ name: 'Ana', email: 'ana@example.com', message: 'hola' });
    const dt = Date.now() - t0;

    expect(contactForm).toHaveBeenCalled();
    expect(dt).toBeLessThan(1000);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});
