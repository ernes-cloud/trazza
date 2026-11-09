/**
 * Lector del CSV de TRANSACCIONES de DEGIRO (Transactions.csv, «Transacciones»)
 * para la herramienta pública /calculadora-renta-broker — PURO y testeado.
 *
 * Es el OTRO export de DEGIRO: el importador de la app (lib/parsers/degiroParser.js)
 * lee el Estado de cuenta (Account.csv) y rechaza este a propósito.
 *
 * Formato (cabecera en español; fuentes: los tests de brokerDetect/degiroParser
 * del repo y parsers públicos como GeiserX/DeclaRenta, src/parsers/degiro.ts):
 *   Fecha,Hora,Producto,ISIN,Bolsa de,Centro de ejecución,Número,Precio,,
 *   Valor local,,Valor,,Tipo de cambio,[Comisión AutoFX,]Costes de transacción,,
 *   Total,,ID Orden
 * Las columnas sin nombre son la DIVISA de la columna anterior. Las cabeceras
 * cambian con el idioma de la cuenta, así que se buscan por nombre en varios
 * idiomas. Fechas DD-MM-AAAA; cantidad positiva = compra, negativa = venta;
 * «Valor» va en la moneda de la cuenta (negativo en las compras) y es el
 * importe en divisa («Valor local») convertido por DEGIRO con su «Tipo de cambio».
 *
 * Fase 1: solo cuentas en EUR. Por cada operación se toma el importe en euros de
 * «Valor» (el cambio que aplicó DEGIRO) y las comisiones en euros (costes de
 * transacción + comisión AutoFX si viene). Las filas que no se pueden pasar a
 * euros se descartan y se devuelven en `skipped` con el motivo.
 */

const norm = (s) => String(s ?? '').replace(/^\uFEFF/, '').replace(/"/g, '').trim().toLowerCase();

const NAMES = {
  date: ['fecha', 'date', 'datum', 'data'],
  time: ['hora', 'time', 'tijd', 'zeit', 'heure', 'ora'],
  product: ['producto', 'product', 'produkt', 'produit', 'produto', 'prodotto'],
  isin: ['isin'],
  qty: ['número', 'numero', 'cantidad', 'number', 'quantity', 'anzahl', 'aantal', 'quantité', 'quantidade', 'quantità'],
  price: ['precio', 'price', 'kurs', 'koers', 'prix', 'preço', 'prezzo'],
  localValue: ['valor local', 'local value', 'lokaler wert', 'lokale waarde', 'valeur locale', 'valore locale'],
  value: ['valor', 'value', 'wert', 'waarde', 'valeur', 'valore', 'valor eur', 'value eur', 'wert eur', 'waarde eur'],
  fx: ['tipo de cambio', 'exchange rate', 'wechselkurs', 'wisselkoers', 'taux de change', 'taxa de câmbio', 'tasso di cambio'],
  orderId: ['id orden', 'order id', 'auftragsnummer', 'id ordre', 'id da ordem', 'id ordine'],
};
const COST_PREFIXES = ['costes de transacción', 'costes de transaccion', 'transaction', 'transaktionskosten', 'transactiekosten', 'frais de transaction', 'custos de transação', 'costi di transazione'];

// No reutiliza el parseo del importador DEGIRO (degiroParser): es privado, devuelve 0 en
// valores inválidos y adivina el punto ambiguo. Aquí un número inválido debe devolver null
// para rechazar la fila.
/** Número de DEGIRO: «1234,56», «-1.234,56», «1,234.56» o «12.5». */
export function parseDegiroNumber(raw) {
  const s = String(raw ?? '').replace(/"/g, '').replace(/\s/g, '');
  if (!s) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let clean = s;
  if (lastComma > lastDot) clean = s.replace(/\./g, '').replace(',', '.');
  else if (lastComma >= 0) clean = s.replace(/,/g, '');
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

/** «03-02-2025» → «2025-02-03». */
function toIso(raw) {
  const m = String(raw ?? '').trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/**
 * Tope de tamaño del CSV que se lee en el navegador (20 MB). Un Transactions.csv
 * de años de operaciones pesa muy por debajo.
 */
export const MAX_CSV_BYTES = 20 * 1024 * 1024;
export const isCsvTooBig = (size) => size > MAX_CSV_BYTES;

/**
 * Tokenizador CSV conforme a RFC 4180 sobre TODO el texto: comillas dobles
 * escapadas («""») y saltos de línea DENTRO de un campo entre comillas.
 * Devuelve las filas con el número de línea (1-based) en que empiezan, o null
 * si queda una comilla sin cerrar o hay una comilla suelta fuera de sitio.
 */
export function tokenizeCsv(text, delim) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else {
          q = false;
          // Tras cerrar comillas solo cabe separador o fin de fila.
          const n = text[i + 1];
          if (n !== undefined && n !== delim && n !== '\n' && n !== '\r') return null;
        }
      } else {
        if (c === '\n') line++;
        cur += c;
      }
    } else if (c === '"') {
      // RFC 4180: la comilla solo abre un campo al principio. Una suelta en
      // mitad de un campo sin comillas fusionaría filas: fichero malformado.
      if (cur !== '') return null;
      q = true;
    }
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { /* CRLF: lo cierra el \n */ }
    else if (c === '\n' || c === '\r') {
      row.push(cur); rows.push({ line: rowLine, cells: row });
      row = []; cur = ''; line++; rowLine = line;
    } else cur += c;
  }
  if (q) return null;
  if (cur !== '' || row.length) { row.push(cur); rows.push({ line: rowLine, cells: row }); }
  return rows;
}

