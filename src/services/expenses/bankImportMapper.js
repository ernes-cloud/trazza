/**
 * BankMovement[] → expense_entries rows, with re-import dedupe.
 *
 * Pure module: no Supabase, no React, no clock. The caller supplies the set of
 * import keys already stored and receives the rows to insert.
 *
 * ── The dedupe is a MULTISET, and that is not a detail ──────────────────────
 * Bank statements overlap by design (you download "last 3 months" every month),
 * so re-import safety is mandatory. But two identical rows are usually TWO real
 * movements: the measured BBVA export has 16 groups of same-day/same-amount/
 * same-merchant rows — 22 rows that a Set-based dedupe would silently eat. It
 * is the exact bug that halved cost basis in the broker importer.
 *
 * The trick: the key carries an OCCURRENCE ORDINAL. Two identical movements
 * get `…|0` and `…|1`, so both are inserted the first time and both match on
 * the second import. Deterministic, no crypto, no ambiguity.
 */

import { categorizeMerchant } from './merchantRules.js';

/** Concept slice length — same 80 chars as the broker dedupe, same reason:
 *  bank concepts for recurring same-amount charges differ only near the end. */
const CONCEPT_SLICE = 80;

const keyText = (s) => String(s ?? '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, CONCEPT_SLICE);

/**
 * Stable identity of one imported movement.
 * `ordinal` distinguishes genuinely identical movements (see the multiset note).
 * `suffix` separates a row's fee from the movement it was charged on.
 */
export function buildImportKey(movement, bank, ordinal = 0, suffix = '') {
  const parts = [
    bank,
    movement.date,
    Number(movement.amount).toFixed(2),
    keyText(movement.merchant || movement.concept),
    keyText(movement.detail),
    ordinal,
  ];
  return parts.join('|') + (suffix ? `|${suffix}` : '');
}

/** Assigns each movement its occurrence ordinal among identical siblings. */
function withOrdinals(classified, bank) {
  const seen = new Map();
  return classified.map((entry) => {
    const base = buildImportKey(entry.movement, bank, 0);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { ...entry, ordinal: n };
  });
}

/**
 * expense_entries row. Follows `buildEntryRow`'s rule: a column is only sent
 * when it has a value, so a database that has not run the migration yet fails
 * on nothing rather than rejecting the whole insert.
 */
function toRow({ movement, intent, ordinal }, { userId, bank, defaultCurrency }) {
  const amount = Math.abs(Number(movement.amount));
  const category = categorizeMerchant(movement.merchant, intent, movement.detail) || 'other';
  const row = {
    user_id: userId,
    type: intent,
    category,
    amount,
    currency: movement.currency || defaultCurrency || 'EUR',
    entry_date: movement.date,
    recurrence: 'none',
    recurrence_active: true,
  };
  const notes = movement.merchant || movement.concept;
  if (notes) row.notes = notes;
  row.merchant = movement.merchant || null;
  row.source = 'bank_import';
  row.import_key = buildImportKey(movement, bank, ordinal);
  return row;
}

/** A fee charged alongside a movement is its own expense, never folded in. */
function toFeeRow({ movement, ordinal }, { userId, bank, defaultCurrency }) {
  return {
    user_id: userId,
    type: 'expense',
    category: 'other',
    amount: Math.abs(Number(movement.fee)),
    currency: movement.currency || defaultCurrency || 'EUR',
    entry_date: movement.date,
    recurrence: 'none',
    recurrence_active: true,
    notes: movement.merchant || movement.concept,
    merchant: movement.merchant || null,
    source: 'bank_import',
    import_key: buildImportKey(movement, bank, ordinal, 'fee'),
  };
}

/**
 * @param {{movement, intent, reason, needsReview}[]} classified
 * @param {object} options
 * @param {string} options.userId
 * @param {string} options.bank
 * @param {Set<string>} [options.existingKeys]  import_key values already stored
 * @param {string} [options.defaultCurrency]
 * @param {Set<number>} [options.excludedIndexes]  rows the user unticked
 * @returns {{ rows, duplicates, ignored, included }}
 */
export function buildBankImportPlan(classified = [], options = {}) {
  const { existingKeys = new Set(), excludedIndexes = new Set() } = options;
  const withOrd = withOrdinals(classified, options.bank);

  const rows = [];
  let duplicates = 0;
  let ignored = 0;

  withOrd.forEach((entry, index) => {
    if (entry.intent === 'ignore' || excludedIndexes.has(index)) {
      ignored += 1;
      return;
    }

    const candidates = [toRow(entry, options)];
    if (Number(entry.movement.fee)) candidates.push(toFeeRow(entry, options));

    for (const row of candidates) {
      if (existingKeys.has(row.import_key)) duplicates += 1;
      else rows.push(row);
    }
  });

  return { rows, duplicates, ignored, included: rows.length };
}

/**
 * Preview shape for the review table: one entry per movement with everything
 * the UI needs, so the component computes nothing financial itself.
 */
export function buildPreviewRows(classified = [], options = {}) {
  const withOrd = withOrdinals(classified, options.bank);
  const existingKeys = options.existingKeys ?? new Set();
  return withOrd.map((entry, index) => {
    const key = buildImportKey(entry.movement, options.bank, entry.ordinal);
    return {
      index,
      date: entry.movement.date,
      merchant: entry.movement.merchant || entry.movement.concept,
      detail: entry.movement.detail,
      amount: entry.movement.amount,
      fee: entry.movement.fee || 0,
      currency: entry.movement.currency,
      kind: entry.movement.kind,
      intent: entry.intent,
      reason: entry.reason,
      needsReview: entry.needsReview,
      category: categorizeMerchant(entry.movement.merchant, entry.intent, entry.movement.detail) || 'other',
      isDuplicate: existingKeys.has(key),
      importKey: key,
    };
  });
}
