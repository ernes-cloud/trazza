/**
 * Known-broker CSV detection for text pasted into the AI import.
 *
 * A full broker export run through the LLM row-by-row produces a distorted
 * portfolio: FX conversion legs become phantom deposits/withdrawals, GBX
 * prices keep their ×100 scale, fees/withholdings aren't merged into trades…
 * The deterministic parsers already handle all of that (ledger-audited), so
 * when the pasted text IS a known export we route it to the native importer
 * instead of burning AI quota on a worse result.
 *
 * Detection = actually running each parser (they bail fast on foreign
 * headers) and requiring at least one real trade/dividend row.
 */

import { parseDegiroCSV } from './degiroParser.js';
import { parseIBKRCSV } from './ibkrParser.js';
import { parseBinanceCSV } from './binanceCsvParser.js';
import { parseMyInvestorAny } from './myinvestorAny.js';
import { parseTrading212CSV } from './trading212Parser.js';

const REAL_TYPES = new Set(['BUY', 'SELL', 'DIVIDEND']);
const countReal = (rows) => (rows || []).filter((r) => REAL_TYPES.has(r.type)).length;

const CANDIDATES = [
  { broker: 'degiro', parse: (text) => parseDegiroCSV(text) },
  { broker: 'ibkr', parse: (text) => parseIBKRCSV(text).transactions },
  { broker: 'binance', parse: (text) => parseBinanceCSV(text) },
  { broker: 'trading212', parse: (text) => parseTrading212CSV(text).transactions },
  // CSV/XLSX y, si no, el texto copiado de la WEB. Es la MISMA función que usa
  // el importador (useImportFlow): si la detección y el importador probaran los
  // lectores cada uno a su manera, volverían a discrepar (ver myinvestorAny.js).
  { broker: 'myinvestor', parse: (text) => parseMyInvestorAny(text) },
];

/**
 * @param {string} text  pasted content
 * @returns {{ broker: string, realTxCount: number } | null}
 */
export function detectBrokerCsv(text) {
  if (!text || text.trim().length === 0) return null;

  for (const { broker, parse } of CANDIDATES) {
    try {
      const realTxCount = countReal(parse(text));
      if (realTxCount > 0) return { broker, realTxCount };
    } catch (err) {
      // DeGiro's OTHER export (Transactions.csv) throws a typed error — it IS
      // a DeGiro file, and the native flow explains which export to use.
      if (err?.code === 'degiro_transactions_file') return { broker: 'degiro', realTxCount: 0 };
      // Any other parser error just means "not this broker's format"
    }
  }
  return null;
}

/**
 * Broker al que REALMENTE pertenece un archivo que el lector del broker elegido
 * no entendió, o null. Solo cuenta si ese otro lector saca operaciones reales:
 * el Transactions.csv de DeGiro (realTxCount 0) se queda en su flujo, que ya
 * explica qué export hace falta.
 *
 * @param {string} text            contenido del archivo
 * @param {string} selectedBroker  broker elegido en el diálogo
 * @returns {string|null}
 */
export function detectOtherBroker(text, selectedBroker) {
  const det = detectBrokerCsv(text);
  return det && det.broker !== selectedBroker && det.realTxCount > 0 ? det.broker : null;
}
