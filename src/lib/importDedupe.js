/**
 * Dedupe key for imported CSV transactions vs rows already stored in Supabase.
 *
 * Normalized to the DB's physical storage:
 *  - `price` has scale 2 → a CSV price of 556.4886 is STORED as 556.49, so both
 *    sides are compared with .toFixed(2) (raw comparison made re-imports duplicate).
 *  - FEE/TAX/DIVIDEND/CASH/TRANSFER rows (qty=0, price=0) need amount + concept to
 *    disambiguate (e.g. four 2.50€ connectivity fees on the same day differ only
 *    by their description).
 *
 * IMPORTANT: the SELECT that loads existing rows MUST include every field used
 * here (`total_amount` included) — a missing field makes the "existing" side of
 * the key differ from the CSV side and every re-import duplicates those rows.
 */
export const DEDUPE_SELECT_FIELDS =
  'id, transaction_date, transaction_type, quantity, price, total_amount, position_id, eur_total, notes, commission, transaction_currency';

// Postgres may return timestamptz as "2026-03-26T17:09:00+00:00" (or with
// milliseconds) while the client inserts "2026-03-26T17:09:00" — keep only
// "YYYY-MM-DDTHH:MM:SS" so both sides of the key always compare equal.
const normDate = (d) => String(d || '').slice(0, 19);

/**
 * Existing-rows index for buildTransactionRows: key → ARRAY of stored rows.
 * A MULTISET, not a set: a DeGiro order can execute in several partial fills
 * of identical qty/price within the same minute — N identical CSV rows are N
 * real trades and must match N stored rows (a unique-key map silently dropped
 * every fill after the first, halving the cost basis).
 */
export function buildExistingTransMap(existingRows) {
  const map = new Map();
  for (const t of existingRows || []) {
    const key = transCheckKey(t);
    const entry = {
      id: t.id,
      eur_total: t.eur_total,
      notes: t.notes,
      commission: t.commission,
      transaction_currency: t.transaction_currency,
    };
    if (map.has(key)) map.get(key).push(entry);
    else map.set(key, [entry]);
  }
  return map;
}

export function transCheckKey(t) {
  const type = t.transaction_type;
  const date = normDate(t.transaction_date);
  if (type === 'BUY' || type === 'SELL') {
    return `${date}_${type}_${Number(t.quantity || 0).toFixed(4)}_${Number(t.price || 0).toFixed(2)}_${t.position_id}`;
  }
  const amt = Math.abs(Number(t.total_amount || 0)).toFixed(2);
  // 80 chars, not 30: DeGiro's connectivity fees only differ AFTER char 30
  // ("Comisión de conectividad con el mercado 2026 (London… / Nasdaq…)") —
  // the shorter slice collapsed five same-day 2.50€ fees into ONE key,
  // silently dropping four of them on first import.
  const concept = String(t.notes || '').slice(0, 80);
  return `${date}_${type}_${amt}_${concept}_${t.position_id}`;
}

/**
 * Preview-side dedupe key (CSV row shape / DB row transformed by loadPositions —
 * fecha DD-MM-YYYY + hora, not the raw DB columns transCheckKey uses).
 * Same normalizations: price at 2 decimals (DB scale-2), qty at 4.
 */
export function previewTxKey(t) {
  if (t.type === 'BUY' || t.type === 'SELL') {
    return `${t.fecha}_${(t.hora || '').substring(0, 5)}_${t.type}_${t.isin || t.producto || ''}_${Math.abs(parseFloat(t.cantidad || 0)).toFixed(4)}_${parseFloat(t.precio || 0).toFixed(2)}`;
  }
  // FEE/TAX rows: producto differs between DB (cash-position ticker) and CSV
  // (description-based), so key on amount + concept instead.
  if (t.type === 'FEE' || t.type === 'FEES' || t.type === 'TAX') {
    const amt = Math.abs(parseFloat(t.total ?? t.total_amount ?? 0)).toFixed(2);
    const concept = String(t.descripcion || t.notes || '').slice(0, 30);
    return `${t.fecha}_${t.type}_${amt}_${concept}`;
  }
  return `${t.fecha}_${(t.hora || '').substring(0, 5)}_${t.type}_${t.isin || t.producto || ''}_${Math.abs(parseFloat(t.cantidad || 0)).toFixed(4)}`;
}

/**
 * CSV rows NOT already persisted in the DB, as a MULTISET match: each stored
 * row consumes exactly ONE identical CSV row, and surplus identical CSV rows
 * SURVIVE. A unique-key Set treated N identical partial fills as one: with a
 * DB damaged by the old single-insert dedupe (1 stored fill of 2), BOTH CSV
 * fills matched the single stored key and were dropped, so netBuys undercounted
 * the position and the re-sync self-repair never converged (Enric's Amazon/MA:
 * qty 2 with ONE fill's cost basis → G/P Moneda absorbed the missing half as a
 * fake +186% FX gain).
 */
export function csvRowsNotInDb(csvRows, dbRows) {
  const counts = new Map();
  for (const t of dbRows || []) {
    const key = previewTxKey(t);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return (csvRows || []).filter(t => {
    const key = previewTxKey(t);
    const left = counts.get(key) || 0;
    if (left > 0) {
      counts.set(key, left - 1);
      return false;
    }
    return true;
  });
}
