/**
 * Coalescencia de peticiones EN VUELO.
 *
 * Si dos widgets piden lo mismo a la vez, sale UNA sola petición y ambos
 * esperan a la misma promesa. En la consola del owner se veía literalmente
 * duplicado: `yahoo-profile/AMZN?modules=calendarEvents` pedido dos veces, y lo
 * mismo con GOOGL, META, MSFT y CSU.TO — el calendario de resultados y su
 * monitor preguntan por los mismos tickers en el mismo instante.
 *
 * NO es una caché: la entrada se borra en cuanto la promesa se asienta, así que
 * no congela ningún dato. Es exactamente lo que permite quitar peticiones sin
 * tocar la frescura de lo que se enseña (Wallet Map y seguimiento de cartera
 * siguen pidiendo en vivo; lo que desaparece es pedir DOS VECES lo mismo).
 */
const inFlight = new Map();

export function coalesce(key, fn) {
  if (inFlight.has(key)) return inFlight.get(key);
  const p = (async () => fn())().finally(() => {
    // Se limpia SIEMPRE, también si falló: un error no debe quedar memorizado.
    inFlight.delete(key);
  });
  inFlight.set(key, p);
  return p;
}

/** Sólo para tests. */
export function _inFlightSize() { return inFlight.size; }
