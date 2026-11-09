/**
 * Mezcla las noticias de la cartera por activo, por rondas: la más reciente de
 * cada activo, luego la segunda de cada uno… Dentro de una ronda abre el activo
 * cuya noticia es más nueva.
 *
 * Ordenando solo por fecha, el activo con más titulares recientes se comía el
 * widget: en la demo las 6 noticias visibles eran de Apple.
 *
 * @template {{ ticker: string, datetime?: number }} T
 * @param {T[]} items
 * @returns {T[]}
 */
export function interleaveByTicker(items) {
  const byTicker = new Map();
  for (const item of items || []) {
    const list = byTicker.get(item.ticker) || [];
    byTicker.set(item.ticker, [...list, item]);
  }
  const queues = [...byTicker.values()].map((list) =>
    [...list].sort((a, b) => (b.datetime || 0) - (a.datetime || 0))
  );

  const out = [];
  for (let round = 0; queues.some((q) => q.length > round); round += 1) {
    const roundItems = queues
      .filter((q) => q.length > round)
      .map((q) => q[round])
      .sort((a, b) => (b.datetime || 0) - (a.datetime || 0));
    out.push(...roundItems);
  }
  return out;
}
