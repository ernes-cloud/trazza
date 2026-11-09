/**
 * Shared primitives for the BANK statement parsers (src/lib/parsers/bank/).
 *
 * These live apart from the broker parsers on purpose: a bank statement feeds
 * the EXPENSES module (expense_entries), never the portfolio math. The two
 * pipelines share no schema, so sharing a parser base would only couple them.
 *
 * Dates are emitted as 'YYYY-MM-DD' — NOT the 'DD-MM-YYYY' the broker parsers
 * use. The consumer here is `expense_entries.entry_date` (a Postgres `date`)
 * and every helper in expenseService (localTodayIso, endOfMonthIso, monthKeyOf)
 * already speaks ISO. Converting at the parser boundary once beats converting
 * at every aggregation. Do not "align" this with the broker convention.
 */

/**
 * The CLOSED vocabulary of structural classes a BankMovement may carry.
 *
 * It is deliberately shared by every bank parser: downstream (noise classifier,
 * categorizer, expense mapper) must handle a finite set, and a per-bank
 * vocabulary would push that union into each consumer instead.
 *
 * These describe WHAT THE BANK SAID, not what it means for the user's budget.
 * `savings_transfer` and `crypto_transfer` are almost always noise and `card`
 * almost always a real expense — but "almost" is exactly why that verdict lives
 * in the noise classifier and not here.
 */
export const BANK_MOVEMENT_KINDS = /** @type {const} */ ([
  'card', 'card_refund', 'direct_debit', 'fee', 'fee_refund',
  'bizum_in', 'bizum_out', 'bizum_purchase',
  'transfer_in', 'transfer_out', 'internal_transfer',
  'savings_transfer', 'topup', 'fx_exchange', 'crypto_transfer',
  'payroll', 'other',
]);

/**
 * Quote-aware split of one delimited line. `rowsToCsv` (xlsxReader) escapes any
 * cell containing the delimiter or a quote, and a bank concept legitimately
 * contains commas ("BAR PEPE, S.L."), so a plain `.split()` corrupts rows.
 */
export function splitDelimitedLine(line, delimiter = ';') {
  const cells = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === delimiter && !inQuote) {
      cells.push(cur);
      cur = '';
    } else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/** Diacritic-free, lowercase, single-spaced — for matching header labels. */
export function normalizeLabel(str) {
  return String(str ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Collapses padding runs; bank exports pad subfields with many spaces. */
export function collapseSpaces(str) {
  return String(str ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Signed money amount from a bank cell.
 *
 * The separator is decided by PRESENCE OF A COMMA, never by a regex on shape:
 * a bare "1.234" is ambiguous, but it can only reach us from a numeric XLSX
 * cell (always dot-decimal machine values) or from a European-formatted text
 * cell (which would then carry a comma too). Guessing per-value instead —
 * the trap `parseFlexibleNumber` avoids elsewhere — turns 14.8 into 148.
 * → number, or NaN when unparseable.
 */
export function parseBankAmount(raw) {
  const cleaned = String(raw ?? '').replace(/[€$£\s ]/g, '');
  if (cleaned === '') return NaN;
  const normalized = cleaned.includes(',')
    ? cleaned.replace(/\./g, '').replace(',', '.')
    : cleaned;
  return /^-?\d+(\.\d+)?$/.test(normalized) ? parseFloat(normalized) : NaN;
}

const DMY_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/**
 * 'DD/MM/YYYY' → 'YYYY-MM-DD'. Returns null for anything else, which is how
 * callers detect preamble/footer rows: a statement row without a valid date is
 * not a movement, it is chrome.
 */
export function parseDmyDate(raw) {
  const m = String(raw ?? '').trim().match(DMY_RE);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${yyyy}-${mm}-${dd}`;
}

const ISO_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2})?)?/;

/**
 * '2024-03-23 16:21:57' (or a bare '2024-03-23') → '2024-03-23'.
 *
 * The clock time is DISCARDED on purpose: `expense_entries.entry_date` is a
 * `date`, and keeping the timestamp would reintroduce the timezone bug the
 * expenses module already fixed once (a 23:40 movement read as UTC lands on the
 * next day in Madrid). The calendar day the bank printed is the answer.
 */
export function parseIsoDateTime(raw) {
  const m = String(raw ?? '').trim().match(ISO_DATETIME_RE);
  if (!m) return null;
  const [, yyyy, mm, dd] = m;
  if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) return null;
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Reconciles parsed movements against the statement's OWN running-balance
 * column — the same self-validation `auditDegiroLedger` does, and the reason
 * we can trust a parse without eyeballing it.
 *
 * File order is unknown (banks export newest-first or oldest-first), so both
 * directions are tried and the one with fewer mismatches wins.
 *
 * A row's own `fee` is subtracted SEPARATELY from the balance: Revolut charges
 * it alongside the movement without folding it into `Importe`. Measured on a
 * real 242-row export: `balance + amount` reconciles 230/241 steps, whereas
 * `balance + amount - fee` reconciles 241/241. Banks with no fee column leave
 * it at 0 and the arithmetic is unchanged.
 *
 * @param {{amount:number, fee?:number, balance:number|null, raw:string}[]} movements
 * @returns {{ ok:boolean, direction:'desc'|'asc'|null, checked:number,
 *             mismatches:{index:number, expected:number, found:number, raw:string}[] }}
 */
export function auditRunningBalance(movements = []) {
  const rows = movements.filter((m) => Number.isFinite(m?.balance));
  if (rows.length < 2) return { ok: true, direction: null, checked: 0, mismatches: [] };

  const feeOf = (row) => (Number.isFinite(row?.fee) ? row.fee : 0);

  // desc = newest first: undoing movement i gives the balance before it, i.e. balance[i+1].
  // asc  = oldest first: applying movement i+1 to balance[i] gives balance[i+1].
  const run = (direction) => {
    const mismatches = [];
    for (let i = 0; i < rows.length - 1; i++) {
      const expected = direction === 'desc'
        ? rows[i].balance - rows[i].amount + feeOf(rows[i])
        : rows[i].balance + rows[i + 1].amount - feeOf(rows[i + 1]);
      if (Math.abs(expected - rows[i + 1].balance) > 0.005) {
        mismatches.push({
          index: i + 1,
          expected: Number(expected.toFixed(2)),
          found: rows[i + 1].balance,
          raw: rows[i + 1].raw,
        });
      }
    }
    return mismatches;
  };

  const desc = run('desc');
  const asc = run('asc');
  const winner = desc.length <= asc.length ? 'desc' : 'asc';
  const mismatches = winner === 'desc' ? desc : asc;
  return { ok: mismatches.length === 0, direction: winner, checked: rows.length - 1, mismatches };
}
