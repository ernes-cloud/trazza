/**
 * MyInvestor se puede traer de TRES formas: el CSV de Operaciones, el XLSX de
 * Movimientos (los dos los lee `parseMyInvestorCSV` por cabecera) y el texto
 * copiado de la PANTALLA de la cartera (`parseMyInvestorWeb`).
 *
 * Esta es la ÚNICA puerta para "léelo como MyInvestor", y la usan tanto la
 * detección (`brokerDetect`) como el importador (`useImportFlow`). Hasta el
 * 2026-10-02 cada uno probaba los lectores a su manera: la detección aceptaba
 * el texto de la web, pero el importador llamaba antes al del CSV, que LANZA
 * con un formato que no conoce en vez de devolver vacío, y nunca llegaba al de
 * la web. Quien pegaba su cartera desde la web de MyInvestor veía un error
 * genérico y el diálogo de la IA se cerraba — sin salida y sin rastro.
 *
 * Orden: CSV/XLSX primero (reconoce sus cabeceras, es más específico) y la web
 * después. Si ninguno saca operaciones reales se relanza el error ORIGINAL del
 * CSV, que es el que explica qué exportación pedir.
 */
import { parseMyInvestorCSV } from './myinvestorParser.js';
import { parseMyInvestorWeb } from './myinvestorWebParser.js';

const REAL = new Set(['BUY', 'SELL', 'DIVIDEND']);
const hasReal = (rows) => Array.isArray(rows) && rows.some((r) => REAL.has(r.type));

export function parseMyInvestorAny(text) {
  let csvRows = null;
  let csvError = null;
  try {
    csvRows = parseMyInvestorCSV(text);
    if (hasReal(csvRows)) return csvRows;
  } catch (err) {
    csvError = err;
  }

  let webRows = null;
  try {
    webRows = parseMyInvestorWeb(text);
  } catch { /* la web tampoco: se decide abajo */ }
  if (hasReal(webRows)) return webRows;

  if (csvError) throw csvError;
  return csvRows || webRows || [];
}
