/**
 * Importes con SU divisa en los avisos del server (notificaciones y correos).
 *
 * Los mensajes ponían "$" fijo: "$1.4130/acción" para un dividendo de
 * Constellation Software (CAD) u "objetivo de $50" para una acción europea.
 * Formato español: separador decimal coma, € detrás ("1,41 €") y el resto de
 * símbolos delante ("C$1,41", "$0,25"). Divisa desconocida → código ISO.
 */
const PREFIX = { USD: '$', CAD: 'C$', AUD: 'A$', GBP: '£', JPY: '¥', HKD: 'HK$' };

/**
 * @param {number} amount
 * @param {string|null|undefined} currency  ISO 4217 (USD, EUR, CAD…)
 * @param {{decimals?: number, minDecimals?: number, lang?: 'es'|'en'}} [opts]
 *   decimals = máximo; minDecimals = mínimo (por defecto igual al máximo).
 *   lang 'en' → formato inglés ("€1,234.50", "$0.25"); por defecto español.
 */
export function formatMoney(amount, currency, { decimals = 2, minDecimals = decimals, lang = 'es' } = {}) {
  if (!Number.isFinite(Number(amount))) return '';
  const en = lang === 'en';
  const n = new Intl.NumberFormat(en ? 'en-GB' : 'es-ES', {
    minimumFractionDigits: minDecimals, maximumFractionDigits: decimals, useGrouping: 'always',
  }).format(Number(amount));
  const cur = String(currency || '').toUpperCase();
  if (cur === 'EUR') return en ? `€${n}` : `${n} €`;
  if (PREFIX[cur]) return `${PREFIX[cur]}${n}`;
  return cur ? `${n} ${cur}` : n;
}
