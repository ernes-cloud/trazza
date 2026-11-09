/**
 * T6 (OSS) — Contrato de "degradación explícita" para el self-hoster que
 * levanta el server sin todas las credenciales opcionales configuradas:
 *
 *   ┌───────────────────┬──────────────────────────────────────────────────┐
 *   │ Sin...             │ la ruta afectada responde...                     │
 *   ├───────────────────┼──────────────────────────────────────────────────┤
 *   │ GROQ_API_KEY       │ 503 { error: 'ai_not_configured' }               │
 *   │ SMTP/Resend        │ 503 { error: 'email_not_configured' }            │
 *   │ EODHD key          │ 503 { error: 'eodhd_not_configured' }            │
 *   └───────────────────┴──────────────────────────────────────────────────┘
 *
 * HOY los routes de IA (portfolioChat, analyzeEarnings…) atrapan el error de
 * `getGroq()` (que SÍ marca `err.status = 503`, ver server/lib/groqClient.js)
 * y lo convierten en un 200 con `{ isFallback: true }` o un mensaje de chat
 * genérico — para la UI normal es la UX correcta (no romper el chat), pero
 * para un self-hoster que está depurando "¿por qué no responde la IA?" un 200
 * silencioso es indistinguible de "funciona pero no tiene nada que decir".
 * Este contrato pide una señal explícita además de la degradación suave.
 *
 * Orden del contrato para las rutas de IA (válido para TODO el bloque de
 * abajo, con o sin GROQ_API_KEY): primero se VALIDA el body (400 si está mal
 * formado, sin tocar Groq para nada) y solo si el body es válido se comprueba
 * si la IA está configurada (503 `ai_not_configured`). Por eso cada ruta lleva
 * un par de casos: un body INVÁLIDO → 400 (la validación de la ruta ya hace
 * esto hoy, antes de llegar a `getGroq()`), y un body VÁLIDO → 503 (rojo hoy:
 * la ruta capta el 503 de `getGroq()` y lo convierte en 200 de fallback). Un
 * caso que pidiera 503 con body vacío/inválido sería el contrato al revés —
 * no debe aparecer aquí.
 *
 * Email: `server/lib/emailTransport.js` SIEMPRE construye un transporte (cae
 * a Postfix en localhost:25 sin RESEND_API_KEY/EMAIL_HOST) — no existe hoy el
 * concepto de "sin configurar", así que un self-hoster sin SMTP ve timeouts
 * de red en vez de un error claro. Este test exige un nuevo export
 * `isEmailConfigured()` en ese módulo.
 *
 * EODHD: `eodhdSecure` (server/routes/marketProxy.js) ya detecta la ausencia
 * de key, pero responde 403 `{ error: 'API key not configured. Add it in
 * Settings.' }` — pensado para "añade tu key en Ajustes", no para "el server
 * no tiene la feature habilitada". Este test exige 503 `eodhd_not_configured`.
 *
 * Yahoo caído: la función de cotizaciones del server (`getYahooQuotes` en
 * server/lib/marketQuotes.js) ya NO debe devolver un precio 0 si Yahoo
 * rechaza todas las peticiones — debe omitir el ticker (ausente del Map) en
 * vez de inventar un precio. Se prueba con `global.fetch` mockeado para que
 * rechace siempre.
 */
import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

describe('IA sin GROQ_API_KEY — contrato 503 { error: "ai_not_configured" }', () => {
  const savedKey = process.env.GROQ_API_KEY;

  beforeEach(() => {
    delete process.env.GROQ_API_KEY;
  });
  afterEach(() => {
    if (savedKey) process.env.GROQ_API_KEY = savedKey; else delete process.env.GROQ_API_KEY;
  });

  it('POST /api/portfolio-chat con body INVÁLIDO responde 400, incluso sin GROQ_API_KEY (la validación corre antes de tocar Groq)', async () => {
    const { portfolioChat } = await import('../routes/portfolioChat.js');
    const res = fakeRes();
    // Sin `context` — el validador de la ruta (server/routes/portfolioChat.js)
    // responde 400 ANTES de intentar `getGroq()`, así que el resultado es el
    // mismo con o sin GROQ_API_KEY. Verifica que el 503 no se adelanta a la
    // validación.
    await portfolioChat({ body: { messages: [{ role: 'user', content: 'hola' }] } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/portfolio-chat con body VÁLIDO responde 503 ai_not_configured (hoy: 200 con reply de fallback)', async () => {
    const { portfolioChat } = await import('../routes/portfolioChat.js');
    const res = fakeRes();
    await portfolioChat({
      body: {
        context: { totalWealth: 1000, positions: [], brokers: ['Test'] },
        messages: [{ role: 'user', content: 'hola' }],
      },
    }, res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'ai_not_configured' });
  });

  it('POST /api/analyze-earnings con body INVÁLIDO (sin ticker) responde 400, incluso sin GROQ_API_KEY', async () => {
    const { analyzeEarnings } = await import('../routes/analyzeEarnings.js');
    const res = fakeRes();
    // `sanitizeEarningsPayload` devuelve null sin un ticker usable → 400 antes
    // de construir el prompt o tocar `getGroq()`.
    await analyzeEarnings({ body: {} }, res);
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/analyze-earnings con body VÁLIDO responde 503 ai_not_configured (hoy: 200 con isFallback)', async () => {
    const { analyzeEarnings } = await import('../routes/analyzeEarnings.js');
    const res = fakeRes();
    await analyzeEarnings({ body: { ticker: 'AAPL' } }, res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'ai_not_configured' });
  });
});

