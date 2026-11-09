/**
 * Correo de una notificación — PURO (sin I/O), testeado.
 *
 * Lo usa el webhook `routes/emailNotify.js` para TODA fila de `notifications`
 * (avisos del cron, alertas, artículos del blog). Antes la plantilla era un
 * bloque genérico sin botón: el enlace de la notificación (`link`) no se usaba,
 * así que un artículo nuevo del blog llegaba como un párrafo largo sin forma de
 * abrirlo, y con dos emojis en el asunto ("🔔 📰 Título").
 *
 * Reglas:
 *  - Corto: título + resumen recortado a ~2 líneas + UN botón.
 *  - El botón solo puede llevar al host público (APP_URL). `link` sale de nuestra BD,
 *    pero una ruta mal formada ("//otro.dominio", "javascript:") no puede
 *    convertirse en un enlace a otro sitio desde un correo nuestro.
 *  - Texto del usuario SIEMPRE escapado (títulos de broker, notas…).
 */

import { escapeHtml } from './escapeHtml.js';

import { getAppUrl } from './appUrl.js';
const FALLBACK_PATH = '/app/notificaciones';
const EXCERPT_MAX = 180;

const ICONS = {
  success: '✅',
  error: '❌',
  warning: '⚠️',
  dividend: '💰',
  earnings: '📊',
  alert: '🔔',
  blog: '📰',
};

// Etiqueta corta sobre el título y texto del botón, por tipo e idioma. El
// idioma es el del usuario (user_preferences.language); los avisos del cron ya
// llegan escritos en ese idioma.
const KIND = {
  es: {
    blog: { eyebrow: 'Nuevo en el blog', cta: 'Leer el artículo' },
    dividend: { eyebrow: 'Dividendos', cta: 'Ver en Trazza' },
    earnings: { eyebrow: 'Resultados', cta: 'Ver en Trazza' },
    alert: { eyebrow: 'Alerta', cta: 'Ver en Trazza' },
    default: { eyebrow: 'Aviso', cta: 'Abrir Trazza' },
  },
  en: {
    blog: { eyebrow: 'New on the blog', cta: 'Read the article' },
    dividend: { eyebrow: 'Dividends', cta: 'View in Trazza' },
    earnings: { eyebrow: 'Earnings', cta: 'View in Trazza' },
    alert: { eyebrow: 'Alert', cta: 'View in Trazza' },
    default: { eyebrow: 'Notice', cta: 'Open Trazza' },
  },
};
const FOOTER = { es: 'Gestionar avisos por correo', en: 'Manage email notifications' };
const FALLBACK_TITLE = { es: 'Novedad en Trazza', en: 'News from Trazza' };

// Emoji (o secuencia de emojis) al principio de un texto.
const LEADING_EMOJI = /^(?:\p{Extended_Pictographic}|️|‍|\s)+/u;

/** Quita los emojis iniciales: el título del blog ya trae "📰 " y el asunto añade el suyo. */
export function stripLeadingEmoji(text) {
  return String(text || '').replace(LEADING_EMOJI, '').trim();
}

/** Recorta en un límite de palabra y añade "…". */
export function shorten(text, max = EXCERPT_MAX) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,.;:–—-]+$/, '')}…`;
}

/**
 * URL absoluta y SEGURA del botón: solo rutas internas ("/blog/x") o URLs de
 * el sitio público (SITE / APP_URL). Todo lo demás cae a la bandeja de notificaciones de la app.
 */
export function safeLink(link) {
  const site = getAppUrl();
  const l = String(link || '').trim();
  if (l.startsWith('/') && !l.startsWith('//') && !/[\s\\]/.test(l)) return `${site}${l}`;
  if (l === site || l.startsWith(`${site}/`)) return l;
  return `${site}${FALLBACK_PATH}`;
}

/**
 * @param {{ title?: string, message?: string, type?: string, link?: string, lang?: string }} n
 * @returns {{ subject: string, html: string, text: string }}
 */
export function buildNotificationEmail({ title, message, type, link, lang } = {}) {
  const site = getAppUrl();
  const l = lang === 'en' ? 'en' : 'es';
  const kind = KIND[l][type] || KIND[l].default;
  const icon = ICONS[type] || ICONS.alert;
  const cleanTitle = stripLeadingEmoji(title) || FALLBACK_TITLE[l];
  const excerpt = shorten(message && message !== title ? message : '');
  const url = safeLink(link);

  const subject = `${icon} ${cleanTitle}`;
  const text = [cleanTitle, excerpt, `${kind.cta}: ${url}`].filter(Boolean).join('\n\n');

  const html = `<!DOCTYPE html>
<html lang="${l}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(cleanTitle)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(excerpt || cleanTitle)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0;">
        <tr><td style="padding:22px 28px 0;">
          <p style="margin:0;font-size:15px;font-weight:800;color:#0f172a;letter-spacing:-0.2px;">Trazza</p>
        </td></tr>
        <tr><td style="padding:20px 28px 28px;">
          <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#2563eb;">${escapeHtml(kind.eyebrow)}</p>
          <h1 style="margin:0;font-size:20px;line-height:1.3;font-weight:800;color:#0f172a;">${escapeHtml(cleanTitle)}</h1>
          ${excerpt ? `<p style="margin:12px 0 0;font-size:15px;line-height:1.55;color:#475569;">${escapeHtml(excerpt)}</p>` : ''}
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px;">
            <tr><td style="border-radius:8px;background:#2563eb;">
              <a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(kind.cta)} &rarr;</a>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:14px 28px 18px;border-top:1px solid #f1f5f9;">
          <p style="margin:0;font-size:12px;color:#94a3b8;">
            <a href="${site}/app/settings" style="color:#64748b;text-decoration:underline;">${FOOTER[l]}</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, html, text };
}
