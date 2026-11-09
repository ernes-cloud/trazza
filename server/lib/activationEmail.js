/**
 * Correo de activación — PURO (sin I/O), testeado.
 *
 * Por qué (2026-10-04): de 14 cuentas solo 2 estaban activas, y la mayoría de
 * las demás se registró y nunca metió una operación. Sin cartera, Trazza no
 * enseña nada. Un único correo, un día después del alta, con los pasos para
 * exportar el fichero de su broker y un botón al importador.
 *
 * Reglas:
 *  - UNO por cuenta, nunca más (marca en app_metadata, ver el job).
 *  - Solo a cuentas creadas hace 24–72 h: las anteriores a esta función no lo
 *    reciben de golpe, y si el server estuvo parado no se manda tarde.
 *  - Solo con el email CONFIRMADO, sin ninguna operación ni posición abierta,
 *    con el correo permitido en Ajustes y fuera de las cuentas internas.
 */

import { escapeHtml } from './escapeHtml.js';
import { wantsEmail } from './emailPrefs.js';
import { getAppUrl } from './appUrl.js';

function isInternalUser(row, excludeIds = []) {
  return excludeIds.includes(row.user_id);
}
export const MIN_AGE_HOURS = 24;
export const MAX_AGE_HOURS = 72;
const HOUR_MS = 60 * 60 * 1000;
const MAX_GUIDES = 3;

// Pasos de exportación: los MISMOS textos que enseña el importador
// (cartera.csv_*_pre / csv_*_action en es.json y en.json). Si cambian allí,
// cambian aquí.
const GUIDES = {
  degiro: {
    name: 'DeGiro',
    es: 'Actividad → Estado de cuenta → Seleccionar rango de fechas → Descargar CSV',
    en: 'Activity → Account statement → Select date range → Download CSV',
  },
  ibkr: {
    name: 'Interactive Brokers',
    es: 'Rendimiento e informes → Historial de transacciones → Período completo → Exportar CSV',
    en: 'Performance & Reports → Transaction history → Full period → Export CSV',
  },
  trading212: {
    name: 'Trading 212',
    es: 'Menú → Historial → Exportar → CSV (marca todas las categorías)',
    en: 'Menu → History → Export → CSV (tick every category)',
  },
  myinvestor: {
    name: 'MyInvestor',
    es: 'Cartera automatizada → Detalle de cuenta gestionada → Resumen de movimientos → EXCEL',
    en: 'Managed portfolio → Account detail → Movements summary → EXCEL',
  },
  binance: {
    name: 'Binance',
    es: 'Órdenes → Historial de operaciones → Exportar → CSV',
    en: 'Orders → Order history → Export → CSV',
  },
};
const DEFAULT_GUIDES = ['degiro', 'ibkr', 'trading212'];

const NAME_PATTERNS = [
  ['degiro', /degiro/i],
  ['ibkr', /ibkr|interactive/i],
  ['trading212', /trading\s*212|t212/i],
  ['myinvestor', /my\s*investor/i],
  ['binance', /binance/i],
];

/** Guías a enseñar según los brokers que la persona ya creó (si creó alguno). */
export function pickGuides(brokerNames = []) {
  const found = [];
  for (const name of brokerNames) {
    for (const [key, re] of NAME_PATTERNS) {
      if (re.test(String(name || '')) && !found.includes(key)) found.push(key);
    }
  }
  return (found.length ? found : DEFAULT_GUIDES).slice(0, MAX_GUIDES);
}

/** 'es' | 'en': idioma guardado en Ajustes, si no el del registro, si no español. */
export function emailLanguage(prefs, signupSource) {
  if (prefs?.language === 'en' || prefs?.language === 'es') return prefs.language;
  const l = String(signupSource?.lang || '').toLowerCase();
  if (l && !l.startsWith('es')) return 'en';
  return 'es';
}

/**
 * @param {{ authUsers: Array, funnelRows: Array, prefsByUser?: Map, now?: Date, excludeIds?: string[], alreadySent?: Set<string> }} p
 * @returns {Array<{ userId: string, email: string, lang: 'es'|'en' }>}
 */
export function selectActivationCandidates({ authUsers, funnelRows, prefsByUser = new Map(), now = new Date(), excludeIds = [], alreadySent = new Set() }) {
  const funnelById = new Map((funnelRows || []).map((r) => [r.user_id, r]));
  const out = [];
  for (const u of authUsers || []) {
    const ageH = (now.getTime() - new Date(u.created_at).getTime()) / HOUR_MS;
    if (!(ageH >= MIN_AGE_HOURS && ageH <= MAX_AGE_HOURS)) continue;
    if (!u.email || !u.email_confirmed_at) continue;
    if (u.app_metadata?.activation_email_at || alreadySent.has(u.id)) continue;
    const row = funnelById.get(u.id);
    if (!row) continue; // sin datos de cartera no se puede saber si ya importó: no se arriesga
    if (isInternalUser(row, excludeIds)) continue;
    if ((row.transactions || 0) > 0 || (row.open_positions || 0) > 0) continue;
    if (row.beta_status === 'rejected') continue;
    const prefs = prefsByUser.get(u.id) || null;
    if (!wantsEmail(prefs, null)) continue;
    out.push({ userId: u.id, email: u.email, lang: emailLanguage(prefs, u.user_metadata?.signup_source) });
  }
  return out;
}

