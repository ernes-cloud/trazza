/**
 * Decisiones PURAS sobre la entrega de un correo: si un fallo merece reintento
 * y cuánto esperar antes del siguiente. Sin red, sin estado, testeable.
 *
 * Por qué existe separado del transporte: hasta ahora un fallo de SMTP se
 * tragaba con un `catch` que devolvía 200 "para que Supabase no reintente
 * indefinidamente". El efecto real era que el aviso se perdía PARA SIEMPRE y
 * nadie se enteraba: ni el usuario, ni nosotros (el buffer de logs vive en
 * memoria y son 500 entradas). Reintentar bien exige distinguir un fallo
 * transitorio de uno definitivo, y esa distinción es una regla, no I/O.
 */

/** Intentos totales (el primero incluido). Tres cubre el 99% de los baches. */
export const MAX_ATTEMPTS = 3;

/** Base del backoff exponencial, en ms. */
const BACKOFF_BASE_MS = 500;

/**
 * Códigos de nodemailer que son de RED, no del servidor de correo: la
 * conexión no llegó a completarse, así que nada indica que el mensaje sea
 * inválido. Siempre transitorios.
 */
const NETWORK_CODES = new Set([
  'ECONNECTION',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ESOCKET',
  'EDNS',
  'EPIPE',
]);

/**
 * Errores DEFINITIVOS: reintentarlos no cambia nada y solo retrasa la
 * respuesta al webhook.
 *  - EAUTH: credenciales mal (API key revocada). Falla igual las 3 veces.
 *  - EMESSAGE: el mensaje en sí es inválido.
 */
const PERMANENT_CODES = new Set(['EAUTH', 'EMESSAGE']);

/**
 * ¿Merece la pena reintentar este fallo?
 *
 * Criterio, en orden:
 *  1. Código de red → SÍ.
 *  2. Código permanente conocido → NO.
 *  3. Código SMTP 4xx → SÍ (por definición del protocolo: "inténtalo luego").
 *     Aquí caen el rate-limit (421/450/451) y el buzón temporalmente lleno.
 *  4. Código SMTP 5xx → NO (buzón inexistente, dominio rechazado, spam).
 *  5. Sin información → SÍ.
 *
 * El caso 5 es deliberado y asimétrico: reintentar un fallo definitivo cuesta
 * dos intentos perdidos; NO reintentar uno transitorio cuesta la notificación
 * entera, que es justo el problema que este módulo viene a arreglar.
 *
 * @param {any} err
 * @returns {{ retryable: boolean, reason: string }}
 */
export function classifyEmailError(err) {
  const code = err?.code;
  if (code && NETWORK_CODES.has(code)) {
    return { retryable: true, reason: `network:${code}` };
  }
  if (code && PERMANENT_CODES.has(code)) {
    return { retryable: false, reason: `permanent:${code}` };
  }

  const status = Number(err?.responseCode);
  if (Number.isFinite(status) && status >= 400 && status < 500) {
    return { retryable: true, reason: `smtp:${status}` };
  }
  if (Number.isFinite(status) && status >= 500 && status < 600) {
    return { retryable: false, reason: `smtp:${status}` };
  }

  return { retryable: true, reason: 'unknown' };
}

/**
 * Espera antes del intento `attempt` (1 = el primer reintento).
 * Exponencial con jitter: sin el jitter, varias notificaciones que fallan a la
 * vez (el cron inserta un lote) reintentarían todas en el mismo instante y
 * volverían a chocar contra el mismo límite que las tumbó.
 *
 * @param {number} attempt  1, 2, 3…
 * @param {() => number} [rng]  inyectable para poder testear el rango
 */
export function nextBackoffMs(attempt, rng = Math.random) {
  const base = BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempt - 1));
  // ±25%: suficiente para desincronizar sin alargar mucho la respuesta.
  const jitter = base * 0.25 * (rng() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

/**
 * Recorta y normaliza el mensaje de error que se guarda en la tabla. Un stack
 * de nodemailer puede traer la cabecera completa del mensaje.
 */
export function summarizeEmailError(err, max = 500) {
  const parts = [];
  if (err?.code) parts.push(String(err.code));
  if (err?.responseCode) parts.push(String(err.responseCode));
  const msg = String(err?.message || err || 'unknown error');
  parts.push(msg);
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
