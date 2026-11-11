// Gastos: categorías, importes, fechas y forma de una fila de expense_entries.
// Partido desde services/expenseService.js (2026-10-04), que reexporta la API.

import Decimal from 'decimal.js';
import { D, monthKeyToParts } from './internal.js';
import {
  convertExpenseAmount,
  convertEntryForAggregate,
  attachExclusions,
  excludedShape,
} from './fx.js';

export const EXPENSE_CATEGORIES = [
  'housing', 'groceries', 'restaurants', 'transport', 'utilities', 'subscriptions',
  'health', 'leisure', 'shopping', 'travel', 'education', 'taxes', 'other',
];

export const INCOME_CATEGORIES = [
  'salary', 'freelance', 'rental', 'gift', 'other',
];

// Predefined slugs have an i18n key `expenses.cat_<slug>`; user-defined custom
// categories are stored by their display name and have none. `investment_income`
// is kept here (legacy) so old entries still resolve after it left the pickers.
const KNOWN_CATEGORIES = new Set([...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES, 'investment_income']);

/** Display label for a category: i18n for predefined slugs, raw name for custom ones. */
export function categoryLabel(t, category) {
  const cat = category || 'other';
  return KNOWN_CATEGORIES.has(cat) ? t(`expenses.cat_${cat}`) : cat;
}

/** True for the built-in slugs (used to decide i18n vs raw rendering). */
export function isKnownCategory(category) {
  return KNOWN_CATEGORIES.has(category);
}

/**
 * Parses a money amount typed by a human. `<input type="number">` is NOT usable
 * here: the HTML spec only accepts a DOT decimal separator, so a Spanish user
 * typing "12,50" gets an empty value and an "invalid amount" error. Every money
 * field in this module is a text input parsed through this function instead.
 * Accepts "1.234,56" (ES), "1,234.56" (EN), "12.5", "12,5"; → null if invalid.
 */
export function parseAmountInput(raw) {
  const s = String(raw ?? '').trim().replace(/\s| |€|\$|£/g, '');
  if (s === '') return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let normalized;
  if (lastComma === -1 && lastDot === -1) {
    normalized = s;
  } else if (lastComma > lastDot) {
    // Comma is the decimal separator → dots are thousands separators
    normalized = s.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma) {
    normalized = s.replace(/,/g, '');
  } else {
    normalized = s;
  }
  if (!/^-?\d*\.?\d*$/.test(normalized)) return null;
  const value = parseFloat(normalized);
  return Number.isFinite(value) ? value : null;
}

// Vive en lib/dates.js (lo usa también la cartera); se reexporta aquí para no
// tocar los imports de Gastos que ya existían.
export { localTodayIso } from '../../lib/dates.js';

/**
 * Currencies present in the entries that differ from the display currency.
 * Amounts are stored per-row in `expense_entries.currency` but every aggregation
 * here sums them RAW — mixing them would silently add euros to dollars. The UI
 * uses this to warn instead of showing a wrong total.
 * → sorted array of currency codes (empty when everything matches).
 */
export function detectForeignCurrencies(entries = [], displayCurrency = 'EUR') {
  const found = new Set();
  for (const e of entries) {
    const cur = (e?.currency || '').toUpperCase();
    if (cur && cur !== String(displayCurrency).toUpperCase()) found.add(cur);
  }
  return [...found].sort();
}

/**
 * Groups movements by day for the list view, newest day first.
 * → [{ day: 'YYYY-MM-DD', rows, net }] — `net` in Decimal arithmetic, because
 * the float version (`net += ±amount`) produced -0.30000000000000004 subtotals.
 */
export function computeDayGroups(rows = [], opts = {}) {
  const fxOpts = { preferredCurrency: opts.preferredCurrency, rates: opts.rates || {} };
  const byDay = new Map();
  const allExcluded = [];

  for (const row of rows) {
    const day = (row.entry_date || '').split('T')[0];
    if (!byDay.has(day)) byDay.set(day, { day, rows: [], net: new Decimal(0), excluded: [] });
    const group = byDay.get(day);
    group.rows.push(row);

    const conv = convertEntryForAggregate(row, fxOpts);
    if (!conv.convertible) {
      const ex = excludedShape(row);
      group.excluded.push(ex);
      allExcluded.push(ex);
      continue;
    }
    const amount = new Decimal(conv.value);
    group.net = row.type === 'income' ? group.net.plus(amount) : group.net.minus(amount);
  }

  const groups = [...byDay.values()]
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .map((g) => {
      const base = { day: g.day, rows: g.rows, net: g.net.toNumber() };
      return g.excluded.length ? attachExclusions(base, g.excluded) : base;
    });

  if (allExcluded.length) return attachExclusions(groups, allExcluded);
  return groups;
}

/** 'YYYY-MM-DD' (or ISO with T) → 'YYYY-MM'; null if unknown. */
export function monthKeyOf(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const day = dateStr.split('T')[0];
  const parts = day.split('-');
  if (parts.length < 2 || parts[0].length !== 4) return null;
  return `${parts[0]}-${parts[1]}`;
}

