/**
 * Clave con la que se agrupan las posiciones de VARIOS brokers en una sola fila
 * ("vista general"): la misma acción comprada en DeGiro y en IBKR es UNA línea.
 *
 * Es la ÚNICA definición: la usan la pantalla de brokers (usePositions) y el
 * rebalanceo (rebalanceService). Antes cada una tenía la suya y discrepaban:
 * el rebalanceo agrupaba por `isin || ticker`, y el parser de IBKR solo saca el
 * ISIN de las descripciones de DIVIDENDOS, así que un valor que no paga dividendo
 * (Amazon, Booking, Uber) se guardaba con ISIN vacío y ticker `AMZN (USD)`,
 * mientras DeGiro lo guarda con su ISIN. Brokers los juntaba (resuelve ambos a
 * `AMZN`) y el rebalanceo los enseñaba como dos activos con dos targets.
 *
 * Regla: el ticker de cotización resuelto (por ISIN si lo hay, si no por el
 * ticker guardado sin el sufijo de divisa), con el ISIN o el id como último
 * recurso. La liquidez NO pasa por aquí: va por divisa (CASH_EUR ≠ CASH_USD).
 *
 * @param {{ assets?: { isin?: string, ticker?: string }, asset_id?: string, id?: string }} position
 * @param {{ tickerMap: Record<string,string>, resolveTicker: (t: string) => string|null,
 *           dynamicTickerMap?: Record<string,string> }} deps
 * @returns {string}
 */
export function positionGroupKey(position, { tickerMap, resolveTicker, dynamicTickerMap = {} }) {
  const resolve = (t) => {
    if (!t) return null;
    // Quita etiquetas "[importe]" de los fondos monetarios y el sufijo " (USD)".
    const clean = t.replace(/\s*\[.*?\]/g, '').replace(/\s*\([A-Z]{3}\)$/i, '').trim();
    if (!clean) return null;
    return tickerMap[clean.toUpperCase()] || dynamicTickerMap[clean] || resolveTicker(clean) || null;
  };
  const assets = position?.assets || {};
  return resolve(assets.isin) || resolve(assets.ticker) || assets.isin || position?.asset_id || position?.id;
}
