/**
 * País de un valor sin llamar a ninguna API: por el prefijo ISO del ISIN o por el
 * sufijo de bolsa del ticker. Los nombres coinciden con las claves de REGION_MAP
 * del quesito de regiones del Dashboard, que es quien los consume.
 */

const ISIN_COUNTRY = {
  US: 'United States', CA: 'Canada', MX: 'Mexico',
  GB: 'United Kingdom', DE: 'Germany', FR: 'France', ES: 'Spain', IT: 'Italy',
  NL: 'Netherlands', CH: 'Switzerland', SE: 'Sweden', NO: 'Norway', DK: 'Denmark',
  FI: 'Finland', BE: 'Belgium', PT: 'Portugal', AT: 'Austria', LU: 'Luxembourg',
  IE: 'Ireland',
  JP: 'Japan', CN: 'China', HK: 'Hong Kong', AU: 'Australia', IN: 'India',
  KR: 'South Korea', TW: 'Taiwan', SG: 'Singapore',
  BR: 'Brazil', AR: 'Argentina', CL: 'Chile',
  SA: 'Saudi Arabia', AE: 'UAE', IL: 'Israel',
};

/** País por el prefijo de 2 letras del ISIN (el método más fiable, sin API). */
export function countryFromIsin(isin = '') {
  if (!isin || isin.length < 2) return null;
  return ISIN_COUNTRY[isin.slice(0, 2).toUpperCase()] || null;
}

// Orden importante: se comprueba con endsWith y ningún sufijo es final de otro.
const SUFFIX_COUNTRY = [
  [['.L'], 'United Kingdom'], [['.PA'], 'France'], [['.AS'], 'Netherlands'],
  [['.DE', '.XETRA'], 'Germany'], [['.MI'], 'Italy'], [['.MC'], 'Spain'],
  [['.LS'], 'Portugal'], [['.SW'], 'Switzerland'], [['.ST'], 'Sweden'],
  [['.CO'], 'Denmark'], [['.HE'], 'Finland'], [['.OL'], 'Norway'],
  [['.BR'], 'Belgium'], [['.IR', '.IE'], 'Ireland'], [['.T'], 'Japan'],
  [['.HK'], 'Hong Kong'], [['.AX'], 'Australia'], [['.TO', '.V'], 'Canada'],
  [['.BO', '.NS'], 'India'], [['.SS', '.SZ'], 'China'], [['.KS', '.KQ'], 'South Korea'],
  [['.TW'], 'Taiwan'], [['.SI'], 'Singapore'], [['.SA'], 'Brazil'], [['.TA'], 'Israel'],
];

/**
 * País por el sufijo de bolsa del ticker de BD. Respaldo sin API cuando el perfil
 * de Yahoo no trae país. Sin sufijo y con forma de símbolo americano → EE. UU.
 */
export function countryFromTicker(rawTicker = '') {
  const t = (rawTicker || '').toUpperCase();
  if (t.includes('-')) return 'Global';            // cripto (BTC-USD, ETH-USD)
  if (t.startsWith('CASH')) return null;
  for (const [suffixes, country] of SUFFIX_COUNTRY) {
    if (suffixes.some((s) => t.endsWith(s))) return country;
  }
  if (/^[A-Z]{1,5}$/.test(t)) return 'United States';
  return null;
}
