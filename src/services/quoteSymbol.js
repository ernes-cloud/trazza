/**
 * El símbolo con el que se COTIZA un activo guardado, o null si no se cotiza.
 *
 * Una sola definición para la pantalla de brokers (`usePositions`) y el
 * Dashboard (`useDashboardData`). Hasta el 2026-10-09 el Dashboard solo pasaba
 * el ticker por `resolveTicker`, que deja el nombre del fondo tal cual
 * ("VANGUARD 20"): con espacios no se cotiza, así que el Wallet Map de una
 * cartera de MyInvestor salía entera en gris y con "—", mientras brokers sí
 * tenía precio para los mismos fondos.
 *
 * Orden de prioridad (lo curado manda sobre lo adivinado):
 *   1. Fondo monetario `[importe]` → null: vale 1 por unidad y la cantidad son
 *      euros; quitar los corchetes dejaría el nombre y lo curado lo cotizaría.
 *   2. TICKER_MAP estático (ISINs curados).
 *   3. Símbolo curado del fondo (`curatedSymbolForFundName`).
 *   4. Mapa persistido del import (`imported_data.ticker_map`).
 *   5. `resolveTicker` (traducción de MIC o el propio ticker limpio).
 *
 * @param {string} ticker            `assets.ticker` tal cual está guardado
 * @param {Record<string,string>} [dynamicTickerMap]  nombre del extracto → símbolo
 * @returns {string|null}
 */
import { resolveTicker, TICKER_MAP } from '@/lib/tickerMap';
import { curatedSymbolForFundName, curatedProxyForFundName } from '@/services/import/fundNavEnricher';
import { isMonetaryAssetTicker } from '@/services/import/assetIdentity';

export function resolveQuoteSymbol(ticker, dynamicTickerMap = {}) {
  if (!ticker || isMonetaryAssetTicker(ticker)) return null;
  const clean = ticker.replace(/\s*\[.*?\]/g, '').replace(/\s*\([A-Z]{3}\)$/i, '').trim();
  // Excepción al "lo curado manda": si el import valoró el fondo con su proxy
  // USD curado, las unidades salieron de ESE NAV y el precio también tiene que
  // salir de él. Cotizar la clase curada mezclaría clases en la posición.
  const persisted = dynamicTickerMap?.[clean];
  if (persisted && persisted === curatedProxyForFundName(clean)) return persisted;
  return TICKER_MAP[clean.toUpperCase()]
    || curatedSymbolForFundName(clean)
    || dynamicTickerMap?.[clean]
    || resolveTicker(clean);
}

/** ¿Hay un símbolo que un proveedor pueda cotizar? Uno con espacios es un nombre. */
export const isQuotableSymbol = (symbol) => !!symbol && !/\s/.test(symbol);

/** Une los `ticker_map` de varias filas de `imported_data`. */
export function mergeTickerMaps(importedDataRows) {
  return (importedDataRows || []).reduce(
    (acc, row) => (row?.ticker_map ? { ...acc, ...row.ticker_map } : acc),
    {},
  );
}
