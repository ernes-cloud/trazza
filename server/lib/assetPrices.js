/**
 * Precio de la tabla COMPARTIDA `assets` — lo escribe solo el server.
 *
 * Hasta el 2026-10-26 lo escribía el navegador de cada usuario con la RPC
 * `update_asset_market_data`, ejecutable por `authenticated`: cualquier cuenta
 * gratis podía poner AAPL a 0,01 desde la consola y esa cifra valoraba las
 * carteras compartidas, servía de reserva al snapshot diario y era el punto de
 * partida de todos los clientes (auditoría 7f2c915d, A1). Ahora la RPC es solo
 * de service role y el ÚNICO escritor es el cron de snapshots, que ya trae las
 * cotizaciones de todas las posiciones una vez por hora.
 *
 * Mismas reglas que tenía el cliente, en una sola definición:
 *  - el precio de la cotización se pasa a la divisa del asset (`convertQuotePrice`);
 *    si falta uno de los dos tipos de cambio NO se escribe (el cliente lo dejaba
 *    pasar sin convertir y confiaba en el guard);
 *  - `isPlausiblePriceUpdate` frena los desplomes (÷100, divisa cruzada). La RPC
 *    repite esa comprobación en SQL: es la defensa que no depende de este código.
 */

import { convertQuotePrice } from '../../src/services/quotePricing.js';
import { isPlausiblePriceUpdate } from '../../src/services/priceGuard.js';
import { isCashPosition } from '../../src/lib/positionKind.js';

/**
 * Escrituras de precio a partir de una pasada de cotizaciones. Puro.
 *
 * @param {Array} positions filas { assets: { id, ticker, currency, current_price, asset_class } }
 * @param {Map} quotes símbolo Yahoo → { current, currency } (peniques ya normalizados)
 * @param {Record<string, number>} ratesToEur divisa → valor en EUR de 1 unidad
 * @param {(ticker: string) => string|null} symbolFor símbolo Yahoo de un assets.ticker
 * @returns {{ writes: Array<{ assetId, ticker, price }>, implausible: Array<{ assetId, ticker, stored, price }> }}
 */
export function planAssetPriceWrites(positions, quotes, ratesToEur, symbolFor) {
  const writes = [];
  const implausible = [];
  const seen = new Set();
  for (const p of positions || []) {
    const a = p?.assets;
    if (!a?.id || seen.has(a.id) || isCashPosition({ assets: a })) continue;
    seen.add(a.id);

    const symbol = symbolFor(a.ticker);
    const quote = symbol ? quotes.get(symbol) : null;
    const raw = Number(quote?.current);
    if (!(raw > 0) || !Number.isFinite(raw)) continue;

    const assetCur = String(a.currency || 'EUR').toUpperCase();
    const quoteCur = String(quote.currency || assetCur).toUpperCase();
    if (quoteCur !== assetCur && !(ratesToEur[quoteCur] > 0 && ratesToEur[assetCur] > 0)) continue;

    const price = convertQuotePrice(raw, quoteCur, assetCur, ratesToEur);
    if (!(price > 0) || !Number.isFinite(price)) continue;

    if (!isPlausiblePriceUpdate(a.current_price, price)) {
      implausible.push({ assetId: a.id, ticker: a.ticker, stored: a.current_price, price });
      continue;
    }
    writes.push({ assetId: a.id, ticker: a.ticker, price });
  }
  return { writes, implausible };
}

/**
 * Aplica las escrituras con la RPC (cliente de service role). Secuencial: son
 * decenas de filas por hora, no merece una ráfaga contra PostgREST.
 * La RPC devuelve false cuando su propio guard rechaza el precio.
 *
 * @returns {Promise<{ written: number, rejected: number, failed: number }>}
 */
export async function writeAssetPrices(client, writes) {
  let written = 0;
  let rejected = 0;
  let failed = 0;
  for (const w of writes) {
    const { data, error } = await client.rpc('update_asset_market_data', {
      p_asset_id: w.assetId,
      p_current_price: w.price,
    });
    if (error) {
      failed += 1;
      console.warn(`[assetPrices] ${w.ticker}: ${error.message}`);
    } else if (data === false) {
      rejected += 1;
    } else {
      written += 1;
    }
  }
  return { written, rejected, failed };
}
