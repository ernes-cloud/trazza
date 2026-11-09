/**
 * Filtrado de opciones para desplegables buscables (SearchableSelect).
 *
 * Puro y sin dependencias para poder testearlo: el proyecto no tiene testing
 * DOM, así que la lógica de un componente se extrae aquí (misma regla que
 * `services/positionRowMetrics.js`).
 */

/**
 * Normaliza para comparar: minúsculas, SIN acentos y sin espacios de sobra.
 * Sin quitar acentos, teclear "alimentacion" no encontraría "Alimentación" —
 * y nadie escribe acentos en un buscador (misma lección que las reglas de
 * comercios del import bancario, que se escriben sin acentos a propósito).
 * NFD separa la letra de su tilde y `\p{M}` (marcas combinantes) la borra.
 */
export function normalizeSearch(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim();
}

/**
 * Filtra `options` ({ value, label }) por `query` sobre el label.
 * Las coincidencias por PREFIJO van primero; entre iguales se conserva el
 * orden original, que es el orden curado de las categorías.
 * Una query vacía devuelve la lista intacta.
 */
export function filterOptions(options = [], query = '') {
  const q = normalizeSearch(query);
  if (!q) return options;

  const scored = [];
  options.forEach((opt, index) => {
    const label = normalizeSearch(opt.label ?? opt.value);
    const at = label.indexOf(q);
    if (at === -1) return;
    scored.push({ opt, index, rank: at === 0 ? 0 : 1 });
  });

  return scored
    .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
    .map((s) => s.opt);
}
