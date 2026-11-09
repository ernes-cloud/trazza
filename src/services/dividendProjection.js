/**
 * Proyección de dividendos del AÑO EN CURSO para el widget "Próximos dividendos".
 *
 * Hasta el 2026-10-15 la cifra "2026 (est.)" era lo cobrado este año MÁS el
 * dividendo anual completo (los próximos 12 meses): a mitad de octubre contaba
 * casi un año de más. Aquí solo entran los pagos cuyo ex-dividendo cae entre hoy
 * y el 31 de diciembre. Se cuenta por fecha EX: es la que da derecho al cobro
 * (el pago puede caer ya en enero).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PAYMENTS_PER_YEAR = 4; // lo habitual cuando el proveedor no da el importe por pago
const MAX_PAYMENTS_PER_YEAR = 12;

/** 'YYYY-MM-DD…' → fecha LOCAL (sin el desfase de zona de `new Date('YYYY-MM-DD')`). */
const parseLocalDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Pagos al año que implica el par importe/anual (1 = anual … 12 = mensual). */
const paymentsPerYear = ({ amount, annualDividend }) => {
  if (!(amount > 0) || !(annualDividend > 0)) return DEFAULT_PAYMENTS_PER_YEAR;
  return Math.min(MAX_PAYMENTS_PER_YEAR, Math.max(1, Math.round(annualDividend / amount)));
};

/**
 * Cuántos ex-dividendos de este evento caen entre hoy y el 31 de diciembre.
 * Un ex-div ya pasado se adelanta por su frecuencia hasta el siguiente.
 * @param {{ exDate?: string|null, amount?: number|null, annualDividend?: number|null }} ev
 * @param {Date} [today]
 * @returns {number}
 */
export function remainingPaymentsThisYear(ev, today = new Date()) {
  const first = parseLocalDate(ev?.exDate);
  if (!first) return 0;
  const from = startOfDay(today);
  const endOfYear = new Date(from.getFullYear(), 11, 31);
  const intervalMs = (365 / paymentsPerYear(ev)) * DAY_MS;

  let next = first;
  while (next < from) next = new Date(next.getTime() + intervalMs);
  let count = 0;
  while (next <= endOfYear) {
    count += 1;
    next = new Date(next.getTime() + intervalMs);
  }
  return count;
}

/**
 * Dividendo POR ACCIÓN que falta por cobrar este año (en la divisa del evento).
 * Sin fecha ex-div pero con anual, se prorratea por los días que quedan.
 * @param {{ exDate?: string|null, amount?: number|null, annualDividend?: number|null }} ev
 * @param {Date} [today]
 * @returns {number}
 */
export function projectedPerShareThisYear(ev, today = new Date()) {
  const perPayment = ev?.amount > 0
    ? ev.amount
    : ev?.annualDividend > 0 ? ev.annualDividend / paymentsPerYear(ev) : 0;
  if (parseLocalDate(ev?.exDate)) return remainingPaymentsThisYear(ev, today) * perPayment;
  if (!(ev?.annualDividend > 0)) return 0;
  const from = startOfDay(today);
  // Hoy incluido: el 31 de diciembre queda 1 día, no 0.
  const daysLeft = Math.round((new Date(from.getFullYear(), 11, 31) - from) / DAY_MS) + 1;
  return ev.annualDividend * (daysLeft / 365);
}
