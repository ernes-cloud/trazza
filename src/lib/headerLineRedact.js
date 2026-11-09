/**
 * Limpia la "primera línea" de un fichero de import antes de mandarla a la
 * telemetría (`import_logs.details.headerLine`).
 *
 * Se asumía que la primera línea eran los NOMBRES de columna ("nunca datos de
 * fila"), pero el Movimientos .xlsx de MyInvestor empieza con una fila de
 * metadatos `;;;TITULAR:;<NOMBRE COMPLETO>`: el nombre del titular acababa en
 * la tabla en claro (detectado 2026-10-02). Regla: el valor que sigue a una
 * celda-etiqueta terminada en ":" es un dato, no un nombre de columna, y se
 * tapa. Encima se aplican las mismas redacciones que a las muestras de CSV
 * (emails, IBAN, cuentas IBKR, números largos).
 *
 * Es pura y Node-compatible: la usan el cliente (lib/importTelemetry) y el
 * server (routes/logImport.js), porque el endpoint es público y no se puede
 * confiar en que lo que llega venga limpio.
 */
import { redactCsvSample } from './csvRedact.js';

export const REDACTED = '[redactado]';
const MAX = 200;

export function redactHeaderLine(line) {
  const raw = String(line ?? '').slice(0, MAX * 2);
  // Conserva los separadores para devolver la línea con su forma original.
  const parts = raw.split(/([;,\t|])/);
  let pendingLabel = false;
  for (let i = 0; i < parts.length; i += 2) {
    const cell = parts[i].trim();
    if (!cell) continue;
    if (pendingLabel) {
      parts[i] = REDACTED;
      pendingLabel = false;
      continue;
    }
    if (cell.endsWith(':')) { pendingLabel = true; continue; }
    // "TITULAR: Nombre Apellido" en una sola celda
    const m = parts[i].match(/^(\s*[^:]{1,30}:\s*)(\S.*)$/);
    if (m && !/^https?$/i.test(m[1].trim().slice(0, -1))) parts[i] = `${m[1]}${REDACTED}`;
  }
  return redactCsvSample(parts.join(''), 1).slice(0, MAX);
}
