/**
 * Transporte de correo de la plataforma.
 *
 * ── Por qué se cambió de Postfix a un proveedor ────────────────────────────
 * Hasta el 2026-09-27 todo salía por un Postfix en localhost del propio VPS.
 * SPF y DKIM estaban bien puestos, pero el problema no era la configuración:
 * con 3,1 correos al día (medido: 93 en 30 días, 14 usuarios) una IP de VPS
 * NUNCA acumula reputación suficiente para que Gmail y Outlook la traten como
 * un remitente conocido. Y el volumen es tan bajo que un rebote no se nota:
 * no había forma de saber si un aviso había llegado.
 *
 * Resend entrega desde IPs compartidas con reputación ya construida, informa
 * de rebotes y quejas, y su región de Irlanda (`eu-west-1`) mantiene los datos
 * dentro del EEE — que es la condición para no tocar la promesa de la landing.
 *
 * ── Fallback deliberado ────────────────────────────────────────────────────
 * Sin `RESEND_API_KEY` se cae al Postfix de siempre. Así el dev local sigue
 * funcionando sin credenciales y un despliegue a medio configurar manda por
 * donde mandaba, en vez de quedarse mudo.
 */
import nodemailer from 'nodemailer';
import { addLog } from './logBuffer.js';
import {
  classifyEmailError,
  nextBackoffMs,
  summarizeEmailError,
  MAX_ATTEMPTS,
} from './emailDelivery.js';
import { checkDailyQuota, DAILY_NOTIFICATION_EMAIL_LIMIT } from './emailQuota.js';
import { claimReportSend, countReportSendsForDayPrefix } from './reportSends.js';
import { getEmailFrom } from './appContact.js';

const RESEND_KEY = process.env.RESEND_API_KEY;

export { isEmailConfigured } from './emailConfig.js';

/** 'resend' | 'smtp'. */
export const EMAIL_PROVIDER = RESEND_KEY ? 'resend' : 'smtp';

function madridDayKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function buildTransport() {
  if (RESEND_KEY) {
    return nodemailer.createTransport({
      host: process.env.RESEND_SMTP_HOST || 'smtp.resend.com',
      // 587 con STARTTLS. El 465 (TLS implícito) también vale, pero 587
      // atraviesa más redes y algunos VPS tienen el 465 capado de salida.
      port: parseInt(process.env.RESEND_SMTP_PORT || '587', 10),
      secure: false,
      requireTLS: true,       // ⚠️ obligatorio: aquí viaja la API key
      auth: { user: 'resend', pass: RESEND_KEY },
    });
  }

  // Postfix local: sin TLS porque es loopback y sin auth porque no la pide.
  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'localhost',
    port: parseInt(process.env.EMAIL_PORT || '25', 10),
    secure: false,
    ignoreTLS: true,
    ...(process.env.EMAIL_USER ? { auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } } : {}),
  });
}

const transporter = buildTransport();

export const EMAIL_FROM = getEmailFrom();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Cuenta los correos de notificación YA ENVIADOS hoy a este usuario.
 *
 * Cuenta solo `status = 'sent'`: un intento que falló no llegó al buzón de
 * nadie, así que no debe gastar cupo — si no, una racha de fallos de red
 * dejaría al usuario sin avisos el resto del día por partida doble. Los
 * 'capped' tampoco cuentan, o el bloqueo se realimentaría a sí mismo.
 *
 * Devuelve `null` si no se puede contar (sin cliente, o la consulta falla);
 * `checkDailyQuota` interpreta eso como "deja pasar".
 */
async function countNotificationEmailsToday(userId) {
  if (!userId) return null;
  const dayKey = madridDayKey();
  return countReportSendsForDayPrefix({ userId, kind: 'notification', dayPrefix: dayKey });
}

/**
 * Envía un correo con reintentos y deja constancia del resultado.
 *
 * Sustituye a los `transporter.sendMail()` sueltos, que no reintentaban y
 * cuyo único rastro era un log en memoria. Las decisiones de reintento viven
 * en `emailDelivery.js` (puro, 14 tests): un 4xx o un fallo de red se
 * reintenta, un 5xx o una credencial mala no.
 *
 * NO lanza por defecto: devuelve `{ ok }` para que el llamante decida. El
 * webhook de Supabase necesita responder 200 pase lo que pase, pero ahora el
 * fallo queda escrito en la tabla en vez de desaparecer.
 *
 * @param {object} p
 * @param {'notification'|'contact'|'beta_approved'|'test'|'weekly_report'|'activation'} p.kind
 * @param {string} p.to
 * @param {string} p.subject
 * @param {string} [p.html]
 * @param {string} [p.text]
 * @param {string} [p.from]
 * @param {string | { name: string, address: string }} [p.replyTo]  objeto si lleva texto del usuario (nodemailer codifica el nombre)
 * @param {string} [p.userId]  obligatorio en 'notification': es lo que aplica el tope diario
 * @param {string} [p.reportPeriodKey]  idempotencia en report_sends (p. ej. id de notificación)
 * @returns {Promise<{ ok: boolean, capped?: boolean, duplicate?: boolean, messageId?: string, error?: string, attempts: number }>}
 *   `capped: true` NO es un error — es el tope diario. El llamante no debe
 *   tratarlo como una avería ni alertar por ello.
 */
export async function sendEmail({
  kind, to, subject, html, text, from, replyTo, userId, reportPeriodKey,
}) {
  const dayKey = madridDayKey();

  // TOPE DIARIO. Solo para notificaciones: el formulario de contacto no va a
  // un usuario, y la aprobación de beta ocurre una vez en la vida de cada
  // cuenta — toparlas sería bloquear correos que nunca pueden inundar.
  if (kind === 'notification' && userId) {
    const sentToday = await countNotificationEmailsToday(userId);
    const { allowed, remaining } = checkDailyQuota(sentToday);
    if (!allowed) {
      addLog('warn', 'email', `Tope diario alcanzado (${DAILY_NOTIFICATION_EMAIL_LIMIT}/día): no se envía`, { userId, to });
      return { ok: false, capped: true, remaining, attempts: 0 };
    }

    if (reportPeriodKey) {
      const periodKey = `${dayKey}:${reportPeriodKey}`;
      const claim = await claimReportSend({ userId, kind: 'notification', periodKey });
      if (claim && !claim.claimed) {
        return { ok: true, duplicate: true, attempts: 0 };
      }
    }
  }

  const mail = {
    from: from || EMAIL_FROM,
    to,
    subject,
    ...(html ? { html } : {}),
    ...(text ? { text } : {}),
    ...(replyTo ? { replyTo } : {}),
  };

  let attempts = 0;
  let lastError = null;

  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    try {
      const info = await transporter.sendMail(mail);
      return { ok: true, messageId: info?.messageId, attempts };
    } catch (err) {
      lastError = err;
      const { retryable, reason } = classifyEmailError(err);
      if (!retryable || attempts >= MAX_ATTEMPTS) {
        addLog('error', 'email', `Envío fallido (${reason}) tras ${attempts} intento(s)`, { kind, to });
        break;
      }
      addLog('warn', 'email', `Reintentando envío (${reason}), intento ${attempts}`, { kind, to });
      await sleep(nextBackoffMs(attempts));
    }
  }

  const summary = summarizeEmailError(lastError);
  return { ok: false, error: summary, attempts };
}

// Se sigue exportando el transporter crudo porque `adminHealth` llama a
// `.verify()` para el panel de salud. Para ENVIAR, usa `sendEmail`.
export { transporter };
