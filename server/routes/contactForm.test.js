import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendEmail = vi.fn(async () => ({ ok: true, attempts: 1 }));
vi.mock('../lib/emailTransport.js', () => ({ sendEmail }));
vi.mock('../lib/emailConfig.js', () => ({ isEmailConfigured: vi.fn(() => true) }));
vi.mock('../lib/logBuffer.js', () => ({ addLog: vi.fn() }));

const { sanitizeContact, buildContactEmail, contactForm, MAX_NAME_CHARS, MAX_MESSAGE_CHARS } = await import('./contactForm.js');

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

const PHISH = '<a href="https://evil.example">Verifica tu cuenta</a>';
const PHISH_NAME = '<a href="https://evil.example">Verifica tu cuenta</a>';

describe('sanitizeContact', () => {
  it('acepta un formulario normal y recorta espacios', () => {
    expect(sanitizeContact({ name: '  Ana  ', email: ' ana@example.com ', message: ' hola ' }))
      .toEqual({ ok: true, name: 'Ana', email: 'ana@example.com', message: 'hola' });
  });

  it('rechaza emails con comillas, < >, espacios o saltos de línea (cabecera Reply-To)', () => {
    for (const email of ['"x"@example.com', 'a<b@example.com', 'a@example.com>', 'a b@example.com', 'a@example.com\r\nBcc: v@example.com', 'a@x', 'a@' + '-x.com']) {
      expect(sanitizeContact({ name: 'A', email, message: 'm' })).toEqual({ ok: false, error: 'Invalid email address' });
    }
  });

  it('quita CR/LF y demás controles del nombre (va al Asunto) y lo acota', () => {
    const out = sanitizeContact({ name: 'Ana\r\nBcc: victim@example.com\u0000', email: 'a@example.com', message: 'm' });
    expect(out.name).toBe('Ana Bcc: victim@example.com');
    expect(out.name).not.toMatch(/[\r\n]/);
    expect(sanitizeContact({ name: 'x'.repeat(500), email: 'a@example.com', message: 'm' }).name).toHaveLength(MAX_NAME_CHARS);
    expect(sanitizeContact({ name: 'a', email: 'a@example.com', message: 'm'.repeat(9000) }).message).toHaveLength(MAX_MESSAGE_CHARS);
  });

  it('campos que faltan, vacíos o que no son texto → 400', () => {
    expect(sanitizeContact({}).ok).toBe(false);
    expect(sanitizeContact({ name: '\r\n', email: 'a@example.com', message: 'm' }).ok).toBe(false);
    expect(sanitizeContact({ name: ['a'], email: 'a@example.com', message: 'm' }).ok).toBe(false);
    expect(sanitizeContact({ name: 'a', email: { $ne: 1 }, message: 'm' }).ok).toBe(false);
  });
});

describe('buildContactEmail', () => {
  it('escapa nombre, email y mensaje en el HTML: ningún enlace del visitante llega activo', () => {
    const mail = buildContactEmail({ name: PHISH, email: "o'hara&co@example.com", message: `${PHISH}\n"quotes" & <script>` });
    expect(mail.html).not.toContain('<a href="https://evil.example">');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;a href=&quot;https://evil.example&quot;&gt;Verifica tu cuenta&lt;/a&gt;');
    expect(mail.html).toContain('mailto:o&#39;hara&amp;co@example.com');
    expect(mail.html).toContain('&quot;quotes&quot; &amp; &lt;script&gt;');
    // el único <a> es el mailto propio
    expect(mail.html.match(/<a /g)).toHaveLength(1);
  });

  it('Reply-To como objeto (nodemailer codifica el nombre), nunca una cadena armada a mano', () => {
    const mail = buildContactEmail({ name: 'Ana "x" <evil@example.com>', email: 'ana@example.com', message: 'm' });
    expect(mail.replyTo).toEqual({ name: 'Ana "x" <evil@example.com>', address: 'ana@example.com' });
  });
});

