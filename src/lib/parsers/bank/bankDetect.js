/**
 * Bank-statement detection for the expenses import.
 *
 * Same philosophy as `detectBrokerCsv`: detection IS running the real parsers
 * and requiring at least one movement, never a second header sniff living in a
 * second place that can drift from the parser it is meant to describe.
 *
 * Order matters only for cost (each candidate bails fast on a foreign header),
 * not for correctness — the two layouts share no column names.
 */

import { parseBbvaStatement } from './bbvaParser.js';
import { parseRevolutStatement } from './revolutParser.js';

const CANDIDATES = [
  { bank: 'bbva', parse: parseBbvaStatement },
  { bank: 'revolut', parse: parseRevolutStatement },
];

/**
 * @param {string} text  statement contents (XLSX already converted via rowsToCsv)
 * @returns {{ bank: string, movements: import('./bbvaParser.js').BankMovement[] } | null}
 */
export function detectBankStatement(text) {
  if (!text || typeof text !== 'string' || text.trim() === '') return null;

  for (const { bank, parse } of CANDIDATES) {
    try {
      const movements = parse(text);
      if (movements.length > 0) return { bank, movements };
    } catch {
      // Not this bank's format — try the next one.
    }
  }
  return null;
}

/** Banks the importer can read, for the empty-state hint in the UI. */
export const SUPPORTED_BANKS = CANDIDATES.map((c) => c.bank);
