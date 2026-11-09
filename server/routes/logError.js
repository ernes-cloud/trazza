/**
 * POST /api/log-error
 *
 * Errores de JavaScript ocurridos en el NAVEGADOR del usuario. Público y sin
 * auth, igual que /api/log-import: el fallo puede pasar en la landing o en una
 * cartera compartida, donde no hay sesión.
 *
 * Body (JSON) — todo ya scrubbeado en cliente por `lib/errorScrub.js`:
 *   {
 *     kind: 'render' | 'window' | 'promise',
 *     fingerprint: string,        // agrupa ocurrencias del mismo fallo
 *     message: string,
 *     stack?: string,
 *     component_stack?: string,   // árbol de React, solo en 'render'
 *     route?: string,             // RUTA normalizada: '/share/:token', nunca el token
 *     user_agent?: string,
 *     app_version?: string,
 *   }
 *
 * Se AGRUPA por `fingerprint` en vez de insertar una fila por ocurrencia: un
 * bug de render se dispara en bucle y a las pocas horas la tabla sería
 * ilegible. Cada huella es una fila con su contador, primera y última vez.
 *
 * Va al buffer de admin (Admin → Logs, servicio 'client') y a la tabla
 * `client_errors`. La persistencia es best-effort: sin Supabase configurado
 * (dev local) el buffer sigue funcionando.
 */

import { addLog } from '../lib/logBuffer.js';
import { supabaseAdmin } from '../lib/adminSupabase.js';

const KINDS = new Set(['render', 'window', 'promise']);

const cleanStr = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);

// Segunda pasada de scrubbing EN EL SERVIDOR. El cliente ya limpia, pero este
// endpoint es público y cualquiera puede postear a mano: no se confía en que
// lo que llega venga limpio.
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const scrub = (v, max) => {
  const s = cleanStr(v, max);
  return s ? s.replace(UUID_RE, ':id') : null;
};

export async function logError(req, res) {
  const b = req.body || {};

  if (!KINDS.has(b.kind)) {
    return res.status(400).json({ error: 'kind must be render, window or promise' });
  }
  const message = scrub(b.message, 300);
  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }

  const row = {
    kind: b.kind,
    // Sin huella del cliente se deriva una mínima, para no perder el evento.
    fingerprint: cleanStr(b.fingerprint, 500) || `${b.kind}|${message}`,
    message,
    stack: scrub(b.stack, 4000),
    component_stack: scrub(b.component_stack, 2000),
    route: scrub(b.route, 200),
    user_agent: cleanStr(b.user_agent, 300),
    app_version: cleanStr(b.app_version, 60),
  };

  addLog('error', 'client', [
    `JS ${row.kind}`,
    row.route ? `route=${row.route}` : null,
    `msg=${row.message}`,
  ].filter(Boolean).join(' · '), row);

  if (supabaseAdmin) {
    try {
      // Una RPC y no un upsert: hay que INCREMENTAR el contador y mover
      // `last_seen` conservando `first_seen`, y eso un upsert no lo hace sin
      // leer antes (y perder actualizaciones si dos usuarios fallan a la vez).
      const { error: rpcErr } = await supabaseAdmin.rpc('record_client_error', {
        p_fingerprint:     row.fingerprint,
        p_kind:            row.kind,
        p_message:         row.message,
        p_stack:           row.stack,
        p_component_stack: row.component_stack,
        p_route:           row.route,
        p_user_agent:      row.user_agent,
        p_app_version:     row.app_version,
      });
      if (rpcErr) console.error('[logError] rpc failed:', rpcErr.message);
    } catch (e) {
      console.error('[logError] persistence error:', e.message);
    }
  }

  return res.json({ ok: true });
}
