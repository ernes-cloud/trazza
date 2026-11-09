import { sendEmail } from '../lib/emailTransport.js';
import { isEmailConfigured } from '../lib/emailConfig.js';
import { addLog }      from '../lib/logBuffer.js';
import { escapeHtml }  from '../lib/escapeHtml.js';
import { getContactEmail } from '../lib/appContact.js';
import { getAppHostname } from '../lib/appUrl.js';

const CONTACT_TO = getContactEmail();

export const MAX_NAME_CHARS = 100;
export const MAX_EMAIL_CHARS = 254;
export const MAX_MESSAGE_CHARS = 5000;

// Sin espacios, comillas, < > ni caracteres de control: lo que entra aquí va a
// la cabecera Reply-To y a un href. La forma anterior (`[^\s@]+@…`) aceptaba
// `"` y `<`, con los que se reescribía la dirección de respuesta.
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

// Caracteres de control (CR/LF, C1, bidi aislantes y marcas de dirección) → espacio:
// el nombre acaba en el Asunto y en Reply-To, donde cualquier control abre spoofing.
// eslint-disable-next-line no-control-regex
const oneLine = (v) => v
  .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u061c\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Valida y sanea el formulario. Puro: devuelve los campos listos para el
 * correo o el error que se responde con 400.
 * @returns {{ ok: true, name: string, email: string, message: string } | { ok: false, error: string }}
 */
export function sanitizeContact(body) {
  const { name, email, message } = body || {};
  if (typeof name !== 'string' || typeof email !== 'string' || typeof message !== 'string'
      || !name.trim() || !email.trim() || !message.trim()) {
    return { ok: false, error: 'Missing required fields' };
  }
  const cleanEmail = email.trim();
  if (cleanEmail.length > MAX_EMAIL_CHARS || !EMAIL_RE.test(cleanEmail)) {
    return { ok: false, error: 'Invalid email address' };
  }
  const cleanName = oneLine(name).slice(0, MAX_NAME_CHARS);
  if (!cleanName) return { ok: false, error: 'Missing required fields' };
  return { ok: true, name: cleanName, email: cleanEmail, message: message.trim().slice(0, MAX_MESSAGE_CHARS) };
}

/**
 * Cabeceras y cuerpo del correo al buzón del equipo. TODO lo que escribe el
 * visitante entra escapado en el HTML (auditoría 7f2c915d, A3: un nombre
 * `<a href="https://evil.example">Verifica tu cuenta</a>` llegaba como enlace
 * activo en un correo "de Trazza"). El Reply-To va como objeto y nodemailer
 * codifica el nombre: nunca se arma la cabecera concatenando texto.
 */
export function buildContactEmail({ name, email, message }) {
  const n = escapeHtml(name);
  const e = escapeHtml(email);
  return {
    replyTo: { name, address: email },
    subject: `[Trazza Contact] Message from ${name}`,
    html: `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /></head>
<body style="margin:0;padding:0;background-color:#060b14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#060b14;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background-color:#0d1929;border-radius:20px;border:1px solid rgba(255,255,255,0.08);overflow:hidden;">
          <tr><td style="height:4px;background:linear-gradient(90deg,#2563eb,#4f46e5);"></td></tr>
          <tr>
            <td style="padding:32px 40px 24px;">
              <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
                <tr>
                  <td style="background-color:#2563eb;border-radius:12px;padding:10px 12px;">
                    <span style="font-size:18px;color:#ffffff;font-weight:900;letter-spacing:-0.5px;">T</span>
                  </td>
                  <td style="padding-left:10px;vertical-align:middle;">
                    <span style="font-size:22px;font-weight:900;color:#ffffff;letter-spacing:-0.5px;">Trazza</span>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 6px;font-size:11px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:0.08em;">New contact message</p>
              <h2 style="margin:0 0 24px;font-size:20px;font-weight:800;color:#ffffff;">Message from ${n}</h2>

              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:12px;margin-bottom:20px;">
                <tr>
                  <td style="padding:16px 20px;">
                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
                          <span style="font-size:11px;color:#475569;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;">Name</span><br/>
                          <span style="font-size:14px;color:#e2e8f0;font-weight:600;">${n}</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:10px 0 6px;">
                          <span style="font-size:11px;color:#475569;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;">Email</span><br/>
                          <a href="mailto:${e}" style="font-size:14px;color:#3b82f6;font-weight:600;text-decoration:none;">${e}</a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:12px;">
                <tr>
                  <td style="padding:16px 20px;">
                    <p style="margin:0 0 8px;font-size:11px;color:#475569;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;">Message</p>
                    <p style="margin:0;font-size:14px;color:#cbd5e1;line-height:1.7;white-space:pre-wrap;">${escapeHtml(message)}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:16px 40px 24px;background-color:rgba(255,255,255,0.02);">
              <p style="margin:0;font-size:11px;color:#1e293b;">
                Sent via ${getAppHostname()}/contact · Reply directly to this email to respond to ${n}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
    text: `New contact message from Trazza\n\nName: ${name}\nEmail: ${email}\n\nMessage:\n${message}`,
  };
}

export const contactForm = async (req, res) => {
  const form = sanitizeContact(req.body);
  if (!form.ok) return res.status(400).json({ error: form.error });
  if (!isEmailConfigured()) return res.status(503).json({ error: 'email_not_configured' });
  const { name, email } = form;

  try {
    const result = await sendEmail({
      kind: 'contact',
      from: `"Trazza Contact" <${CONTACT_TO}>`,
      to: CONTACT_TO,
      ...buildContactEmail(form),
    });

    // A diferencia del webhook de notificaciones, aquí hay una persona
    // esperando: si el correo no ha salido tras los reintentos, tiene que
    // enterarse y volver a intentarlo, no creerse que lo hemos recibido.
    if (!result.ok) {
      console.error('[contactForm] Send failed:', result.error);
      addLog('error', 'email', `Contact form failed after ${result.attempts} attempt(s): ${result.error}`, { from: email });
      return res.status(500).json({ error: 'Failed to send email' });
    }

    addLog('ok', 'email', `Contact form sent → ${CONTACT_TO}`, { from: email, name });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[contactForm] Unexpected error:', err.message);
    addLog('error', 'email', `Contact form error: ${err.message}`, { from: email });
    return res.status(500).json({ error: 'Failed to send email' });
  }
};
