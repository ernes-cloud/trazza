// Gastos: materialización y proyección de los movimientos recurrentes.
// Partido desde services/expenseService.js (2026-10-04), que reexporta la API.

import { D, monthKeyToParts, nextMonthKey } from './internal.js';
import { monthKeyOf, occurrenceDateFor, isTemplate } from './entries.js';

/**
 * Occurrences that should exist but don't, for every ACTIVE monthly template,
 * from the template's entry_date month up to today's month (inclusive).
 * Pure and idempotent: feeding the returned rows back via existingEntries
 * yields []. Returns insert-ready rows (no id/user_id — the caller adds those).
 *
 * DOS claves de "este mes ya está resuelto", no una:
 *  1. `(recurring_source_id, source_month)` — la normal, la que fija el UNIQUE.
 *  2. Una fila HUÉRFANA idéntica (misma fecha, tipo, categoría e importe, sin
 *     `recurring_source_id`). Hace falta porque la FK de `recurring_source_id`
 *     es ON DELETE SET NULL: al borrar una plantilla, sus ocurrencias sobreviven
 *     con el enlace a NULL. Si el usuario volvía a crear el mismo recurrente, la
 *     clave 1 no casaba con nada y se materializaba OTRA copia de cada mes — el
 *     ingreso salía DOBLE en todo el historial (medido: 10.800 € → 21.600 €).
 *     El coste de equivocarse es asimétrico: no generar una ocurrencia que ya
 *     está escrita a mano no cambia ningún total, duplicarla los falsea todos.
 */
export function computeMissingOccurrences({ templates = [], existingEntries = [], today } = {}) {
  const todayKey = monthKeyOf(today);
  if (!todayKey) return [];

  const existing = new Set(
    existingEntries
      .filter((e) => e.recurring_source_id && e.source_month)
      .map((e) => `${e.recurring_source_id}|${e.source_month}`)
  );

  // Huellas de las filas sueltas (sin plantilla detrás): fecha+tipo+categoría+
  // importe. Ver la nota 2 de la cabecera.
  const orphanPrint = (row) => [
    (row.entry_date || '').split('T')[0],
    row.type,
    row.category || 'other',
    D(row.amount).toFixed(2),
  ].join('|');
  const orphans = new Set(
    existingEntries
      .filter((e) => !e.recurring_source_id && !isTemplate(e) && !e.skipped)
      .map(orphanPrint)
  );

  const missing = [];
  for (const tpl of templates) {
    if (!isTemplate(tpl) || tpl.recurrence_active === false) continue;
    const startKey = monthKeyOf(tpl.entry_date);
    if (!startKey || startKey > todayKey) continue;

    const day = tpl.recurrence_day || Number((tpl.entry_date || '').split('T')[0].slice(8, 10)) || 1;
    for (let mk = startKey; mk <= todayKey; mk = nextMonthKey(mk)) {
      if (existing.has(`${tpl.id}|${mk}`)) continue;
      const { year, month } = monthKeyToParts(mk);
      // End-date cut: no occurrence past recurrence_until (date-level, ISO compare)
      if (tpl.recurrence_until && occurrenceDateFor(year, month, day) > tpl.recurrence_until) break;
      const row = {
        type: tpl.type,
        category: tpl.category,
        amount: tpl.amount,
        currency: tpl.currency,
        entry_date: occurrenceDateFor(year, month, day),
        notes: tpl.notes || null,
        recurrence: 'none',
        recurring_source_id: tpl.id,
        source_month: mk,
      };
      // Ya hay una fila idéntica sin plantilla (típicamente una ocurrencia
      // huérfana de una plantilla borrada): no se duplica.
      if (orphans.has(orphanPrint(row))) continue;
      missing.push(row);
    }
  }
  return missing;
}

/** The template's occurrence date in (year, month), or null if it doesn't occur then. */
const templateOccurrenceInMonth = (tpl, year, month) => {
  if (!isTemplate(tpl) || tpl.recurrence_active === false) return null;
  const mk = `${year}-${String(month).padStart(2, '0')}`;
  const startKey = monthKeyOf(tpl.entry_date);
  if (!startKey || startKey > mk) return null;
  const day = tpl.recurrence_day || Number((tpl.entry_date || '').split('T')[0].slice(8, 10)) || 1;
  const date = occurrenceDateFor(year, month, day);
  if (tpl.recurrence_until && date > tpl.recurrence_until) return null;
  return date;
};

/** Signed monthly amount of a template if it occurs in (year, month), else null. */
export const templateNetForMonth = (tpl, year, month) => {
  if (!templateOccurrenceInMonth(tpl, year, month)) return null;
  const amount = D(tpl.amount);
  return tpl.type === 'income' ? amount : amount.neg();
};

/**
 * PSEUDO-entries for the recurring occurrences of (year, month) that are not
 * materialized (used to preview future months). Marked `projected: true` and
 * given a synthetic id — they are display-only, never inserted.
 */
export function computeProjectedOccurrences({ templates = [], existingEntries = [], year, month } = {}) {
  const mk = `${year}-${String(month).padStart(2, '0')}`;
  const existing = new Set(
    existingEntries
      .filter((e) => e.recurring_source_id && e.source_month)
      .map((e) => `${e.recurring_source_id}|${e.source_month}`)
  );
  const projected = [];
  for (const tpl of templates) {
    const date = templateOccurrenceInMonth(tpl, year, month);
    if (!date || existing.has(`${tpl.id}|${mk}`)) continue;
    projected.push({
      id: `projected-${tpl.id}-${mk}`,
      type: tpl.type,
      category: tpl.category,
      amount: tpl.amount,
      currency: tpl.currency,
      entry_date: date,
      notes: tpl.notes || null,
      recurrence: 'none',
      recurring_source_id: tpl.id,
      source_month: mk,
      projected: true,
    });
  }
  return projected;
}