function resolveColumns(headers) {
  const h = headers.map(norm);
  const find = (names, from = 0) => h.findIndex((x, i) => i >= from && names.includes(x));
  const cols = {};
  for (const k of ['date', 'time', 'product', 'isin', 'qty', 'price', 'localValue', 'fx', 'orderId']) cols[k] = find(NAMES[k]);
  cols.value = find(NAMES.value, cols.localValue >= 0 ? cols.localValue + 1 : 0);
  cols.costs = h.findIndex((x) => COST_PREFIXES.some((p) => x.startsWith(p)));
  cols.autoFx = h.findIndex((x) => x.includes('autofx'));
  // Divisa: la columna sin nombre que sigue; si la cabecera ya dice «EUR», es EUR.
  const curOf = (i) => {
    if (i < 0) return { idx: -1, fixed: null };
    if (/\beur\b/.test(h[i])) return { idx: -1, fixed: 'EUR' };
    return h[i + 1] === '' ? { idx: i + 1, fixed: null } : { idx: -1, fixed: null };
  };
  cols.priceCur = curOf(cols.price);
  cols.localCur = curOf(cols.localValue);
  cols.valueCur = curOf(cols.value);
  cols.costsCur = curOf(cols.costs);
  cols.autoFxCur = curOf(cols.autoFx);
  return cols;
}

/**
 * @param {string} text  contenido del CSV
 * @returns {{
 *   ok: boolean, error?: 'empty'|'not_transactions'|'account_file'|'malformed',
 *   operations: Array<{ id, asset, product, type, date, time, qty, price, fee, eurValue, localValue, localCurrency, fxRate }>,
 *   skipped: Array<{ line: number, reason: 'date'|'qty'|'not_eur'|'fee_not_eur'|'no_value', asset: string|null }>,
 *   incompleteAssets: string[], incompleteAll: boolean,   // `operations` ya excluye esos valores
 *   products: Record<string, string>,
 * }}
 */
