/**
 * Divisa en la que se enseña la cartera.
 *
 * UNA sola definición del valor por defecto. Antes había cuatro y no
 * coincidían: la barra lateral y Rebalancear caían a EUR, pero el Dashboard y
 * Brokers a USD, así que una cuenta recién creada (sin fila de preferencias)
 * veía "0,00 US$" en Brokers. Trazza es para brokers europeos: EUR.
 */
export const DEFAULT_CURRENCY = 'EUR';

/** @param {{ preferred_currency?: string|null }|null|undefined} prefs */
export function preferredCurrencyOf(prefs) {
  const c = String(prefs?.preferred_currency || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : DEFAULT_CURRENCY;
}
