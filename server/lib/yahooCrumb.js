/**
 * Yahoo crumb dance para v10/quoteSummary — mirrors plugins/yahoo-crumb-proxy.
 *
 * quoteSummary SIN cookie+crumb responde SIEMPRE
 * {"error":{"code":"Unauthorized","description":"Invalid Crumb"}}. Vivía privado
 * en routes/marketProxy.js, así que el cron de notificaciones pedía quoteSummary
 * a pelo y su fallback de resultados (todo lo que no está en el calendario de
 * Nasdaq: ASML.AS, CSU.TO…) no devolvió una fecha jamás. Lo comparten ahora el
 * proxy y el cron.
 */

import https from 'https';
import { URL } from 'url';

export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let cachedCrumb = null;
let cachedCookies = '';
let lastFetch = 0;
let refreshInProgress = false;
const CRUMB_TTL = 55 * 60 * 1000;

export function httpsGetBody(urlStr, cookies = '') {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.get(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        // finance.yahoo.com responde (sobre todo desde la UE, con el muro de
        // consentimiento) con más de 16 KB de cabeceras —el límite por defecto
        // de Node— y la petición moría con "Header overflow": sin cookies no
        // hay crumb, y sin crumb quoteSummary da 401.
        maxHeaderSize: 64 * 1024,
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'text/html,application/xhtml+xml,application/json,*/*;q=0.9',
          'Accept-Language': 'en-US,en;q=0.9',
          ...(cookies ? { Cookie: cookies } : {}),
        },
      },
      (res) => {
        const newCookies = (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]);
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const redirectUrl = res.headers.location.startsWith('http')
            ? res.headers.location
            : `https://${u.hostname}${res.headers.location}`;
          return httpsGetBody(redirectUrl, [...cookies.split('; '), ...newCookies].filter(Boolean).join('; '))
            .then(r => resolve({ ...r, cookies: [...newCookies, ...r.cookies.split('; ')].filter(Boolean).join('; ') }))
            .catch(reject);
        }
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ body, cookies: newCookies.join('; '), status: res.statusCode }));
      }
    );
    req.setTimeout(15_000, () => { req.destroy(); reject(new Error('Yahoo crumb fetch timed out')); });
    req.on('error', reject);
  });
}

export async function refreshCrumb() {
  if (refreshInProgress) return false;
  refreshInProgress = true;
  try {
    const r1 = await httpsGetBody('https://finance.yahoo.com/', '');
    if (!r1.cookies) throw new Error('No cookies from finance.yahoo.com');
    const r2 = await httpsGetBody('https://query2.finance.yahoo.com/v1/test/getcrumb', r1.cookies);
    const crumb = r2.body.trim();
    if (!crumb || crumb.includes('{') || crumb.length > 50) {
      throw new Error(`Bad crumb response: ${crumb.substring(0, 80)}`);
    }
    cachedCrumb = crumb;
    cachedCookies = r1.cookies;
    lastFetch = Date.now();
    return true;
  } catch (e) {
    console.warn('[yahoo-crumb] Crumb refresh failed:', e.message);
    return false;
  } finally {
    refreshInProgress = false;
  }
}

export async function ensureCrumb() {
  if (!cachedCrumb || Date.now() - lastFetch > CRUMB_TTL) await refreshCrumb();
  return { crumb: cachedCrumb, cookies: cachedCookies };
}

// modules must NOT be encoded — Yahoo expects literal commas
const quoteSummaryUrl = (ticker, modules, crumb) =>
  `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;

/**
 * quoteSummary con crumb. Devuelve `{ status, body }` (body en texto crudo)
 * para que el proxy lo reenvíe tal cual. Si la primera respuesta no es 200 el
 * crumb puede haber caducado: se refresca y se reintenta UNA vez.
 */
export async function fetchQuoteSummaryRaw(ticker, modules) {
  const { crumb, cookies } = await ensureCrumb();
  if (!crumb) return { status: 503, body: JSON.stringify({ error: 'Crumb unavailable' }) };

  const r = await httpsGetBody(quoteSummaryUrl(ticker, modules, crumb), cookies);
  if (r.status === 200) return { status: 200, body: r.body };

  await refreshCrumb();
  const { crumb: c2, cookies: k2 } = await ensureCrumb();
  if (!c2) throw new Error('Crumb refresh failed');
  const r2 = await httpsGetBody(quoteSummaryUrl(ticker, modules, c2), k2);
  return { status: r2.status, body: r2.body };
}

/**
 * Cotizaciones en lote (v7/finance/quote) con crumb. Sin crumb el v7 responde
 * 401/429, y el plan B del server (un v8 por ticker) choca con el límite de
 * Yahoo en cuanto hay unas decenas de tickers: el cron de snapshots llegó a
 * resolver 0 de 44 cotizaciones en TODAS sus pasadas. Una petición por lote.
 * @returns {Promise<object>} JSON de Yahoo; lanza si no es 200.
 */
export async function fetchV7Quotes(symbols) {
  const url = (crumb) =>
    `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${symbols.map(encodeURIComponent).join(',')}&crumb=${encodeURIComponent(crumb)}`;
  let { crumb, cookies } = await ensureCrumb();
  if (!crumb) throw new Error('Crumb unavailable');
  let r = await httpsGetBody(url(crumb), cookies);
  if (r.status === 401 || r.status === 403) {
    await refreshCrumb();
    ({ crumb, cookies } = await ensureCrumb());
    if (!crumb) throw new Error('Crumb refresh failed');
    r = await httpsGetBody(url(crumb), cookies);
  }
  if (r.status !== 200) throw new Error(`Yahoo v7 quote HTTP ${r.status}`);
  return JSON.parse(r.body);
}

/** Igual que fetchQuoteSummaryRaw pero ya parseado; lanza si no es 200. */
export async function fetchQuoteSummary(ticker, modules) {
  const { status, body } = await fetchQuoteSummaryRaw(ticker, modules);
  if (status !== 200) throw new Error(`Yahoo quoteSummary HTTP ${status} for ${ticker}`);
  return JSON.parse(body);
}
