/**
 * T7 (OSS): el webhook `POST /webhooks/notify` (server/routes/emailNotify.js)
 * verifica `X-Webhook-Secret` comparando dos cadenas controladas por el
 * atacante (la cabecera) y el servidor (`WEBHOOK_SECRET`). Hoy lo hace con
 * `secret !== process.env.WEBHOOK_SECRET`, una comparación `!==` de V8 que
 * sale en cuanto encuentra el primer byte distinto — un timing attack clásico
 * (ver CWE-208). Debe compararse con `crypto.timingSafeEqual`, que:
 *   - es de tiempo constante para buffers de IGUAL longitud;
 *   - lanza si las longitudes difieren, así que el handler tiene que comparar
 *     la longitud ANTES de llamar a timingSafeEqual (o rellenar) para no
 *     devolver un 500 cuando la cabecera trae menos o más bytes que el secreto.
 *
 * Este repo no tiene `server/app.js` con `createApp()` ni `supertest` en
 * node_modules (ver server/index.js: crea el `app` y llama a `.listen()` en el
 * módulo), así que el comportamiento se prueba invocando el handler de
 * Express directamente con un req/res de pega — mismo patrón que
 * server/routes/contactForm.test.js y adminForceAssetPrice.test.js. El día
 * que exista `server/app.js` + `supertest`, esto puede migrar a una prueba de
 * integración HTTP real sin cambiar las aserciones.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { emailNotify } from '../../server/routes/emailNotify.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const EMAIL_NOTIFY_PATH = path.join(ROOT, 'server/routes/emailNotify.js');

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

// Secreto de fixture, NUNCA uno real: solo existe para este test.
const FIXTURE_SECRET = 'oss-t7-fixture-secret-do-not-use-in-prod';

describe('server/routes/emailNotify.js — comparación del secreto del webhook (estático)', () => {
  it('existe el route handler del webhook con secreto', () => {
    expect(fs.existsSync(EMAIL_NOTIFY_PATH), 'falta server/routes/emailNotify.js').toBe(true);
  });

  const src = fs.existsSync(EMAIL_NOTIFY_PATH) ? fs.readFileSync(EMAIL_NOTIFY_PATH, 'utf8') : '';

  it('importa timingSafeEqual de node:crypto', () => {
    expect(
      /from\s+['"]node:crypto['"]/.test(src) || /from\s+['"]crypto['"]/.test(src),
      'emailNotify.js no importa el módulo crypto (falta crypto.timingSafeEqual)',
    ).toBe(true);
    expect(
      /timingSafeEqual/.test(src),
      'emailNotify.js no usa crypto.timingSafeEqual para comparar el secreto del webhook',
    ).toBe(true);
  });

  it('NO compara el secreto con === / !== (timing attack, CWE-208)', () => {
    // Cualquier comparación directa de `secret` (la cabecera) contra
    // WEBHOOK_SECRET con === o !== es insegura, exista o no timingSafeEqual
    // en otra parte del fichero (no vale "añadir" timingSafeEqual sin quitar
    // la comparación insegura original).
    const insecureCompare = /\bsecret\b[^\n;]*(===|!==)[^\n;]*WEBHOOK_SECRET|WEBHOOK_SECRET[^\n;]*(===|!==)[^\n;]*\bsecret\b/;
    expect(
      insecureCompare.test(src),
      'emailNotify.js sigue comparando el secreto del webhook con === / !== en vez de crypto.timingSafeEqual',
    ).toBe(false);
  });
});

describe('POST /webhooks/notify — comportamiento del handler emailNotify (vía fakeRes, sin supertest/app.js)', () => {
  beforeEach(() => {
    // `process.env.WEBHOOK_SECRET` se lee dentro del handler EN CADA
    // petición (no a import-time), así que basta con fijarla antes de llamar.
    process.env.WEBHOOK_SECRET = FIXTURE_SECRET;
  });

  afterEach(() => {
    delete process.env.WEBHOOK_SECRET;
  });

  it('secreto correcto: pasa la verificación (no 401)', async () => {
    const res = fakeRes();
    await emailNotify({ headers: { 'x-webhook-secret': FIXTURE_SECRET }, body: {} }, res);
    expect(res.statusCode).not.toBe(401);
  });

  it('secreto incorrecto de IGUAL longitud: 401', async () => {
    const wrong = FIXTURE_SECRET.slice(0, -1) + (FIXTURE_SECRET.at(-1) === 'x' ? 'y' : 'x');
    expect(wrong).toHaveLength(FIXTURE_SECRET.length);
    const res = fakeRes();
    await emailNotify({ headers: { 'x-webhook-secret': wrong }, body: {} }, res);
    expect(res.statusCode).toBe(401);
  });

  it('secreto incorrecto más CORTO: 401 (no debe lanzar/500 por longitudes distintas)', async () => {
    const res = fakeRes();
    await emailNotify({ headers: { 'x-webhook-secret': FIXTURE_SECRET.slice(0, 5) }, body: {} }, res);
    expect(res.statusCode).toBe(401);
  });

  it('secreto incorrecto más LARGO: 401 (no debe lanzar/500 por longitudes distintas)', async () => {
    const res = fakeRes();
    await emailNotify({ headers: { 'x-webhook-secret': `${FIXTURE_SECRET}-extra` }, body: {} }, res);
    expect(res.statusCode).toBe(401);
  });

  it('cabecera ausente: 401', async () => {
    const res = fakeRes();
    await emailNotify({ headers: {}, body: {} }, res);
    expect(res.statusCode).toBe(401);
  });

  it('WEBHOOK_SECRET sin configurar en el servidor: 401 aunque la cabecera coincida con el texto vacío', async () => {
    delete process.env.WEBHOOK_SECRET;
    const res = fakeRes();
    await emailNotify({ headers: { 'x-webhook-secret': '' }, body: {} }, res);
    expect(res.statusCode).toBe(401);
  });
});
