/**
 * Revolut "account statement" CSV parser.
 *
 * Layout (verified against a real 242-row, 28-month es-ES export):
 *
 *   Tipo,Producto,Fecha de inicio,Fecha de finalización,Descripción,
 *   Importe,Comisión,Divisa,State,Saldo
 *
 * Rows are OLDEST FIRST (BBVA exports newest first — never assume a direction,
 * `auditRunningBalance` detects it).
 *
 * What makes this export different from a normal bank statement:
 *
 * 1. `Comisión` is a SEPARATE column that the balance already reflects but
 *    `Importe` does NOT. Measured: `balance + amount` reconciles 230/241 steps,
 *    `balance + amount - fee` reconciles 241/241. The fee is carried on the
 *    movement and it is the mapper's job to surface it as its own expense.
 *
 * 2. `Tipo` is a machine-readable class — a gift compared to parsing Spanish
 *    prose — but it is COARSE. "Transferir" covers P2P payments, savings-vault
 *    top-ups and money-market fund subscriptions; "Cambio" covers FX legs AND
 *    crypto transfers. Both need the description to disambiguate, so the
 *    mapping below is (Tipo × Descripción), never Tipo alone.
 *
 * 3. Only 21% of the rows are real spending. In the measured export: 29% FX
 *    legs, 34% transfers (mostly to the user's own savings products), 11%
 *    top-ups. A naive import would invent a fortune in phantom expenses — see
 *    the `savings_transfer` / `fx_exchange` / `crypto_transfer` kinds.
 *
 * 4. Descriptions mix Spanish and English in the SAME es-ES export ("Savings
 *    Vault topup", "To Fondos Monetarios", "Conversión a USD"), so every
 *    pattern here is bilingual by necessity, not by over-engineering.
 *
 * Output: BankMovement[] in file order (same contract as bbvaParser).
 */

import {
  splitDelimitedLine, normalizeLabel, collapseSpaces, parseBankAmount, parseIsoDateTime,
} from './bankCsv.js';

const HEADERS = {
  type: 'tipo',
  product: 'producto',
  startDate: 'fecha de inicio',
  endDate: 'fecha de finalizacion',
  description: 'descripcion',
  amount: 'importe',
  fee: 'comision',
  currency: 'divisa',
  state: 'state',
  balance: 'saldo',
};

/**
 * Only a settled row moved money. PENDIENTE/DECLINADO/REVERTIDO never reached
 * the balance, so importing one would charge the user for a payment their bank
 * refused or undid. An export with no State column at all is accepted as-is.
 *
 * NOTE: the real export used to build this parser contained only COMPLETADO
 * rows, so this filter is covered by the synthetic fixture alone.
 */
const SETTLED_STATES = new Set(['completado', 'completed']);

/**
 * The user's own savings/investment products inside Revolut. Money moving here
 * has NOT been spent — it changed pocket. Bilingual because the export is.
 */
const SAVINGS_RE = /savings? vault|fondos monetarios|money market|cuenta remunerada|flexible (account|cuenta)|dep[óo]sito/i;
/** Revolut's crypto arm shows up as an ordinary "Cambio" row. */
const CRYPTO_RE = /digital assets|crypto|cripto/i;

export class RevolutParseError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RevolutParseError';
    this.code = code;
  }
}

function resolveColumns(rows) {
  const headerIndex = rows.findIndex((cells) => {
    const labels = cells.map(normalizeLabel);
    return labels.includes(HEADERS.type) && labels.includes(HEADERS.amount)
      && labels.includes(HEADERS.balance);
  });
  if (headerIndex === -1) {
    throw new RevolutParseError('No Revolut statement header row found', 'revolut_header_missing');
  }
  const labels = rows[headerIndex].map(normalizeLabel);
  const columns = Object.fromEntries(
    Object.entries(HEADERS).map(([field, label]) => [field, labels.indexOf(label)]),
  );
  return { headerIndex, columns };
}

const cell = (cells, index) => (index >= 0 ? (cells[index] ?? '') : '');

