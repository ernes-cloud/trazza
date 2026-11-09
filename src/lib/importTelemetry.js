import { redactHeaderLine } from './headerLineRedact.js';

/**
 * Fire-and-forget import telemetry → POST /api/log-import.
 *
 * The CSV import runs entirely in the browser, so parse/save failures were
 * invisible server-side. One event per parse attempt and per save attempt
 * gives the admin log (service 'import') enough to diagnose "no me funciona"
 * reports: broker, detected format, row/transaction counts and the error.
 *
 * Must NEVER interfere with the import flow: no await from callers, all
 * errors swallowed.
 */
export function logImportEvent(payload) {
  try {
    fetch('/api/log-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
  } catch (_) {
    // Telemetry is best-effort by design.
  }
}

/**
 * Rich error context for the `details` field: code + trimmed stack. The
 * message alone ("Cannot read properties of undefined") is useless without
 * the frame it happened in.
 */
export function describeImportError(err) {
  return {
    errorCode: err?.code || undefined,
    errorStack: typeof err?.stack === 'string'
      ? err.stack.split('\n').slice(0, 8).join('\n')
      : undefined,
  };
}

/**
 * First non-empty line — normally the column names (diagnostic gold). NOT
 * always: MyInvestor's XLSX starts with `TITULAR:;<full name>`, so it goes
 * through `redactHeaderLine` before leaving the browser.
 */
export const headerLineOf = (text) =>
  redactHeaderLine(String(text || '').split('\n').find(l => l.trim()) || '');
