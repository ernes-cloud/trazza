// Tipos de cambio POR FECHA para el informe fiscal.
//
// Criterio AEAT: una operación en divisa se valora al tipo del día en que se
// hizo. En una venta, el valor de transmisión va al tipo del día de la VENTA y
// el de adquisición al tipo del día de CADA COMPRA (lote FIFO). Convertir el
// beneficio neto, o usar el tipo de hoy, da otra cifra.
//
// Reparto: `collectFxNeeds` dice qué pares (divisa, fecha) hacen falta,
// `preloadTaxRates` los trae (async, con pool) y `resolveRate` (puro, síncrono)
// elige el tipo de cada fila. buildTaxReport solo llama a resolveRate.
//
// Regla de oro: si no hay tipo para una fecha, la fila se queda FUERA de los
// totales con su motivo. Nunca se rellena con el tipo de hoy.

import { runPooled, DEFAULT_POOL_SIZE } from '../../lib/asyncPool.js';
import { commissionCurrency } from '../import/processedImportData.js';

/** Días hacia atrás que se aceptan para "el último día hábil anterior". */
export const MAX_FX_LOOKBACK_DAYS = 7;

const DAY_MS = 86400000;

/** 'DD-MM-YYYY' (pipeline) o 'YYYY-MM-DD[T…]' → 'YYYY-MM-DD'; '' si no se entiende. */
export function isoDayOf(fecha) {
  if (!fecha || typeof fecha !== 'string') return '';
  const parts = fecha.split('T')[0].split('-');
  if (parts.length < 3) return '';
  return parts[0].length === 4 ? parts.slice(0, 3).join('-') : [parts[2], parts[1], parts[0]].join('-');
}

const shiftIsoDay = (iso, days) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().split('T')[0];
};

const daysBetween = (fromIso, toIso) => {
  const p = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((p(toIso) - p(fromIso)) / DAY_MS);
};

/**
 * Tipo de cambio que trae el bróker en la propia operación, si sirve para
 * convertir `currency` a `preferredCurrency`.
 *
 * `transactions.fx_rate` es transaction_currency → EUR (COMMENT de la migración
 * 20260610), así que solo vale si la preferida es EUR y lo que se convierte es
 * la divisa de la propia fila (no, p. ej., una comisión facturada en EUR sobre
 * una acción en USD). A 2026-10 ningún parser lo rellena (ver docs/claude/finance.md).
 * @returns {number|null}
 */