describe('POST /api/contact', () => {
  beforeEach(() => sendEmail.mockClear());

  it('con un nombre con CRLF y HTML: Asunto en una línea y cuerpo escapado', async () => {
    const res = fakeRes();
    await contactForm({ body: { name: `Ana\r\nBcc: v@example.com ${PHISH}`, email: 'ana@example.com', message: 'hola' } }, res);
    expect(res.statusCode).toBe(200);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.subject.startsWith('[Trazza Contact] Message from Ana Bcc: v@example.com')).toBe(true);
    expect(mail.replyTo.address).toBe('ana@example.com');
    expect(mail.html).not.toContain('<a href="https://evil.example">');
  });

  it('email con comillas → 400 y no se envía nada', async () => {
    const res = fakeRes();
    await contactForm({ body: { name: 'A', email: '"a"@example.com', message: 'm' } }, res);
    expect(res.statusCode).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('contactForm', () => {
  beforeEach(() => {
    sendEmail.mockClear();
    sendEmail.mockResolvedValue({ ok: true, attempts: 1 });
  });

  it('escapa name y email en el HTML', async () => {
    const res = fakeRes();
    await contactForm({
      body: {
        name: PHISH_NAME,
        email: 'ana@example.com',
        message: 'hola',
      },
    }, res);

    expect(res.statusCode).toBe(200);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.html).not.toContain('<a href="https://evil');
    expect(mail.html).toContain('&lt;a');
  });

  it('escapa comillas y & en message', async () => {
    const res = fakeRes();
    await contactForm({
      body: {
        name: 'Ana',
        email: 'ana@example.com',
        message: 'dijo "hola" & chao',
      },
    }, res);

    expect(res.statusCode).toBe(200);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.html).toContain('&quot;');
    expect(mail.html).toContain('&amp;');
    expect(mail.html).not.toMatch(/>dijo "hola" & chao</);
  });

  it('replyTo es objeto {name,address}', async () => {
    const res = fakeRes();
    await contactForm({
      body: {
        name: 'Ana Pérez',
        email: 'ana@example.com',
        message: 'hola',
      },
    }, res);

    expect(res.statusCode).toBe(200);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.replyTo).toEqual({ name: 'Ana Pérez', address: 'ana@example.com' });
  });

  it('subject sin saltos de línea', async () => {
    const res = fakeRes();
    await contactForm({
      body: {
        name: 'Ana\r\nBcc: victim@example.com',
        email: 'ana@example.com',
        message: 'hola',
      },
    }, res);

    expect(res.statusCode).toBe(200);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });

  it('rechaza email con comillas o <', async () => {
    for (const email of ['"x"@example.com', 'a<b@example.com']) {
      sendEmail.mockClear();
      const res = fakeRes();
      await contactForm({
        body: { name: 'Ana', email, message: 'hola' },
      }, res);
      expect(res.statusCode, email).toBe(400);
      expect(sendEmail, email).not.toHaveBeenCalled();
    }
  });

  it('name no string (p. ej. 5) → 400 sin llamar a sendEmail', async () => {
    const res = fakeRes();
    await contactForm({
      body: { name: 5, email: 'ana@example.com', message: 'hola' },
    }, res);
    expect(res.statusCode).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('rechaza email con , o ; en la parte local', async () => {
    for (const email of ['a,b@example.com', 'a;b@example.com']) {
      sendEmail.mockClear();
      const res = fakeRes();
      await contactForm({ body: { name: 'Ana', email, message: 'hola' } }, res);
      expect(res.statusCode, email).toBe(400);
      expect(sendEmail, email).not.toHaveBeenCalled();
    }
  });

  it('rechaza email con , o ; en el dominio (a@example.com,y.com)', async () => {
    for (const email of ['a@example.com,y.com', 'a@example.com;y.com']) {
      sendEmail.mockClear();
      const res = fakeRes();
      await contactForm({ body: { name: 'Ana', email, message: 'hola' } }, res);
      expect(res.statusCode, email).toBe(400);
      expect(sendEmail, email).not.toHaveBeenCalled();
    }
  });

  it('replyTo.name queda en una sola línea (sin CR/LF)', async () => {
    const res = fakeRes();
    await contactForm({
      body: {
        name: 'Ana "Boss" <admin>\r\nBcc: x@example.com',
        email: 'ana@example.com',
        message: 'hola',
      },
    }, res);
    expect(res.statusCode).toBe(200);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.replyTo.name).not.toMatch(/[\r\n]/);
    expect(mail.replyTo.name).toBe('Ana "Boss" <admin> Bcc: x@example.com');
  });
});

describe('contactForm + asyncHandler (servidor vivo tras name:5)', () => {
  it('POST {"name":5} da 400 y /health sigue respondiendo', async () => {
    const express = (await import('express')).default;
    const request = (await import('supertest')).default;
    const { asyncHandler } = await import('../lib/asyncHandler.js');

    const app = express();
    app.use(express.json());
    app.post('/api/contact', asyncHandler(contactForm));
    app.get('/health', (_req, res) => res.json({ status: 'ok' }));
    app.use((err, _req, res, _next) => {
      res.status(err.status || 500).json({ error: 'Internal server error' });
    });

    const bad = await request(app).post('/api/contact').send({ name: 5, email: 'a@example.com', message: 'x' });
    expect(bad.status).toBe(400);

    const health = await request(app).get('/health');
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: 'ok' });
  });
});
