/**
 * Anonymize a broker CSV before the user shares it with support (opt-in).
 *
 * Goal: preserve the STRUCTURE the developer needs to reproduce a parse
 * failure (headers, delimiters, number formats, description keywords, ISINs)
 * while stripping anything personally identifying:
 *   - emails                    → [email]
 *   - IBANs (15+ chars)         → [iban]     (ISINs are 12 chars — preserved)
 *   - IBKR account ids U1234567 → [account]
 *   - digit runs of 9+          → [num]      (account/reference numbers;
 *                                             amounts and dates are shorter)
 *
 * Output is capped to the header + first `maxLines` data lines and 15k chars.
 */

const MAX_CHARS = 15_000;

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/g;
// 2 letters + 2 digits + 11..30 alphanumerics → 15+ total. An ISIN is 12 total,
// so it never matches (US30303M1027 = US + 30 + 8 more chars).
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;
const IBKR_ACCOUNT_RE = /\bU\d{6,8}\b/g;
const LONG_DIGITS_RE = /\d{9,}/g;

export function redactCsvSample(csvText, maxLines = 40) {
  if (!csvText || typeof csvText !== 'string') return '';

  const lines = csvText.split('\n').filter(l => l.trim().length > 0);
  const kept = lines.slice(0, maxLines + 1); // header + N data lines
  const omitted = lines.length - kept.length;

  let sample = kept
    .join('\n')
    .replace(EMAIL_RE, '[email]')
    .replace(IBAN_RE, '[iban]')
    .replace(IBKR_ACCOUNT_RE, '[account]')
    .replace(LONG_DIGITS_RE, '[num]');

  if (omitted > 0) sample += `\n[... ${omitted} more rows omitted ...]`;
  return sample.slice(0, MAX_CHARS);
}
