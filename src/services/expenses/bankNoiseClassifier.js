/**
 * Decides what a bank movement MEANS for the expenses module.
 *
 * This is the single most important file of the bank import, and the reason
 * the parsers deliberately refuse to make this call. Measured on two real
 * statements: 52% of a Revolut export (FX legs, crypto, savings vault, money
 * market funds) and 8% of a BBVA one (own-account transfers, broker funding)
 * are NOT household spending. Importing them as expenses would corrupt the
 * savings rate, the annual goal, the Sankey and the "Patrimonio total" — and
 * the broker funding would be counted twice, since Trazza already tracks it as
 * portfolio contributions.
 *
 * → { intent: 'expense'|'income'|'ignore', reason, needsReview }
 *
 * `needsReview` is not a soft "ignore". It marks rows whose intent CANNOT be
 * decided from one statement alone and that the user must confirm in the
 * preview. The canonical case: a Revolut top-up is usually the user moving
 * their own money, but 3 of 26 in the real export were an employer's payroll.
 * Guessing either way silently would be wrong 12% of the time.
 *
 * Pure module — no I/O, no React, no dates from the clock.
 */

const norm = (s) => String(s ?? '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Money moving to an investment provider is NOT an expense: Trazza already
 * counts it in the portfolio, so importing it here would show the same euro
 * twice — once as wealth and once as spending.
 */
const BROKER_RE = new RegExp([
  'degiro', 'trade republic', 'interactive brokers', '\\bibkr\\b', 'myinvestor',
  '\\bxtb\\b', 'etoro', 'scalable', 'indexa', 'finizens', 'renta 4', 'openbank invest',
  'trading 212', 'revolut trading', 'binance', 'coinbase', 'kraken',
].join('|'), 'i');

/** Structural kinds that are never household spending, whatever the amount. */
const ALWAYS_IGNORED = new Set([
  'fx_exchange',       // currency-conversion legs — the same money, twice
  'crypto_transfer',   // investment, and Trazza may already track it
  'savings_transfer',  // vault / money-market funds: changed pocket, not spent
  'internal_transfer', // between the user's own accounts at the same bank
]);

/** Kinds whose intent follows directly from the bank's own label. */
const FIXED_INTENT = {
  payroll: 'income',
  direct_debit: 'expense',
  fee: 'expense',
  fee_refund: 'income',
  card_refund: 'income',
  bizum_in: 'income',
  bizum_out: 'expense',
  bizum_purchase: 'expense',
};

/** Sign is the fallback authority: money out is spending, money in is income. */
const bySign = (amount) => (amount < 0 ? 'expense' : 'income');

/**
 * Counterparties that appear on BOTH sides of the transfer flow are almost
 * certainly the user's own accounts: you do not normally send money to someone
 * AND receive it back from them under the exact same name.
 *
 * This is derived from the data instead of asked for in a form, because the
 * name a bank prints varies in case and accents across rows — the SAME account
 * holder appeared under 4 different spellings in one real export — and a user
 * cannot be expected to enumerate them.
 *
 * @returns {Set<string>} normalized counterparty names
 */
export function detectOwnCounterparties(movements = []) {
  const inbound = new Set();
  const outbound = new Set();
  for (const m of movements) {
    const name = norm(m?.merchant).replace(/^(de|from|to|a)\s+/, '');
    if (!name) continue;
    if (m.kind === 'transfer_in' || m.kind === 'topup') inbound.add(name);
    if (m.kind === 'transfer_out') outbound.add(name);
  }
  return new Set([...inbound].filter((name) => outbound.has(name)));
}

/**
 * @param {object} movement                BankMovement
 * @param {object} [options]
 * @param {Set<string>} [options.ownCounterparties]  from detectOwnCounterparties
 * @param {string[]}    [options.ownerNames]         extra names the user declared
 * @returns {{ intent: 'expense'|'income'|'ignore', reason: string, needsReview: boolean }}
 */
export function classifyMovementIntent(movement, options = {}) {
  const { ownCounterparties = new Set(), ownerNames = [] } = options;
  const kind = movement?.kind || 'other';
  const amount = Number(movement?.amount) || 0;
  const haystack = `${norm(movement?.merchant)} ${norm(movement?.detail)} ${norm(movement?.concept)}`;

  if (ALWAYS_IGNORED.has(kind)) {
    return { intent: 'ignore', reason: `kind_${kind}`, needsReview: false };
  }

  if (BROKER_RE.test(haystack)) {
    return { intent: 'ignore', reason: 'broker_funding', needsReview: false };
  }

  const counterparty = norm(movement?.merchant).replace(/^(de|from|to|a)\s+/, '');
  const isOwn = counterparty
    && (ownCounterparties.has(counterparty) || ownerNames.some((n) => norm(n) === counterparty));
  if (isOwn) {
    return { intent: 'ignore', reason: 'own_account', needsReview: false };
  }

  // A top-up is the user funding their own account far more often than not,
  // but it is also how some employers pay. Ignore by default AND ask.
  if (kind === 'topup') {
    return { intent: 'ignore', reason: 'topup_ambiguous', needsReview: true };
  }

  if (FIXED_INTENT[kind]) {
    return { intent: FIXED_INTENT[kind], reason: `kind_${kind}`, needsReview: false };
  }

  if (kind === 'card') {
    // A positive card row is a refund the bank did not label as one.
    return { intent: bySign(amount), reason: 'kind_card', needsReview: false };
  }

  if (kind === 'transfer_in' || kind === 'transfer_out') {
    return { intent: bySign(amount), reason: `kind_${kind}`, needsReview: true };
  }

  return { intent: bySign(amount), reason: 'unclassified', needsReview: true };
}

/**
 * Classifies a whole statement, deriving the own-account set from it first.
 * @returns {{ movement, intent, reason, needsReview }[]} in input order
 */
export function classifyStatement(movements = [], options = {}) {
  const ownCounterparties = options.ownCounterparties ?? detectOwnCounterparties(movements);
  return movements.map((movement) => ({
    movement,
    ...classifyMovementIntent(movement, { ...options, ownCounterparties }),
  }));
}

/** Counts per intent, for the preview summary. */
export function summarizeIntents(classified = []) {
  return classified.reduce(
    (acc, c) => {
      acc[c.intent] += 1;
      if (c.needsReview) acc.needsReview += 1;
      return acc;
    },
    { expense: 0, income: 0, ignore: 0, needsReview: 0 },
  );
}
