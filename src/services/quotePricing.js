import { localTodayIso } from '../lib/dates.js';
/**
 * Quote-currency normalisation — shared by every surface that turns a live quote
 * into a position value (usePositions on the brokers screen, Dashboard).
 *
 * A quote's currency is NOT always the currency the position is stored in: the
 * same asset can be held on a European venue and settled in EUR while Yahoo
 * quotes it in USD (the GOOGL-on-DeGiro case). Multiplying that USD price by the
 * position's EUR rate measures the exchange rate, not the market — and writing it
 * into `assets.current_price` poisons the shared table for every other screen.
 *
 * Both rate maps are relative to the SAME preferred currency, so:
 *   price_in_toCur = raw × rate(fromCur) / rate(toCur)
 */

/**
 * Converts a raw quote price into the currency a position is stored in.
 *
 * @param {number} rawPrice price as reported by the quote provider
 * @param {string} fromCur  the quote's own currency (e.g. 'USD')
 * @param {string} toCur    the currency the position/asset is stored in
 * @param {Record<string, number>} rates currency → rate against the preferred currency
 * @returns {number} the price expressed in `toCur` (0 when the input is unusable)
 */
export function convertQuotePrice(rawPrice, fromCur, toCur, rates = {}) {
  const raw = typeof rawPrice === 'string' ? parseFloat(rawPrice) : rawPrice;
  if (!Number.isFinite(raw)) return 0;

  const from = (fromCur || '').toUpperCase();
  const to = (toCur || '').toUpperCase();
  if (!from || !to || from === to) return raw;

  const fromRate = Number(rates[from]);
  const toRate = Number(rates[to]);
  // A missing/zero rate would silently scale the price — leave it untouched
  // instead (the caller's plausibility guard still gates any DB write).
  if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || toRate === 0) return raw;

  return raw * fromRate / toRate;
}

/**
 * Día del precio de un FONDO cuando no es el de hoy ('YYYY-MM-DD'), o null.
 *
 * Yahoo publica el valor liquidativo de los fondos con 1-2 días de retraso: el
 * 15-oct-2026 el último NAV era del 13 y MyInvestor ya enseñaba otro, así que
 * los valores no cuadraban sin que nada lo explicara. La tabla lo rotula
 * ("VL 13 oct"). Las acciones no: cotizan en vivo y un cierre de viernes visto
 * en sábado no es un retraso.
 * @param {{ type?: string, marketTime?: number|null } | null} quote  marketTime en segundos Unix
 * @param {Date} [now]
 * @returns {string|null}
 */
export function stalePriceDate(quote, now = new Date()) {
  if (!quote || quote.type !== 'MUTUALFUND' || !quote.marketTime) return null;
  const day = localTodayIso(new Date(quote.marketTime * 1000));
  return day < localTodayIso(now) ? day : null;
}
