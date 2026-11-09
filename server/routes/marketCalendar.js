/**
 * GET /api/market-calendar/:kind  (kind = dividends | earnings)
 *
 * El navegador montaba los calendarios de Nasdaq pidiendo UN día cada vez: unas
 * 86 peticiones de dividendos y 43 de resultados en cada carga del Dashboard, por
 * usuario. Son los mismos datos para todo el mundo, así que el server los monta
 * una vez (lib/marketCalendar.js, de 12 en 12 contra Nasdaq), los guarda en
 * memoria y el navegador hace UNA petición por calendario.
 *
 * Política de caché (pura, testeada en marketCalendar.test.js):
 * - Un calendario con filas vale `ttlMs` (6 h, lo mismo que la caché del cliente).
 * - Peticiones simultáneas comparten UNA construcción.
 * - Un calendario VACÍO no se guarda: casi seguro es Nasdaq bloqueando o caído,
 *   y guardarlo dejaría a todos sin dividendos 6 h. Se responde 503 (el cliente
 *   cae a su camino de siempre) y ese fallo se recuerda `failTtlMs` para no
 *   relanzar 86 peticiones a Nasdaq en cada visita.
 * - Si una renovación falla y hay datos anteriores, se sirven los anteriores.
 */
import { gzipSync } from 'node:zlib';
import { fetchDividendRows, fetchEarningsRows } from '../lib/marketCalendar.js';

export const CALENDAR_TTL_MS = 6 * 60 * 60 * 1000;
export const CALENDAR_FAIL_TTL_MS = 5 * 60 * 1000;

/**
 * @param {{ fetchers: Record<string, () => Promise<object[]>>, ttlMs?: number,
 *           failTtlMs?: number, now?: () => number }} deps
 * @returns {(kind: string) => Promise<{ status: number, rows?: object[], generatedAt?: number }>}
 */
export function createCalendarStore({ fetchers, ttlMs = CALENDAR_TTL_MS, failTtlMs = CALENDAR_FAIL_TTL_MS, now = Date.now }) {
  const state = {}; // kind → { rows, at, failedAt, inflight }

  const build = async (kind) => {
    const s = state[kind];
    try {
      const rows = await fetchers[kind]();
      if (Array.isArray(rows) && rows.length > 0) {
        s.rows = rows;
        s.at = now();
        s.failedAt = null;
      } else {
        s.failedAt = now();
      }
    } catch {
      s.failedAt = now();
    } finally {
      s.inflight = null;
    }
  };

  return async function get(kind) {
    if (!fetchers[kind]) return { status: 404 };
    const s = (state[kind] ||= { rows: null, at: 0, failedAt: null, inflight: null });
    const fresh = s.rows && now() - s.at < ttlMs;
    const recentlyFailed = s.failedAt != null && now() - s.failedAt < failTtlMs;

    if (!fresh && !recentlyFailed) {
      s.inflight ||= build(kind);
      await s.inflight;
    }
    if (s.rows) return { status: 200, rows: s.rows, generatedAt: s.at };
    return { status: 503 };
  };
}

const store = createCalendarStore({
  fetchers: {
    dividends: () => fetchDividendRows(30, 90),
    earnings: () => fetchEarningsRows(14, 45),
  },
});

// nginx NO comprime JSON (gzip_types está comentado en el nginx.conf común a
// todas las webs del VPS) y el de resultados pesa ~740 KB sin comprimir frente a
// ~70 KB con gzip. Se comprime aquí UNA vez por calendario construido.
const encoded = {}; // kind → { at, json, gz }

function encodedFor(kind, rows, generatedAt) {
  const hit = encoded[kind];
  if (hit && hit.at === generatedAt) return hit;
  const json = JSON.stringify({ rows, generatedAt: new Date(generatedAt).toISOString() });
  return (encoded[kind] = { at: generatedAt, json, gz: gzipSync(json) });
}

export async function marketCalendarHandler(req, res) {
  const result = await store(req.params.kind);
  if (result.status !== 200) {
    return res.status(result.status).json({ error: result.status === 404 ? 'Unknown calendar' : 'Calendar unavailable' });
  }
  const body = encodedFor(req.params.kind, result.rows, result.generatedAt);
  // El navegador puede reutilizarlo 10 min; nginx no necesita cachearlo (ya lo hace el server).
  res.set('Cache-Control', 'public, max-age=600');
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Vary', 'Accept-Encoding');
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    res.set('Content-Encoding', 'gzip');
    return res.send(body.gz);
  }
  return res.send(body.json);
}
