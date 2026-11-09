/**
 * Vite plugin: Yahoo Finance crumb proxy (solo dev)
 *
 * Yahoo Finance v10/quoteSummary requires a session cookie + crumb. Exposes
 *   GET /api/yahoo-profile/:ticker[?modules=...]
 * igual que `server/routes/marketProxy.js` en producción.
 *
 * El crumb dance NO vive aquí: lo importa de `server/lib/yahooCrumb.js`, la
 * MISMA implementación que usan el proxy de producción y los crons. Esta copia
 * era un duplicado que se quedó atrás: le faltaba `maxHeaderSize`, y como
 * finance.yahoo.com responde con más de 16 KB de cabeceras (muro de
 * consentimiento de la UE), en dev TODAS las peticiones daban
 * 503 "Crumb unavailable" — sin historial de resultados, sin sectores de fondos.
 */

import { refreshCrumb, fetchQuoteSummaryRaw } from '../server/lib/yahooCrumb.js';

const DEFAULT_MODULES = 'assetProfile,summaryDetail,defaultKeyStatistics,financialData';

let started = false;

export default function yahooProfileProxy() {
  return {
    name: 'yahoo-profile-proxy',

    configureServer(server) {
      // Crumb al arrancar (sin bloquear) y refresco cada 50 min; una sola vez
      // aunque Vite vuelva a llamar a configureServer.
      if (!started) {
        started = true;
        refreshCrumb().catch(() => {});
        setInterval(() => refreshCrumb().catch(() => {}), 50 * 60 * 1000).unref?.();
      }

      server.middlewares.use(async (req, res, next) => {
        const match = req.url?.match(/^\/api\/yahoo-profile\/([^/?]+)/);
        if (!match) return next();

        const ticker = decodeURIComponent(match[1]);
        const modules = new URL(req.url, 'http://localhost').searchParams.get('modules') || DEFAULT_MODULES;

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');

        try {
          const { status, body } = await fetchQuoteSummaryRaw(ticker, modules);
          res.statusCode = status;
          res.end(body);
        } catch (e) {
          console.error('[yahoo-crumb] Profile fetch error:', e.message);
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    },
  };
}