/** Day-of-month clamped to the month's length (31 → 28/29 in Feb) → 'YYYY-MM-DD'. */
export function occurrenceDateFor(year, month, day) {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const clamped = Math.min(Math.max(1, day || 1), daysInMonth);
  return `${year}-${String(month).padStart(2, '0')}-${String(clamped).padStart(2, '0')}`;
}

/** Template rows drive recurrence and are excluded from every aggregation. */
export function isTemplate(entry) {
  return entry?.recurrence === 'monthly';
}

/**
 * ISO 'YYYY-MM-DD' of the LAST day of the given date's month (today by default).
 * The category-breakdown range ends here (not on "today") so a current-month
 * recurring occurrence dated later in the month — e.g. an autónomo payment on
 * the 28th viewed on the 20th — is still counted.
 */
export function endOfMonthIso(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth(); // 0-based
  const lastDay = new Date(year, month + 1, 0).getDate();
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

/**
 * Form payload → the `expense_entries` row to insert. Shared by every surface
 * that creates a movement (the expenses screen's hook and the Dashboard's quick
 * dialog) so the recurrence rules live in exactly one place.
 *
 * `recurrence_until` is only ADDED when set: sending a null for a column that a
 * DB without the migration doesn't have fails the whole insert.
 */
export function buildEntryRow(payload = {}, userId) {
  const { recurring, recurrence_day, recurrence_until, project_id, ...fields } = payload;
  const row = {
    ...fields,
    user_id: userId,
    recurrence: recurring ? 'monthly' : 'none',
    recurrence_day: recurring
      ? (recurrence_day || Number(String(fields.entry_date || '').slice(8, 10)) || 1)
      : null,
    recurrence_active: true,
  };
  if (recurring && recurrence_until) row.recurrence_until = recurrence_until;
  // Igual que recurrence_until: solo se manda cuando tiene valor. Enviar un null
  // para una columna que una BD sin migrar no tiene tumba el insert ENTERO.
  if (project_id) row.project_id = project_id;
  return row;
}

/**
 * CSV export of one year (Spanish Excel dialect: ';' separator, comma decimals):
 * the movement list plus a category × month expense matrix. `labels` carries
 * the translated strings so the module stays i18n-agnostic:
 * { date, type, category, amount, currency, converted?, notConvertible?, notes, income, expense, total, monthNames[12], categoryNames: {slug: label} }.
 * With `preferredCurrency`, adds a converted-amount column; matrix footer sums only convertible expenses.
 */
export function expensesToCsv(entries = [], { year, labels, preferredCurrency, rates } = {}) {
  const num = (v) => (Math.round(v * 100) / 100).toFixed(2).replace('.', ',');
  const esc = (v) => {
    const s = String(v ?? '');
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const catName = (slug) => labels.categoryNames?.[slug] || slug;
  const prefix = `${year}-`;
  const fxOn = !!preferredCurrency;
  const rateMap = rates || {};
  const notConvLabel = labels.notConvertible || 'no convertible';
  const rows = entries
    .filter((e) => !isTemplate(e) && (monthKeyOf(e.entry_date) || '').startsWith(prefix))
    .sort((a, b) => (a.entry_date < b.entry_date ? -1 : 1));

  const lines = [];
  const header = [labels.date, labels.type, labels.category, labels.amount, labels.currency];
  if (fxOn) header.push(labels.converted);
  header.push(labels.notes);
  lines.push(header.map(esc).join(';'));
  for (const e of rows) {
    const signed = e.type === 'income' ? D(e.amount) : D(e.amount).neg();
    const rowCols = [
      (e.entry_date || '').split('T')[0],
      e.type === 'income' ? labels.income : labels.expense,
      catName(e.category),
      num(signed.toNumber()),
      e.currency || '',
    ];
    if (fxOn) {
      const conv = convertExpenseAmount(
        Math.abs(D(e.amount).toNumber()),
        e.currency,
        preferredCurrency,
        rateMap,
      );
      const convSigned = conv.convertible
        ? num((e.type === 'income' ? 1 : -1) * conv.value)
        : esc(notConvLabel);
      rowCols.push(convSigned);
    }
    rowCols.push(e.notes || '');
    lines.push(rowCols.map(esc).join(';'));
  }

  lines.push('');
  lines.push([labels.category, ...labels.monthNames, labels.total].map(esc).join(';'));
  const matrixPref = preferredCurrency || 'EUR';
  const matrix = {};
  for (const e of rows) {
    if (e.type !== 'expense') continue;
    const conv = convertExpenseAmount(e.amount, e.currency, matrixPref, rateMap);
    if (!conv.convertible) continue;
    const expenseVal = conv.value;
    const m = monthKeyToParts(monthKeyOf(e.entry_date)).month;
    const cat = e.category || 'other';
    if (!matrix[cat]) matrix[cat] = Array.from({ length: 12 }, () => new Decimal(0));
    matrix[cat][m - 1] = matrix[cat][m - 1].plus(new Decimal(expenseVal));
  }
  for (const [cat, months] of Object.entries(matrix)) {
    const total = months.reduce((acc, v) => acc.plus(v), new Decimal(0));
    lines.push([catName(cat), ...months.map((v) => num(v.toNumber())), num(total.toNumber())].map(esc).join(';'));
  }
  return lines.join('\n');
}
