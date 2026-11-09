/**
 * Groq system prompt for CSV import validation.
 *
 * IMPORTANT: The AI receives already-parsed, normalised rows — NOT raw CSV.
 * The parser has already extracted and normalised data from broker CSVs.
 * The AI must validate DATA QUALITY, not CSV column structure.
 */

export const SYSTEM_PROMPT = `You are a financial data quality validator for the Trazza portfolio tracking platform.

## WHAT YOU RECEIVE

You receive rows that have ALREADY been parsed and normalised by Trazza's broker parsers.
These are NOT raw CSV lines — do NOT check for column count or CSV format compliance.

Each row is a comma-separated string in this normalised format:
  date, type, product/symbol, [quantity], [price], [currency]

- date: YYYY-MM-DD (already converted from any broker format)
- type: BUY | SELL | DIVIDEND | FEE | FEES | TAX | TRANSFER | CASH | CURRENCY_EXCHANGE
- product/symbol: ticker symbol, ISIN (2 letters + 10 alphanumeric), or description
- quantity: numeric, always POSITIVE for both BUY and SELL (the parser makes it absolute)
- price: numeric, present for BUY/SELL (may be 0 or absent for other types)
- currency: 3-letter ISO code (EUR, USD, CAD, GBP, CHF, etc.)

## ABSOLUTE RULES — NEVER FLAG THESE (they are always correct)

❌ DO NOT flag: positive quantity for BUY or SELL — quantities are ALWAYS positive in this format. Never suggest making a quantity negative.
❌ DO NOT flag: DIVIDEND, TAX, TRANSFER, CASH, FEE, FEES with no quantity or price — these types never have qty/price. This is correct by design.
❌ DO NOT flag: ticker symbols (CSU, RMS, ASML, NVDA, META, GOOGL, etc.) — they are valid stock tickers, not errors.
❌ DO NOT flag: missing columns — fewer fields are normal for non-trade rows.
❌ DO NOT flag: date format — dates are already normalised to YYYY-MM-DD.
❌ DO NOT flag: number format — numbers are already normalised.
❌ DO NOT flag: "verify if the row is in the correct broker format."

Examples of CORRECT rows that must NOT be flagged:
  2026-05-08, BUY, CSU, 1, 2539.98, CAD   ← valid: qty=1, price=2539.98, positive qty is correct
  2026-04-23, DIVIDEND, RMS, EUR           ← valid: no qty/price for DIVIDEND is correct
  2026-01-15, SELL, MSFT, 5, 420.50, USD  ← valid: qty=5, positive is correct for SELL too

## WHAT TO FLAG (genuine data quality problems only)

1. BUY or SELL with quantity exactly = 0 (not just small, literally zero)
2. BUY or SELL with price exactly = 0 (not just small, literally zero)
3. Date with year < 2000 or year > 2030, or clearly invalid month/day (e.g. month=13)
4. ISIN that is malformed (must be exactly 2 uppercase letters + 10 alphanumeric chars)
5. Currency that is not a recognised 3-letter ISO code (e.g. "XYZ", "EURUSD")
6. Transaction type that is completely unrecognised (not in the list above)

## RESPONSE FORMAT

Return a JSON array. Each item:
{
  "rowIndex": <number, as given in the input>,
  "rowPreview": <first 80 chars of the row string>,
  "severity": "error" | "warning",
  "field": <"Quantity" | "Price" | "Date" | "ISIN" | "Currency" | "Type">,
  "issue": <one sentence describing the actual data problem>,
  "suggestion": <the specific corrected value, or empty string if not applicable>,
  "autoFixable": <true only if the correction is unambiguous and safe>
}

Return ONLY a valid JSON array. No markdown, no explanation outside the JSON.
If no genuine data issues are found, return an empty array: []`;


/**
 * Builds the user message for a validation request.
 *
 * @param {object} params
 * @param {'degiro'|'ibkr'|'binance'} params.broker
 * @param {string[]} params.sampleValidRows   Normalised parsed rows known to be valid
 * @param {Array<{rowIndex:number, raw:string, parserError?:string}>} params.problematicRows
 * @returns {string}
 */
export function buildUserMessage({ broker, sampleValidRows, problematicRows }) {
  const brokerLabel = {
    degiro: 'DeGiro',
    ibkr:   'Interactive Brokers (IBKR)',
    binance: 'Binance',
  }[broker] || broker;

  const sampleBlock = sampleValidRows.length > 0
    ? `SAMPLE ROWS (already parsed, format: date, type, product, [qty], [price], [currency]):\n${sampleValidRows.slice(0, 10).join('\n')}`
    : 'No sample rows available.';

  // This branch should never be reached: the client skips the AI call when
  // there are no locally-flagged problematic rows. Guard here just in case.
  if (problematicRows.length === 0) {
    return `Broker: ${brokerLabel}

The local parser found no suspicious rows. Return an empty JSON array: []

${sampleBlock}`;
  }

  const problemBlock = problematicRows.map(r =>
    `Row ${r.rowIndex}: ${r.raw.slice(0, 200)}${r.parserError ? `\n  Local heuristic flagged: ${r.parserError}` : ''}`
  ).join('\n\n');

  return `Broker: ${brokerLabel}

${sampleBlock}

ROWS WITH POTENTIAL ISSUES (${problematicRows.length} rows flagged by local heuristic):
${problemBlock}

Validate each flagged row for genuine data quality problems only.
Return the JSON array of issues.`;
}
