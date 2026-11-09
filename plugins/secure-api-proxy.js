/**
 * Vite plugin: Secure API key proxy for EODHD
 *
 * Problem: API keys must never travel from the DB → browser → external URL
 * (they'd appear in network requests, browser history, and server access logs).
 *
 * Solution: The browser sends requests to /api/eodhd-secure/* with only an
 * Authorization: Bearer <jwt> header.
 * This plugin validates the JWT server-side, fetches the user's API key from
 * Supabase user_preferences, and injects it into the outbound request — so the
 * key never reaches the browser at any point.
 *
 * Requires in .env:
 *   SUPABASE_SERVICE_ROLE_KEY=<your service role key>   (NOT VITE_-prefixed)
 *   VITE_SUPABASE_URL=https://<ref>.supabase.co
 */

import https from 'https';
import { URL } from 'url';
import { createClient } from '@supabase/supabase-js';

let supabaseAdmin = null;

// Cache resolved API keys so we don't hit Supabase on every EODHD/Finnhub request.
// Key: `${userId}:${keyField}`, value: { key, expiresAt }
const apiKeyCache = new Map();
const API_KEY_TTL = 10 * 60 * 1000; // 10 minutes

function getSupabaseAdmin() {
  if (supabaseAdmin) return supabaseAdmin;

  const url = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    console.warn(
      '[secure-api-proxy] SUPABASE_SERVICE_ROLE_KEY not set — ' +
      'EODHD/Finnhub secure proxy will return 503. Add it to .env.'
    );
    return null;
  }

  supabaseAdmin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return supabaseAdmin;
}

async function resolveApiKey(jwt, keyField) {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  // El token se verifica ANTES de elegir la key, nunca despues. El handler de
  // abajo solo comprueba que la cabecera Authorization VENGA; si el atajo de la
  // platform key se toma antes de esto, un token cualquiera (o basura) sirve
  // para proxyear EODHD con la cuenta de pago de la plataforma. Espejo del
  // mismo arreglo en server/routes/marketProxy.js.
  const { data: { user }, error } = await admin.auth.getUser(jwt);
  if (error || !user) return null;

  // Platform key: la comparten todos los usuarios AUTENTICADOS -- ahorra la
  // consulta por usuario, nunca la autenticacion.
  if (keyField === 'eodhd_api_key' && process.env.EODHD_PLATFORM_KEY) {
    return process.env.EODHD_PLATFORM_KEY;
  }

  const cacheKey = `${user.id}:${keyField}`;
  const cached = apiKeyCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.key;

  const { data } = await admin
    .from('user_preferences')
    .select(keyField)
    .eq('user_id', user.id)
    .maybeSingle();

  const key = data?.[keyField] || null;
  if (key) apiKeyCache.set(cacheKey, { key, expiresAt: Date.now() + API_KEY_TTL });
  return key;
}

function httpsGetPipe(targetUrl, res) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const req = https.get(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: 'application/json',
        },
      },
      (proxyRes) => {
        res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.statusCode = proxyRes.statusCode;
        proxyRes.pipe(res, { end: true });
        proxyRes.on('end', resolve);
      }
    );
    req.setTimeout(15_000, () => {
      req.destroy();
      reject(new Error('EODHD/Finnhub proxy request timed out after 15s'));
    });
    req.on('error', reject);
  });
}

export default function secureApiProxy() {
  return {
    name: 'secure-api-proxy',

    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url || '';
        const isEodhd = url.startsWith('/api/eodhd-secure/');
        if (!isEodhd) return next();

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');

        const jwt = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
        if (!jwt) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: 'Missing authorization token' }));
          return;
        }

        try {
          const apiKey = await resolveApiKey(jwt, 'eodhd_api_key');

          if (!apiKey) {
            res.statusCode = 403;
            res.end(JSON.stringify({ error: 'API key not configured. Add it in Settings.' }));
            return;
          }

          const pathSuffix = url.replace('/api/eodhd-secure', '');
          const sep = pathSuffix.includes('?') ? '&' : '?';
          const targetUrl = `https://eodhd.com/api${pathSuffix}${sep}api_token=${encodeURIComponent(apiKey)}`;

          await httpsGetPipe(targetUrl, res);
        } catch (e) {
          console.error('[secure-api-proxy]', e.message);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: 'Proxy error' }));
          }
        }
      });
    },
  };
}