/**
 * Structural class from (Tipo × Descripción).
 *
 * Order matters: the savings and crypto checks run BEFORE the generic transfer
 * and exchange fallbacks, because "To Fondos Monetarios" is a `Transferir` and
 * "Transfer to Revolut Digital Assets" is a `Cambio` — reading Tipo first and
 * the description second would bury both.
 */
function classify(type, description, amount) {
  const t = normalizeLabel(type);
  const d = collapseSpaces(description);

  if (SAVINGS_RE.test(d)) return 'savings_transfer';
  if (CRYPTO_RE.test(d)) return 'crypto_transfer';

  if (t === 'pago con tarjeta') return 'card';
  if (t === 'reembolso de tarjeta') return 'card_refund';
  if (t === 'reembolso de cargo') return 'fee_refund';
  if (t === 'cobro' || t.startsWith('comisiones')) return 'fee';
  if (t === 'recargas' || t === 'top-up') return 'topup';
  // Every non-crypto "Cambio" in the measured export is a currency-conversion
  // leg ("Conversión a USD/GBP/EUR"); crypto already returned above.
  if (t === 'cambio' || t === 'exchange') return 'fx_exchange';
  if (t === 'transferir' || t === 'transfer') return amount < 0 ? 'transfer_out' : 'transfer_in';
  return 'other';
}

/**
 * Counterparty/merchant from the description.
 *
 * The directional prefixes Revolut prepends ("To ", "From ", "Pago de ",
 * "Desde ", "A ") are stripped: the direction already lives in the sign, and
 * leaving them in would split ONE counterparty into two cache keys ("To Acme"
 * and "From Acme"), halving the hit rate of the merchant→category rules.
 */
const DIRECTION_PREFIX_RE = /^(to|from|a|de|desde|pago de|payment to|payment from|transfer to|transfer from)\s+/i;

function resolveMerchant(description) {
  const d = collapseSpaces(description);
  if (!d) return null;
  return collapseSpaces(d.replace(DIRECTION_PREFIX_RE, '')) || d;
}

function toMovement(cells, columns, raw) {
  const state = normalizeLabel(cell(cells, columns.state));
  if (state && !SETTLED_STATES.has(state)) return null;

  const startDate = parseIsoDateTime(cell(cells, columns.startDate));
  const endDate = parseIsoDateTime(cell(cells, columns.endDate));
  if (!startDate && !endDate) return null;

  const amount = parseBankAmount(cell(cells, columns.amount));
  if (!Number.isFinite(amount)) return null;

  const fee = parseBankAmount(cell(cells, columns.fee));
  const balance = parseBankAmount(cell(cells, columns.balance));
  const description = collapseSpaces(cell(cells, columns.description));
  const type = collapseSpaces(cell(cells, columns.type));

  return {
    // Started, not finished: the money left the user's hands when the payment
    // was initiated. 56 of 242 real rows settle on a LATER calendar day, so the
    // choice moves those movements between months.
    date: startDate || endDate,
    bookedDate: endDate || startDate,
    concept: type,
    detail: description,
    merchant: resolveMerchant(description),
    reference: null,
    kind: classify(type, description, amount),
    amount,
    fee: Number.isFinite(fee) ? fee : 0,
    currency: collapseSpaces(cell(cells, columns.currency)).toUpperCase() || 'EUR',
    balance: Number.isFinite(balance) ? balance : null,
    account: collapseSpaces(cell(cells, columns.product)) || null,
    source: 'revolut',
    raw,
  };
}

/**
 * @param {string} text  Revolut account-statement CSV
 * @returns {import('./bbvaParser.js').BankMovement[]} in file order
 * @throws {RevolutParseError} when the header row is absent
 */
export function parseRevolutStatement(text) {
  if (!text || typeof text !== 'string') {
    throw new RevolutParseError('Empty Revolut statement', 'revolut_empty');
  }

  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const rows = lines.map((l) => splitDelimitedLine(l, ','));
  const { headerIndex, columns } = resolveColumns(rows);

  const movements = [];
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const movement = toMovement(rows[i], columns, lines[i]);
    if (movement) movements.push(movement);
  }
  return movements;
}

/** True when the text looks like a Revolut statement (runs the real parser). */
export function isRevolutStatement(text) {
  try {
    return parseRevolutStatement(text).length > 0;
  } catch {
    return false;
  }
}
