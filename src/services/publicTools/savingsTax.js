/**
 * Escala de la base del ahorro del IRPF — PURA, compartida por las
 * calculadoras públicas.
 *
 * Tramos de la Renta de 2025 (la que se presenta en 2026), contrastados el
 * 2026-10-04 con la Agencia Tributaria: el último tramo pasó del 28 % al 30 %
 * desde el 1 de enero de 2025. Si cambian, se cambian AQUÍ y en el texto de las
 * páginas que los citan (claves `div_calc.*` de i18n).
 */

import Decimal from 'decimal.js';

export const TAX_YEAR = 2025;

/** [hasta, tipo] — `Infinity` en el último tramo. */
export const SAVINGS_BRACKETS = [
  [6000, 0.19],
  [50000, 0.21],
  [200000, 0.23],
  [300000, 0.27],
  [Infinity, 0.30],
];

/** Cuota de la base del ahorro para una base dada (por tramos, no un tipo plano). */
export function savingsTax(base) {
  let rest = new Decimal(Math.max(0, Number(base) || 0));
  let prevTop = new Decimal(0);
  let tax = new Decimal(0);
  for (const [top, rate] of SAVINGS_BRACKETS) {
    if (rest.lte(0)) break;
    const width = top === Infinity ? rest : Decimal.min(rest, new Decimal(top).minus(prevTop));
    tax = tax.plus(width.times(rate));
    rest = rest.minus(width);
    prevTop = new Decimal(top === Infinity ? 0 : top);
  }
  return tax.toNumber();
}

/**
 * Cuota que corresponde a `amount` cuando se suma a una base previa `otherBase`
 * (lo que sube el impuesto por esa renta, no un tipo medio).
 */
export function incrementalSavingsTax(amount, otherBase = 0) {
  const other = Math.max(0, Number(otherBase) || 0);
  return new Decimal(savingsTax(other + Math.max(0, Number(amount) || 0))).minus(savingsTax(other)).toNumber();
}