export function parseDegiroTransactions(text) {
  const empty = (error) => ({ ok: false, error, operations: [], skipped: [], products: {}, incompleteAssets: [], incompleteAll: false });
  const body = String(text ?? '').replace(/^\uFEFF/, '');
  if (!body.trim()) return empty('empty');
  // El separador se decide con la primera línea que nombra el ISIN.
  const firstLines = body.split(/\r?\n/, 50);
  const headerGuess = firstLines.find((l) => /(^|[,;"])\s*isin\s*("|[,;]|$)/i.test(l));
  if (!headerGuess) return empty('not_transactions');
  const delim = (headerGuess.match(/;/g) || []).length > (headerGuess.match(/,/g) || []).length ? ';' : ',';
  const rows = tokenizeCsv(body, delim);
  if (!rows) return empty('malformed');
  const headerIdx = rows.findIndex((r) => r.cells.some((x) => norm(x) === 'isin'));
  if (headerIdx < 0) return empty('not_transactions');
  const headers = rows[headerIdx].cells;
  const hn = headers.map(norm);
  if (hn.some((x) => ['descripción', 'descripcion', 'description', 'beschreibung', 'omschrijving'].includes(x))) return empty('account_file');
  const c = resolveColumns(headers);
  if (c.date < 0 || c.isin < 0 || c.qty < 0 || (c.value < 0 && c.localValue < 0)) return empty('not_transactions');

  const operations = [];
  const skipped = [];
  const products = {};
  const cell = (row, i) => (i >= 0 ? String(row[i] ?? '').trim() : ''); // ya sin comillas: las quita tokenizeCsv
  const cur = (row, spec) => (spec.fixed || cell(row, spec.idx).toUpperCase() || null);

  for (let ri = headerIdx + 1; ri < rows.length; ri++) {
    const { line: lineNo, cells: row } = rows[ri];
    if (row.every((x) => !String(x).trim())) continue;
    const isin = cell(row, c.isin).toUpperCase();
    const product = cell(row, c.product) || isin;
    const skip = (reason) => {
      skipped.push({ line: lineNo, reason, asset: isin || null });
      if (isin && product !== isin) products[isin] = products[isin] || product;
    };
    const date = toIso(cell(row, c.date));
    if (!date) { skip('date'); continue; }
    const signedQty = parseDegiroNumber(cell(row, c.qty));
    if (!signedQty) { skip('qty'); continue; }

    const localValue = parseDegiroNumber(cell(row, c.localValue));
    const localCurrency = cur(row, c.localCur) || cur(row, c.priceCur);
    const value = parseDegiroNumber(cell(row, c.value));
    const valueCurrency = cur(row, c.valueCur);
    let eurValue = null;
    if (value != null && valueCurrency === 'EUR') eurValue = Math.abs(value);
    else if (value != null && !valueCurrency && c.value >= 0 && localCurrency === 'EUR') eurValue = Math.abs(value);
    else if (value == null && localValue != null && localCurrency === 'EUR') eurValue = Math.abs(localValue);
    if (eurValue == null) { skip(value == null && localValue == null ? 'no_value' : 'not_eur'); continue; }

    let fee = 0;
    let feeOk = true;
    for (const [i, spec] of [[c.costs, c.costsCur], [c.autoFx, c.autoFxCur]]) {
      const v = parseDegiroNumber(cell(row, i));
      if (!v) continue;
      const fc = cur(row, spec);
      if (fc && fc !== 'EUR') { feeOk = false; break; }
      fee += Math.abs(v);
    }
    if (!feeOk) { skip('fee_not_eur'); continue; }

    const qty = Math.abs(signedQty);
    const key = isin || product.toUpperCase();
    products[key] = products[key] || product;
    operations.push({
      id: `l${lineNo}`,
      asset: key,
      product,
      type: signedQty > 0 ? 'buy' : 'sell',
      date,
      time: cell(row, c.time),
      qty,
      price: eurValue / qty,
      fee: Math.round(fee * 100) / 100,
      eurValue,
      localValue: localValue == null ? null : Math.abs(localValue),
      localCurrency,
      fxRate: parseDegiroNumber(cell(row, c.fx)),
    });
  }

  // DEGIRO lista de lo más reciente a lo más antiguo: se ordena por fecha y hora
  // (y, a igualdad, en el orden inverso del fichero) para que el FIFO vea el
  // orden real de las operaciones del mismo día.
  operations.forEach((op, i) => { op._i = i; });
  operations.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1)
    : a.time !== b.time ? (a.time < b.time ? -1 : 1) : b._i - a._i));
  operations.forEach((op) => { delete op._i; });

  // Un valor con alguna fila descartada NO se calcula: sin esa fila el FIFO
  // consumiría otros lotes y la regla de los dos meses no vería esa compra, así
  // que cualquier resultado suyo sería falso. Si una fila descartada no trae
  // ISIN no se sabe a qué valor pertenece: entonces no se calcula ninguno.
  const incompleteAll = skipped.some((sk) => !sk.asset);
  const incompleteSet = new Set(skipped.map((sk) => sk.asset).filter(Boolean));
  for (const sk of skipped) if (sk.asset && !products[sk.asset]) products[sk.asset] = sk.asset;
  const complete = incompleteAll ? [] : operations.filter((op) => !incompleteSet.has(op.asset));
  const incompleteAssets = incompleteAll
    ? [...new Set([...operations.map((op) => op.asset), ...incompleteSet])]
    : [...incompleteSet];

  return { ok: true, operations: complete, skipped, products, incompleteAssets, incompleteAll };
}