export function brokerFxFor(row, currency, preferredCurrency = 'EUR') {
  if (preferredCurrency !== 'EUR') return null;
  if ((row?.moneda || 'EUR') !== currency) return null;
  const v = Number(row?.fxRate ?? row?.fx_rate);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Tipo `currency` → preferida para el día `date` ('YYYY-MM-DD').
 *
 * Prioridad: misma divisa (1) → fx del bróker → tabla precargada, con el día
 * pedido o el último anterior hasta MAX_FX_LOOKBACK_DAYS. Nunca un tipo con
 * fecha posterior; nunca el de hoy. Las entradas de `table[currency][día]`
 * pueden ser un número (tipo de ese día) o `{ rate, date }` (fecha real del
 * tipo, ≤ día), que es lo que guarda preloadTaxRates.
 *
 * @returns {{ rate: number, source: 'eur'|'broker'|'historical', rateDate: string }
 *         | { rate: null, reason: 'no_date'|'no_rate' }}
 */
export function resolveRate({ currency, date, preferredCurrency = 'EUR', brokerFx = null, table = {} }) {
  const cur = currency || 'EUR';
  if (cur === preferredCurrency) return { rate: 1, source: 'eur', rateDate: date };
  const bfx = Number(brokerFx);
  if (brokerFx != null && Number.isFinite(bfx) && bfx > 0) return { rate: bfx, source: 'broker', rateDate: date };
  if (!date) return { rate: null, reason: 'no_date' };

  const byDay = table?.[cur] || {};
  for (let back = 0; back <= MAX_FX_LOOKBACK_DAYS; back += 1) {
    const day = shiftIsoDay(date, -back);
    const entry = byDay[day];
    if (entry == null) continue;
    const rate = typeof entry === 'number' ? entry : Number(entry.rate);
    const rateDate = typeof entry === 'number' ? day : (entry.date || day);
    if (!Number.isFinite(rate) || rate <= 0) continue;
    const age = daysBetween(rateDate, date);
    if (age < 0 || age > MAX_FX_LOOKBACK_DAYS) continue; // posterior o demasiado viejo
    return { rate, source: 'historical', rateDate };
  }
  return { rate: null, reason: 'no_rate' };
}

/**
 * Pares (divisa, fecha ISO) que el informe necesita de la tabla histórica:
 * venta, cada lote FIFO, cada compra (la regla de los dos meses necesita el
 * coste de las de reposición, que aún no están en ningún lote), dividendos y
 * comisiones. Excluye lo que ya está en la preferida y lo que trae fx del
 * bróker. Ordenados y sin duplicados.
 */
export function collectFxNeeds({ sales = [], buys = [], dividends = [], commissions = [], preferredCurrency = 'EUR' } = {}) {
  const seen = new Map();
  const want = (currency, fecha, brokerFx) => {
    const cur = currency || 'EUR';
    const date = isoDayOf(fecha);
    if (!date || cur === preferredCurrency || brokerFx != null) return;
    const key = `${cur}|${date}`;
    if (!seen.has(key)) seen.set(key, { currency: cur, date });
  };

  for (const s of sales) {
    const cur = s.moneda || 'EUR';
    want(cur, s.fecha, brokerFxFor(s, cur, preferredCurrency));
    for (const lot of s.lots || []) {
      want(cur, lot.date, brokerFxFor({ moneda: cur, fxRate: lot.fxRate }, cur, preferredCurrency));
    }
  }
  for (const b of buys || []) {
    const cur = b.moneda || 'EUR';
    want(cur, b.fecha, brokerFxFor(b, cur, preferredCurrency));
  }
  for (const d of dividends) {
    const cur = d.moneda || 'EUR';
    want(cur, d.fecha, brokerFxFor(d, cur, preferredCurrency));
  }
  for (const c of commissions) {
    const cur = commissionCurrency(c);
    want(cur, c.fecha, brokerFxFor(c, cur, preferredCurrency));
  }

  return [...seen.values()].sort((a, b) =>
    a.currency.localeCompare(b.currency) || a.date.localeCompare(b.date));
}

/**
 * Trae los tipos de `needs` con concurrencia acotada (runPooled: nunca una
 * ráfaga contra Yahoo).
 *
 * @param {Array<{currency:string,date:string}>} needs
 * @param {object} opts
 * @param {(from:string,to:string,date:string)=>Promise<number|{rate:number,date:string}|null>} opts.getRate
 *   en la app: currencyService.getHistoricalRateOnOrBefore (día o hábil anterior).
 * @returns {Promise<{ table: object, errors: Array<{currency,date,error}> }>}
 */
export async function preloadTaxRates(needs = [], { getRate, preferredCurrency = 'EUR', concurrency = DEFAULT_POOL_SIZE } = {}) {
  if (typeof getRate !== 'function') throw new TypeError('preloadTaxRates: getRate es obligatorio');
  const unique = [...new Map(needs.map(n => [`${n.currency}|${n.date}`, n])).values()];
  const table = {};
  const errors = [];

  await runPooled(unique.map(({ currency, date }) => async () => {
    try {
      const got = await getRate(currency, preferredCurrency, date);
      const rate = typeof got === 'number' ? got : Number(got?.rate);
      if (!Number.isFinite(rate) || rate <= 0) return;
      const rateDate = typeof got === 'number' ? date : (got.date || date);
      if (!table[currency]) table[currency] = {};
      table[currency][date] = { rate, date: rateDate };
    } catch (error) {
      console.warn(`preloadTaxRates ${currency}→${preferredCurrency} @ ${date}`, error);
      errors.push({ currency, date, error });
    }
  }), concurrency);

  return { table, errors };
}
