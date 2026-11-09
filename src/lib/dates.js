/**
 * 'YYYY-MM-DD' de hoy en la zona horaria LOCAL del usuario.
 *
 * `new Date().toISOString()` da la fecha UTC: en Madrid, entre las 00:00 y las
 * 02:00, devuelve AYER. Usado como fecha por defecto de un formulario, eso
 * GUARDA la operación con el día anterior. Todo "hoy" de la app sale de aquí.
 *
 * Regla de uso: resuélvelo al abrir el formulario o al renderizar, nunca en una
 * constante a nivel de módulo — se congelaría al importar y una pestaña abierta
 * toda la noche propondría la fecha de ayer.
 */
export function localTodayIso(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})/;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Todos los días 'YYYY-MM-DD' de `startIso` a `endIso`, ambos incluidos.
 *
 * Aritmética en UTC PURA (Date.UTC + 1 día exacto) para que el huso horario no
 * pueda colarse. La serie de rendimiento hacía `new Date('YYYY-MM-DD')` (00:00
 * UTC), avanzaba con `setDate` (hora LOCAL) y escribía con `toISOString()`
 * (UTC): en Madrid en horario de verano cada día salía con la fecha de ayer,
 * buscaba el cierre de ayer, y el día de hoy no aparecía nunca.
 * @param {string} startIso
 * @param {string} endIso
 * @returns {string[]}
 */
export function isoDateRange(startIso, endIso) {
  const a = ISO_DAY_RE.exec(startIso || '');
  const b = ISO_DAY_RE.exec(endIso || '');
  if (!a || !b) return [];
  const start = Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  const end = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]));
  const days = [];
  for (let t = start; t <= end; t += DAY_MS) days.push(new Date(t).toISOString().slice(0, 10));
  return days;
}

/**
 * 'YYYY-MM-DD' → Date a las 00:00 LOCALES de ese día, o null.
 * `new Date('YYYY-MM-DD')` es medianoche UTC: al oeste de UTC (América) eso ya
 * es el día anterior y los ejes rotulaban todo con un día de retraso.
 * @param {string|null|undefined} iso
 * @returns {Date|null}
 */
export function parseIsoDateLocal(iso) {
  const m = ISO_DAY_RE.exec(iso || '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