const COPY = {
  es: {
    subject: 'Te falta un paso para ver tu cartera en Trazza',
    eyebrow: 'Primeros pasos',
    title: 'Mete tu cartera en cinco minutos',
    intro: 'Te registraste en Trazza, pero aún no has añadido ninguna operación. Con el fichero que exporta tu broker, Trazza reconstruye tus posiciones, tu rentabilidad real, los dividendos y las comisiones.',
    howTo: 'Cómo exportar el fichero',
    other: '¿Otro broker, un PDF o una captura? La importación con IA los lee también.',
    cta: 'Importar mi cartera',
    help: 'Si algo no funciona, responde a este correo y te ayudamos.',
    manage: 'Gestionar los correos de Trazza',
  },
  en: {
    subject: 'One step left to see your portfolio in Trazza',
    eyebrow: 'Getting started',
    title: 'Bring your portfolio in five minutes',
    intro: 'You signed up for Trazza but have not added any transactions yet. With the file your broker exports, Trazza rebuilds your positions, your real return, dividends and fees.',
    howTo: 'How to export the file',
    other: 'Another broker, a PDF or a screenshot? The AI import reads those too.',
    cta: 'Import my portfolio',
    help: 'If something does not work, just reply to this email and we will help.',
    manage: 'Manage Trazza emails',
  },
};

/**
 * @param {{ lang?: 'es'|'en', guides?: string[] }} p
 * @returns {{ subject: string, html: string, text: string }}
 */
export function buildActivationEmail({ lang = 'es', guides = DEFAULT_GUIDES } = {}) {
  const site = getAppUrl();
  const c = COPY[lang] || COPY.es;
  const steps = guides.filter((g) => GUIDES[g]).map((g) => ({ name: GUIDES[g].name, path: GUIDES[g][lang] || GUIDES[g].es }));
  const url = `${site}/app/brokers`;

  const text = [
    c.title,
    c.intro,
    `${c.howTo}:`,
    ...steps.map((s) => `- ${s.name}: ${s.path}`),
    c.other,
    `${c.cta}: ${url}`,
    c.help,
  ].join('\n\n');

  const stepsHtml = steps.map((s) => `
            <tr><td style="padding:8px 0;border-top:1px solid #f1f5f9;">
              <p style="margin:0;font-size:14px;font-weight:700;color:#0f172a;">${escapeHtml(s.name)}</p>
              <p style="margin:2px 0 0;font-size:13px;line-height:1.5;color:#475569;">${escapeHtml(s.path)}</p>
            </td></tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(c.title)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(c.intro)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0;">
        <tr><td style="padding:22px 28px 0;">
          <p style="margin:0;font-size:15px;font-weight:800;color:#0f172a;letter-spacing:-0.2px;">Trazza</p>
        </td></tr>
        <tr><td style="padding:20px 28px 28px;">
          <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#2563eb;">${escapeHtml(c.eyebrow)}</p>
          <h1 style="margin:0;font-size:20px;line-height:1.3;font-weight:800;color:#0f172a;">${escapeHtml(c.title)}</h1>
          <p style="margin:12px 0 0;font-size:15px;line-height:1.55;color:#475569;">${escapeHtml(c.intro)}</p>
          <p style="margin:20px 0 4px;font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#64748b;">${escapeHtml(c.howTo)}</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${stepsHtml}
          </table>
          <p style="margin:12px 0 0;font-size:13px;line-height:1.5;color:#64748b;">${escapeHtml(c.other)}</p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px;">
            <tr><td style="border-radius:8px;background:#2563eb;">
              <a href="${url}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(c.cta)} &rarr;</a>
            </td></tr>
          </table>
          <p style="margin:18px 0 0;font-size:13px;line-height:1.5;color:#64748b;">${escapeHtml(c.help)}</p>
        </td></tr>
        <tr><td style="padding:14px 28px 18px;border-top:1px solid #f1f5f9;">
          <p style="margin:0;font-size:12px;color:#94a3b8;">
            <a href="${site}/app/settings" style="color:#64748b;text-decoration:underline;">${escapeHtml(c.manage)}</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject: c.subject, html, text };
}
