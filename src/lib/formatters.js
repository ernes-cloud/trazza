// Shared display formatters (extracted from CarteraPage during the component split).
import i18next from 'i18next';

/**
 * Locale de los NÚMEROS según el idioma de la app: inglés → en-US
 * ("12,345.60"), cualquier otro → es-ES ("12.345,60"). Antes todo iba fijo
 * en es-ES y la app en inglés enseñaba "+110,45%" junto a fechas "Oct 28, 2026".
 * Lee la instancia única de i18next (la que inicializa src/i18n); sin
 * inicializar (tests, server) cae en español.
 * @param {string} [lang]
 * @returns {'en-US'|'es-ES'}
 */
export const appLocale = (lang = i18next.language) => ((lang || '').startsWith('en') ? 'en-US' : 'es-ES');

export const CURRENCY_SYMBOLS = {
  'USD': '$', 'EUR': '€', 'GBP': '£', 'JPY': '¥', 'CNY': '¥', 'CHF': 'Fr', 'CAD': 'C$', 'AUD': 'A$', 'BRL': 'R$', 'MXN': '$', 'ARS': '$', 'NZD': '$', 'HKD': '$', 'SGD': '$', 'INR': '₹', 'RUB': '₽', 'KRW': '₩', 'ZAR': 'R', 'TRY': '₺'
};

export const getCurrencySymbol = (code, fallback = '$') => {
  if (!code) return fallback;
  return CURRENCY_SYMBOLS[code.toUpperCase()] || code;
};

export const formatNumber = (num, minDecimals = 0, maxDecimals = 2) => {
  if (num === null || num === undefined || isNaN(num)) return '-';
  const val = typeof num === 'string' ? parseFloat(num) : num;
  return new Intl.NumberFormat(appLocale(), {
    minimumFractionDigits: minDecimals,
    maximumFractionDigits: maxDecimals,
    useGrouping: true
  }).format(val);
};

/**
 * Porcentaje con el mismo formato que los importes (coma decimal): "+1,23%".
 * `sign` pone el "+" a los positivos; el "-" lo pone siempre el número.
 * Sin dato, "—". Antes cada widget hacía `toFixed(2)` y salía "+1.23%" junto a
 * "1.896 €": dos formatos de número en la misma tarjeta.
 */
export const formatPercent = (num, decimals = 2, { sign = false } = {}) => {
  if (!Number.isFinite(num)) return '—';
  const body = formatNumber(num, decimals, decimals);
  return `${sign && num > 0 ? '+' : ''}${body}%`;
};

/**
 * Importe con su moneda, en el formato del idioma de la app (Intl, siempre con
 * separador de miles): "-13,83 €" / "1.200,56 €" en español, "-€13.83" en
 * inglés. En brokers convivían "€-13,83", "1,50 $" y "+1200,56€" en la misma
 * pantalla. `sign` pone el "+" a los positivos (ganancias).
 * @param {number} amount
 * @param {string} [currency]  código ISO (EUR, USD…)
 * @param {{ decimals?: number, minDecimals?: number, sign?: boolean }} [opts]
 * @returns {string}
 */
export const formatMoney = (amount, currency = 'EUR', { decimals = 2, minDecimals, sign = false } = {}) => {
  if (!Number.isFinite(amount)) return '—';
  const min = minDecimals ?? decimals;
  let text;
  try {
    text = new Intl.NumberFormat(appLocale(), {
      style: 'currency', currency: currency || 'EUR',
      minimumFractionDigits: min, maximumFractionDigits: decimals, useGrouping: 'always',
    }).format(amount);
  } catch {
    // Código que Intl no reconoce: número del idioma + el código tal cual.
    text = `${formatNumber(amount, min, decimals)} ${currency}`;
  }
  return sign && amount > 0 ? `+${text}` : text;
};

/**
 * Importe abreviado para ejes de gráficos ("1,4 mil €" / "€1.4K"), con un
 * decimal: el eje del P&L mensual redondeaba 1.050 y 1.400 a "€1k" los dos.
 * @param {number} amount
 * @param {string} [currency]
 * @returns {string}
 */
export const formatMoneyCompact = (amount, currency = 'EUR') => {
  if (!Number.isFinite(amount)) return '—';
  try {
    // minimumFractionDigits: 0 explícito: sin él, V8 ≤ 12 (Node ≤ 22 y navegadores con ese V8)
    // toma el mínimo de decimales de la DIVISA (2 en EUR) y lo recorta al máximo,
    // así que 350 salía "350,0 €"; V8 13 (Node 24) ya aplica el 0 de la notación compacta.
    return new Intl.NumberFormat(appLocale(), {
      style: 'currency', currency: currency || 'EUR', notation: 'compact',
      minimumFractionDigits: 0, maximumFractionDigits: 1,
    }).format(amount);
  } catch {
    return `${formatNumber(amount, 0, 1)} ${currency}`;
  }
};
