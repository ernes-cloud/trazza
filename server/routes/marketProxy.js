/**
 * Market-data proxies for self-hosted production.
 *
 * In dev these live in vite.config.js (simple proxies) plus two plugins
 * (yahoo-crumb-proxy, secure-api-proxy). In a self-hosted deployment the
 * frontend is static files — this module mirrors ALL of them on the Express
 * server so the reverse proxy only needs one rule: /api/* → this server.
 * (The api/ folder holds the same proxies as Vercel functions, only used if
 * deploying the frontend to Vercel.)
 *
 * Routes (GET only):
 *   /api/yahoo/*         → https://query1.finance.yahoo.com/*
 *   /api/yahoo2/*        → https://query2.finance.yahoo.com/*
 *   /api/eodhd/*         → https://eodhd.com/api/*
 *   /api/nasdaq/*        → https://api.nasdaq.com/*
 *   /api/frankfurter/*   → https://api.frankfurter.dev/v1/*   (FX rates)
 *   /api/yahoo-profile/:ticker  → v10/quoteSummary con crumb dance
 *   /api/eodhd-secure/*  → EODHD con la key del usuario (JWT) o EODHD_PLATFORM_KEY
 */

import https from 'https';
import { URL } from 'url';
import { supabaseAdmin } from '../lib/adminSupabase.js';
import { requireUser } from '../lib/requireUser.js';
import { BROWSER_UA, fetchQuoteSummaryRaw } from '../lib/yahooCrumb.js';
import { asyncHandler } from '../lib/asyncHandler.js';

// ── Generic streaming proxy ───────────────────────────────────────────────────

function proxyGet(targetUrl, res, extraHeaders = {}) {
  return new Promise((resolve) => {
    const u = new URL(targetUrl);
    const proxyReq = https.get(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'application/json, text/plain, */*',
          ...extraHeaders,
        },
      },
      (proxyRes) => {
        res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'application/json');
        res.statusCode = proxyRes.statusCode;
        proxyRes.pipe(res, { end: true });
        proxyRes.on('end', resolve);
      }
    );
    proxyReq.setTimeout(20_000, () => {
      proxyReq.destroy();
      if (!res.headersSent) res.status(504).json({ error: 'Upstream timeout' });
      resolve();
    });
    proxyReq.on('error', (e) => {
      if (!res.headersSent) res.status(502).json({ error: e.message });
      resolve();
    });
  });
}

const simpleProxy = (prefix, base, headers = {}) => (req, res) => {
  const suffix = req.originalUrl.replace(new RegExp(`^${prefix}`), '') || '/';
  return proxyGet(`${base}${suffix}`, res, headers);
};

// ── Yahoo crumb dance (v10/quoteSummary) — vive en lib/yahooCrumb.js ─────────
// (compartido con el cron de notificaciones, que también necesita quoteSummary)

async function yahooProfile(req, res) {
  let ticker;
  try {
    ticker = decodeURIComponent(req.params.ticker || '');
  } catch {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  if (!ticker) return res.status(400).json({ error: 'Usage: /api/yahoo-profile/:ticker' });
  const modules = req.query.modules || 'assetProfile,summaryDetail,defaultKeyStatistics,financialData';

  try {
    const { status, body } = await fetchQuoteSummaryRaw(ticker, modules);
    return res.status(status).type('application/json').send(body);
  } catch (e) {
    console.error('[market-proxy] yahoo-profile error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ── EODHD secure proxy (key nunca llega al navegador) ─────────────────────────

const apiKeyCache = new Map(); // userId → { key, expiresAt }
const API_KEY_TTL = 10 * 60 * 1000;

/**
 * Resuelve la key de EODHD para un usuario YA AUTENTICADO.
 *
 * Recibe el `user` verificado, no el JWT en crudo, y esa firma ES el arreglo:
 * antes esta funcion recibia el token y devolvia `EODHD_PLATFORM_KEY` en su
 * PRIMERA sentencia, sin llegar nunca a `auth.getUser`. Con la key de
 * plataforma configurada, /api/eodhd-secure/* quedaba como un proxy ABIERTO a
 * EODHD con la cuenta de pago de la plataforma: cualquiera en internet podia
 * gastar la cuota sin tener sesion. Pidiendo el usuario ya resuelto, el orden
 * correcto lo impone la firma y no la disciplina de quien edite el fichero.
 */
async function resolveEodhdKey(user) {
  // La key de plataforma la comparten todos los usuarios AUTENTICADOS: ahorra
  // la consulta por usuario, nunca la autenticacion.
  if (process.env.EODHD_PLATFORM_KEY) return process.env.EODHD_PLATFORM_KEY;
  if (!supabaseAdmin) return null;

  const cached = apiKeyCache.get(user.id);
  if (cached && Date.now() < cached.expiresAt) return cached.key;

  const { data } = await supabaseAdmin
    .from('user_preferences')
    .select('eodhd_api_key')
    .eq('user_id', user.id)
    .maybeSingle();

  const key = data?.eodhd_api_key || null;
  if (key) apiKeyCache.set(user.id, { key, expiresAt: Date.now() + API_KEY_TTL });
  return key;
}

export async function eodhdSecure(req, res) {
  // La verificacion del JWT va SIEMPRE PRIMERO y sin excepciones: este proxy
  // inyecta una API key de pago, asi que una peticion que no se puede atribuir
  // a un usuario no se sirve. `requireUser` responde 401 (token ausente o
  // invalido) o 503 (server sin credenciales de Supabase: no hay forma de
  // autenticar a nadie) y devuelve null.
  const user = await requireUser(req, res);
  if (!user) return;   // requireUser ya respondio

  try {
    const apiKey = await resolveEodhdKey(user);
    if (!apiKey) {
      return res.status(503).json({ error: 'eodhd_not_configured' });
    }
    const suffix = req.originalUrl.replace(/^\/api\/eodhd-secure/, '') || '/';
    const sep = suffix.includes('?') ? '&' : '?';
    return proxyGet(`https://eodhd.com/api${suffix}${sep}api_token=${encodeURIComponent(apiKey)}`, res);
  } catch (e) {
    console.error('[market-proxy] eodhd-secure error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Proxy error' });
  }
}

// ── Registrar ─────────────────────────────────────────────────────────────────

export function registerMarketProxies(app, limiter) {
  const mw = limiter ? [limiter] : [];
  app.get('/api/yahoo-profile/:ticker', ...mw, asyncHandler(yahooProfile));
  app.get('/api/eodhd-secure/*', ...mw, asyncHandler(eodhdSecure));
  // simpleProxy resuelve/rechazos dentro de proxyGet — no lanza al event loop.
  app.get('/api/yahoo/*',   ...mw, simpleProxy('/api/yahoo',   'https://query1.finance.yahoo.com', { Origin: 'https://finance.yahoo.com', Referer: 'https://finance.yahoo.com/' }));
  app.get('/api/yahoo2/*',  ...mw, simpleProxy('/api/yahoo2',  'https://query2.finance.yahoo.com', { Origin: 'https://finance.yahoo.com', Referer: 'https://finance.yahoo.com/' }));
  app.get('/api/eodhd/*',   ...mw, simpleProxy('/api/eodhd',   'https://eodhd.com/api'));
  app.get('/api/nasdaq/*',  ...mw, simpleProxy('/api/nasdaq',  'https://api.nasdaq.com', { Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' }));
  app.get('/api/frankfurter/*', ...mw, simpleProxy('/api/frankfurter', 'https://api.frankfurter.dev/v1'));
}
