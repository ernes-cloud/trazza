import { describe, it, expect } from 'vitest';
import nodemailer from 'nodemailer';
import { sanitizeContact, buildContactEmail } from './contactForm.js';

async function renderRawContactMessage(payload) {
  const form = sanitizeContact(payload);
  expect(form.ok).toBe(true);

  const transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
  });

  const info = await transport.sendMail({
    from: '"Trazza Contact" <hola@example.com>',
    to: 'hola@example.com',
    ...buildContactEmail(form),
  });
  return info.message.toString('utf8');
}

function oneHeader(raw, name) {
  const re = new RegExp(`^${name}:.*$`, 'gim');
  const matches = raw.match(re) || [];
  expect(matches.length).toBe(1);
  expect(matches[0]).not.toMatch(/[\r\n]/);
  return matches[0];
}

describe('contactForm raw headers (m-6)', () => {
  it('CRLF/Bcc payload does not inject Bcc and keeps Subject/Reply-To single-line', async () => {
    const raw = await renderRawContactMessage({
      name: 'Ana\r\nBcc: victim@example.com',
      email: 'ana@example.com',
      message: 'hola',
    });

    const subject = oneHeader(raw, 'Subject');
    const replyTo = oneHeader(raw, 'Reply-To');
    expect(raw).not.toMatch(/\r?\nBcc:/i);
    expect(subject).toContain('[Trazza Contact] Message from Ana Bcc: victim@example.com');
    expect(replyTo).toContain('<ana@example.com>');
  });

  it('quotes payload keeps display name safely quoted/encoded in Reply-To', async () => {
    const raw = await renderRawContactMessage({
      name: 'Ana "Boss" <admin@example.com>',
      email: 'ana@example.com',
      message: 'hola',
    });

    const replyTo = oneHeader(raw, 'Reply-To');
    expect(replyTo).toContain('<ana@example.com>');
    expect(replyTo).not.toMatch(/\r?\n/);
    expect(
      replyTo.includes('"Ana \\"Boss\\" <admin@example.com>"')
      || replyTo.includes('=?UTF-8?'),
    ).toBe(true);
  });
});
