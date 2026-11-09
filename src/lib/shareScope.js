/**
 * ¿La selección de brokers de un share cubre el MISMO ámbito del que vienen la
 * serie de rendimiento y las métricas cacheadas del Dashboard?
 *
 * Importa porque `cached_metrics.twr` es la ÚNICA métrica que el endpoint del
 * share usa siempre del cache (el server no sabe calcular TTWROR), y de ella
 * sale la rentabilidad anualizada. El resto de números los recalcula fresco
 * desde la BD para el conjunto de brokers del share — así que un ámbito
 * distinto no da un número aproximado: pone la curva y la anualizada de una
 * cartera sobre las posiciones y el valor de otra.
 *
 * El caso real: el Dashboard filtrado a un broker pasa su serie y sus métricas,
 * mientras el modal ofrecía por defecto "todos los brokers".
 *
 * Puro y sin dependencias para poder testearlo — la decisión NO puede vivir
 * inline en el componente.
 */

/**
 * @param {string} metricsScope   'general' (toda la cartera) o el id del broker
 *                                al que corresponden serie y métricas.
 * @param {string[]} selectedBrokerIds  Brokers elegidos en el modal. Vacío se
 *                                interpreta como "todos", igual que hace el
 *                                insert (`broker_ids = null`).
 * @param {string[]} allBrokerIds Todos los brokers del usuario.
 * @returns {boolean}
 */
export function shareScopeMatches(metricsScope, selectedBrokerIds = [], allBrokerIds = []) {
  if (!allBrokerIds.length) return false;

  if (metricsScope && metricsScope !== 'general') {
    // Ámbito de un broker: solo casa una selección de exactamente ese broker.
    return selectedBrokerIds.length === 1 && selectedBrokerIds[0] === metricsScope;
  }

  // Ámbito general: casa cuando la selección cubre TODOS los brokers. Se compara
  // por conjunto, no por longitud: [a, a] no es [a, b] aunque midan lo mismo.
  if (selectedBrokerIds.length === 0) return true; // vacío = todos (igual que el insert)
  const selected = new Set(selectedBrokerIds);
  return allBrokerIds.every((id) => selected.has(id));
}
