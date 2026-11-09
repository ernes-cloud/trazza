/**
 * Decisión PURA de una alerta de Favoritos frente a la cotización actual.
 *
 * PRICE_TARGET es de UN disparo: al cruzar el objetivo avisa y queda
 * 'TRIGGERED' (cumplida) hasta que el usuario la reactive en Favoritos. Antes,
 * al dispararse, el cron guardaba el precio actual como nuevo `initial_price`
 * y la volvía a PENDING: con el precio ya pasado del objetivo, la alerta
 * pasaba a vigilar el sentido CONTRARIO, y una cotización que oscilaba
 * alrededor de 150 $ mandaba "alcanzó 150 $ (Sube)" y "cayó a 150 $ (Baja)"
 * cada día, para siempre.
 *
 * PERCENT_CHANGE es diaria por naturaleza ("avísame si se mueve un ±5 % en un
 * día"): sigue activa; el dedupe del cron la limita a un aviso por día.
 *
 * @param {{ alert_type: string, status?: string, target_value: number, initial_price?: number }} alert
 * @param {{ current?: number, percentChange?: number|null }} quote
 * @returns {null | { kind: 'price', upside: boolean, nextStatus: 'TRIGGERED' }
 *               | { kind: 'percent', change: number, target: number }}
 */
export function evaluateWatchlistAlert(alert, quote) {
  if (!alert || !quote) return null;

  if (alert.alert_type === 'PRICE_TARGET') {
    if (alert.status === 'TRIGGERED') return null; // cumplida: no se vuelve a mirar
    const price = Number(quote.current);
    const target = Number(alert.target_value);
    if (!Number.isFinite(price) || !Number.isFinite(target)) return null;
    const upside = Number(alert.initial_price) < target;
    if (upside ? price >= target : price <= target) return { kind: 'price', upside, nextStatus: 'TRIGGERED' };
    return null;
  }

  if (alert.alert_type === 'PERCENT_CHANGE') {
    const change = quote.percentChange;
    const target = Math.abs(Number(alert.target_value));
    if (change == null || !Number.isFinite(target) || Math.abs(change) < target) return null;
    return { kind: 'percent', change, target };
  }
  return null;
}