describe('Email sin SMTP/Resend — contrato 503 { error: "email_not_configured" }', () => {
  const EMAIL_TRANSPORT_PATH = path.join(ROOT, 'server/lib/emailTransport.js');

  it('existe isEmailConfigured() en server/lib/emailTransport.js', async () => {
    expect(fs.existsSync(EMAIL_TRANSPORT_PATH)).toBe(true);
    const mod = await import('../lib/emailTransport.js');
    expect(
      typeof mod.isEmailConfigured,
      'falta export isEmailConfigured() en server/lib/emailTransport.js — hoy el transporte SIEMPRE cae a Postfix en localhost:25, sin forma de detectar "no configurado"',
    ).toBe('function');
  });

  it('isEmailConfigured() es false sin RESEND_API_KEY ni EMAIL_HOST/EMAIL_USER', async () => {
    const savedResend = process.env.RESEND_API_KEY;
    const savedHost = process.env.EMAIL_HOST;
    const savedUser = process.env.EMAIL_USER;
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_HOST;
    delete process.env.EMAIL_USER;
    try {
      const mod = await import('../lib/emailTransport.js');
      if (typeof mod.isEmailConfigured !== 'function') {
        expect(false, 'falta isEmailConfigured()').toBe(true);
        return;
      }
      expect(mod.isEmailConfigured()).toBe(false);
    } finally {
      if (savedResend) process.env.RESEND_API_KEY = savedResend;
      if (savedHost) process.env.EMAIL_HOST = savedHost;
      if (savedUser) process.env.EMAIL_USER = savedUser;
    }
  });

  it('POST /api/contact responde 503 email_not_configured cuando no hay transporte (hoy: intenta enviar y responde 500 si falla)', async () => {
    vi.resetModules();
    vi.doMock('../lib/emailTransport.js', () => ({
      sendEmail: vi.fn(async () => ({ ok: false, error: 'should not be called' })),
      isEmailConfigured: () => false,
    }));
    const { contactForm } = await import('../routes/contactForm.js');
    const res = fakeRes();
    await contactForm({ body: { name: 'Ana', email: 'ana@example.com', message: 'hola' } }, res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'email_not_configured' });
    vi.doUnmock('../lib/emailTransport.js');
    vi.resetModules();
  });
});

describe('EODHD sin key — contrato 503 { error: "eodhd_not_configured" } (hoy: 403 "API key not configured...")', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.EODHD_PLATFORM_KEY;
  });
  afterEach(() => {
    vi.doUnmock('../lib/requireUser.js');
    vi.doUnmock('../lib/adminSupabase.js');
    vi.resetModules();
  });

  it('GET /api/eodhd-secure/* responde 503 eodhd_not_configured, no 403', async () => {
    vi.doMock('../lib/requireUser.js', () => ({
      requireUser: vi.fn(async () => ({ id: 'user-1' })),
    }));
    vi.doMock('../lib/adminSupabase.js', () => ({ supabaseAdmin: null }));

    const { eodhdSecure } = await import('../routes/marketProxy.js');
    const res = fakeRes();
    await eodhdSecure({ headers: { authorization: 'Bearer token' }, originalUrl: '/api/eodhd-secure/eod/AAPL.US' }, res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'eodhd_not_configured' });
  });
});

describe('Yahoo caído — la función de precios del server no devuelve 0, sino ausencia/null', () => {
  const savedFetch = global.fetch;

  beforeEach(() => {
    vi.resetModules();
    // getYahooQuotes prueba, en orden: (1) fetchV7Quotes (crumb dance, va por
    // `https` crudo en lib/yahooCrumb.js — NO por fetch), (2) un v7 sin crumb
    // y (3) v8 uno a uno, estos dos últimos vía `fetch` global. Para simular
    // "Yahoo caído del todo" hay que cortar las dos vías, si no el test hace
    // una petición de red real (este sandbox SÍ tiene salida a internet).
    vi.doMock('../lib/yahooCrumb.js', () => ({
      fetchV7Quotes: vi.fn(async () => { throw new Error('crumb down (test)'); }),
    }));
    global.fetch = vi.fn(async () => { throw new Error('network down (test)'); });
  });
  afterEach(() => {
    global.fetch = savedFetch;
    vi.doUnmock('../lib/yahooCrumb.js');
    vi.resetModules();
  });

  it('getYahooQuotes con todas las vías caídas: el ticker queda AUSENTE del Map (no current: 0)', async () => {
    const { getYahooQuotes } = await import('../lib/marketQuotes.js');
    const map = await getYahooQuotes(['AAPL', 'MSFT']);
    expect(map.has('AAPL')).toBe(false);
    expect(map.has('MSFT')).toBe(false);
    expect(map.size).toBe(0);
  });
});
