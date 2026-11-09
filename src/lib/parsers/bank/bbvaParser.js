/**
 * BBVA "Movimientos" parser (XLSX export → CSV text via xlsxReader.rowsToCsv).
 *
 * Layout of the real export (verified against a 27-month, 1440-movement file):
 *
 *   row 0  | "Movimientos"
 *   row 1  | "Fecha de generación del informe: DD/MM/YYYY"
 *   row 2  | "" | Fecha valor | Fecha | Concepto | Movimiento | Importe |
 *          |    Divisa | Disponible | Divisa | Observaciones
 *   row 3+ | movements, NEWEST FIRST
 *
 * Three traps this layout sets, all handled below:
 *
 * 1. The FIRST column is empty and "Divisa" appears TWICE (after Importe and
 *    after Disponible). Resolving columns by name alone picks the wrong one,
 *    so the currency is taken as the first "divisa" AFTER the amount column —
 *    position relative to an unambiguous anchor, not absolute position (which
 *    would break the day BBVA adds a column).
 *
 * 2. TWO date columns, differing in 48% of the rows. "Fecha valor" is never
 *    later than "Fecha" (measured: 694 earlier, 746 equal, 0 later) — it is
 *    when the money actually moved for the user, while "Fecha" is when the
 *    entry was booked. Expense tracking wants the former, so `date` is Fecha
 *    valor and the booking date is kept as `bookedDate`.
 *
 * 3. The merchant is NOT always in "Concepto". Direct debits ("Adeudo a su
 *    cargo", 2.6% of rows) and Bizum (19% (!) of rows) carry it in
 *    "Movimiento" instead. Reading only Concepto collapses a fifth of the
 *    statement into two useless labels.
 *
 * Output is a BankMovement[] in FILE ORDER (not re-sorted — auditRunningBalance
 * needs the original sequence to reconcile the balance column).
 *
 * @typedef {object} BankMovement
 * @property {string}      date        'YYYY-MM-DD' — value date (money moved)
 * @property {string}      bookedDate  'YYYY-MM-DD' — booking date
 * @property {string}      concept     raw "Concepto" cell
 * @property {string}      detail      raw "Movimiento" cell
 * @property {string|null} merchant    resolved counterparty/merchant
 * @property {string|null} reference   bank reference when the row carries one
 * @property {number}      amount      signed; negative = money out
 * @property {number}      fee         charged alongside the movement (0 here —
 *                                     BBVA folds any fee into its own row)
 * @property {string}      currency
 * @property {number|null} balance     running balance after the movement
 * @property {string|null} account     product/account label when the export names one
 * @property {string}      kind        STRUCTURAL class (see BANK_MOVEMENT_KINDS)
 * @property {'bbva'}      source
 * @property {string}      raw         original line, audit trail
 */

import {
  splitDelimitedLine, normalizeLabel, collapseSpaces, parseBankAmount, parseDmyDate,
} from './bankCsv.js';

const HEADERS = {
  valueDate: 'fecha valor',
  date: 'fecha',
  concept: 'concepto',
  detail: 'movimiento',
  amount: 'importe',
  balance: 'disponible',
  currency: 'divisa',
};

/** Leading bank reference on direct debits: "N 9900112233445566 ACME SA ..." */
const REFERENCE_RE = /^N\s*(\d{6,})\s*/;

export class BbvaParseError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BbvaParseError';
    this.code = code;
  }
}

/**
 * Locates the header row and maps logical fields to column indices.
 * Anchored on the two labels no other BBVA export shares ("concepto" and
 * "importe") so preamble lines can never be mistaken for the header.
 */
function resolveColumns(rows) {
  const headerIndex = rows.findIndex((cells) => {
    const labels = cells.map(normalizeLabel);
    return labels.includes(HEADERS.concept) && labels.includes(HEADERS.amount);
  });
  if (headerIndex === -1) {
    throw new BbvaParseError('No BBVA "Movimientos" header row found', 'bbva_header_missing');
  }

  const labels = rows[headerIndex].map(normalizeLabel);
  const amount = labels.indexOf(HEADERS.amount);
  const columns = {
    valueDate: labels.indexOf(HEADERS.valueDate),
    date: labels.indexOf(HEADERS.date),
    concept: labels.indexOf(HEADERS.concept),
    detail: labels.indexOf(HEADERS.detail),
    amount,
    balance: labels.indexOf(HEADERS.balance),
    // "Divisa" appears twice — take the one belonging to Importe, not to Disponible.
    currency: labels.findIndex((l, i) => l === HEADERS.currency && i > amount),
  };
  return { headerIndex, columns };
}

/** Value of a column, '' when the column is absent from this export. */
const cell = (cells, index) => (index >= 0 ? (cells[index] ?? '') : '');

