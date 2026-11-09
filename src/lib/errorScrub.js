/**
 * Decisiones PURAS de la telemetría de errores de cliente: qué URL se envía y
 * cómo se agrupan dos errores que son "el mismo".
 *
 * Vive aparte de `errorTelemetry.js` (que solo hace el `fetch`) porque estas
 * dos reglas son las únicas que pueden hacer daño si se equivocan —una filtra
 * datos, la otra inunda la tabla— y aquí se pueden testear sin navegador.
 */

// Rutas cuyo parámetro es un SECRETO o un identificador que no aporta nada al
// diagnóstico. `/share/<uuid>` es el caso grave: ese token da acceso público a
// la cartera de alguien, y mandarlo a un registro de errores lo convierte en
// una credencial escrita en una tabla de logs.
const PATH_RULES = [
  [/^\/share\/[^/]+/i, '/share/:token'],
  [/^\/blog\/[^/]+/i, '/blog/:slug'],
];

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// Un JWT o cualquier token largo que se haya colado en la query.
const LONG_TOKEN_RE = /\b[A-Za-z0-9_-]{24,}\b/g;

/**
 * Convierte una URL real en la RUTA que se guarda. Devuelve el patrón, nunca
 * el valor: `/share/a65479eb-…` → `/share/:token`.
 *
 * La query string se descarta ENTERA a propósito. Se intentó conservarla
 * filtrando claves sospechosas, pero es una lista negra —siempre incompleta— y
 * el valor para depurar es marginal frente a filtrar un token por un parámetro
 * nuevo que nadie recordó añadir.
 *
 * @param {string} href URL absoluta o ruta
 * @returns {string} ruta normalizada, sin query ni hash
 */
export function scrubUrl(href) {
  if (typeof href !== 'string' || !href) return '';
  let path = href;
  try {
    // Base ficticia: permite parsear también rutas relativas.
    path = new URL(href, 'http://x').pathname;
  } catch {
    path = String(href).split('?')[0].split('#')[0];
  }
  for (const [re, replacement] of PATH_RULES) {
    if (re.test(path)) return path.replace(re, replacement);
  }
  // Cualquier UUID suelto en una ruta no contemplada arriba también se tapa.
  return path.replace(UUID_RE, ':id');
}

/**
 * Quita de un texto libre (mensaje o stack) lo que parezca un identificador o
 * un token. Sin esto, un "Failed to fetch /share-data/<uuid>" metería el token
 * en el MENSAJE aunque la URL vaya limpia.
 */
export function scrubText(text, max = 2000) {
  if (typeof text !== 'string' || !text) return '';
  return text
    .replace(UUID_RE, ':id')
    .replace(LONG_TOKEN_RE, (m) => (/^[A-Za-z0-9_-]{24,}$/.test(m) ? ':token' : m))
    .slice(0, max);
}

/**
 * Huella estable para agrupar ocurrencias del MISMO fallo.
 *
 * Se construye con el tipo + el mensaje + el primer marco del stack, y NO con
 * el stack entero: los marcos de abajo cambian con la ruta desde la que se
 * llegó, así que el stack completo daría una huella distinta por cada camino y
 * el mismo bug aparecería veinte veces.
 *
 * El mensaje va scrubbeado ANTES de la huella: si no, dos ocurrencias que solo
 * difieren en un UUID contarían como errores distintos — exactamente lo que
 * hace inservible una tabla de errores.
 */
export function fingerprint({ kind, message, stack }) {
  const msg = scrubText(message || '', 300);
  const firstFrame = String(stack || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('at ') || /\.(jsx?|tsx?):\d+/.test(l)) || '';
  return [kind || 'error', msg, scrubText(firstFrame, 200)].join('|');
}