/** Text after the first ':' in a Bizum detail; null for "sin concepto". */
function bizumNote(detail) {
  const note = collapseSpaces(String(detail).split(':').slice(1).join(':'));
  return !note || /^sin concepto$/i.test(note) ? null : note;
}

/**
 * Direct-debit merchant: drop the leading "N <reference>", then keep the first
 * padded segment. BBVA separates subfields with runs of 3+ spaces, so
 * "ACME TELECOM SA        CPVR" is the biller plus an internal code — splitting
 * on the padding is reading the format, not guessing at it.
 */
function directDebitParts(detail) {
  const raw = String(detail);
  const reference = raw.match(REFERENCE_RE)?.[1] ?? null;
  const body = raw.replace(REFERENCE_RE, '');
  const merchant = collapseSpaces(body.split(/\s{3,}/)[0]) || null;
  return { merchant, reference };
}

/** Structural class + merchant, from the concept/detail pair. */
function classify(concept, detail) {
  const c = normalizeLabel(concept);
  // The RAW detail must survive to directDebitParts: BBVA's subfield separator
  // IS the run of 3+ spaces, so collapsing first would erase the boundary.
  const rawDetail = String(detail);
  const d = collapseSpaces(rawDetail);

  if (c === 'bizum') {
    const note = bizumNote(d);
    if (/^recibido/i.test(d)) return { kind: 'bizum_in', merchant: note };
    if (/^enviado/i.test(d)) return { kind: 'bizum_out', merchant: note };
    if (/^compra/i.test(d)) return { kind: 'bizum_purchase', merchant: note };
    return { kind: 'other', merchant: note };
  }

  if (c === 'adeudo a su cargo' || REFERENCE_RE.test(d)) {
    return { kind: 'direct_debit', ...directDebitParts(rawDetail) };
  }

  if (c.includes('nomina')) return { kind: 'payroll', merchant: collapseSpaces(concept) };
  if (c.startsWith('traspaso')) return { kind: 'internal_transfer', merchant: d || collapseSpaces(concept) };

  if (c.startsWith('transferencia') || c.startsWith('abono por transferencia')) {
    const kind = /realizada|enviada|emitida/.test(c) ? 'transfer_out' : 'transfer_in';
    return { kind, merchant: d || collapseSpaces(concept) };
  }

  // Card payments and everything else name the merchant in Concepto.
  const kind = normalizeLabel(d) === 'pago con tarjeta' ? 'card' : 'other';
  return { kind, merchant: collapseSpaces(concept) || null };
}

/** One statement line → BankMovement, or null when it is not a movement. */
function toMovement(cells, columns, raw) {
  const bookedDate = parseDmyDate(cell(cells, columns.date));
  const valueDate = parseDmyDate(cell(cells, columns.valueDate));
  // Preamble, footers and totals have no parseable date — that is the signal.
  if (!bookedDate && !valueDate) return null;

  const amount = parseBankAmount(cell(cells, columns.amount));
  if (!Number.isFinite(amount)) return null;

  const concept = collapseSpaces(cell(cells, columns.concept));
  const detail = String(cell(cells, columns.detail));
  const balance = parseBankAmount(cell(cells, columns.balance));

  return {
    date: valueDate || bookedDate,
    bookedDate: bookedDate || valueDate,
    concept,
    detail: collapseSpaces(detail),
    reference: null,
    ...classify(concept, detail),
    amount,
    // BBVA never charges a fee on the same line — each one is its own movement.
    fee: 0,
    currency: collapseSpaces(cell(cells, columns.currency)).toUpperCase() || 'EUR',
    balance: Number.isFinite(balance) ? balance : null,
    account: null,
    source: 'bbva',
    raw,
  };
}

/**
 * @param {string} text  BBVA Movimientos XLSX converted with xlsxReader.rowsToCsv
 * @returns {BankMovement[]} in file order
 * @throws {BbvaParseError} when the header row is absent (not a BBVA export)
 */
export function parseBbvaStatement(text) {
  if (!text || typeof text !== 'string') {
    throw new BbvaParseError('Empty BBVA statement', 'bbva_empty');
  }

  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const rows = lines.map((l) => splitDelimitedLine(l, ';'));
  const { headerIndex, columns } = resolveColumns(rows);

  const movements = [];
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const movement = toMovement(rows[i], columns, lines[i]);
    if (movement) movements.push(movement);
  }
  return movements;
}

/**
 * True when the text looks like a BBVA Movimientos export. Mirrors
 * `detectBrokerCsv`: run the real parser and require at least one movement,
 * rather than sniffing headers a second time in a second place.
 */
export function isBbvaStatement(text) {
  try {
    return parseBbvaStatement(text).length > 0;
  } catch {
    return false;
  }
}
