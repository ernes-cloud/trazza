/**
 * MyInvestor Parser — two export formats behind one entry point:
 *
 * 1. "Operaciones" CSV (Mi cartera → Operaciones → Exportar CSV):
 *    Fecha de la orden;ISIN;Importe estimado;Nº de participaciones;Estado
 *
 * 2. "Movimientos" XLSX (the ONLY export some accounts offer — carteras de
 *    fondos). Arrives here as CSV text via xlsxReader.rowsToCsv:
 *      TITULAR/CUENTA/Saldo header block, then
 *      Fecha Operación;Fecha Valor;Movimiento;;Importe;Saldo
 *    No ISIN, no units, no price — only signed EUR amounts and a running
 *    balance (a ledger, like DeGiro's Account.csv). Fund rows become MONETARY
 *    BUYs/SELLs: cantidad = |importe|, precio = 1, noQuote = true so the
 *    import pipeline never resolves a live NAV for them (a name-based Yahoo
 *    match against qty-in-EUR would corrupt the position value).
 *
 * Shared conventions:
 * - Date:    DD/MM/YYYY → DD-MM-YYYY (matches DeGiro convention for calculateNetBuys)
 * - Amount:  "1325 EUR" or "1.325,40 EUR" → split into number + currency
 * - Shares:  European decimal — "9,139" → 9.139
 */

const stripDiacritics = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

// Quote-aware split (rowsToCsv escapes cells containing ';' or '"')
const splitSemicolonLine = (line) => {
  const cells = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ';' && !inQuote) {
      cells.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
};

// XLSX numeric cells arrive with DOT decimals ("-14.8"); header-block amounts
// can be European ("2,68€"). Handle both — never run European cleanup on a
// dot-decimal or "14.8" becomes 148.
const parseFlexibleNumber = (str) => {
  const cleaned = (str || '').replace(/[€$\s]/g, '');
  if (cleaned === '') return NaN;
  if (/^-?\d+(\.\d+)?$/.test(cleaned)) return parseFloat(cleaned);
  return parseFloat(cleaned.replace(/\./g, '').replace(',', '.'));
};

const DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const toDisplayDate = (str) => {
  const m = (str || '').trim().match(DATE_RE);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : (str || '');
};

// ── Movimientos (ledger) format ──────────────────────────────────────────────

const MOV_TRANSFER_KW = ['inicio cartera', 'aportacion', 'transferencia', 'ingreso', 'retirada', 'deposito', 'abono'];
const MOV_FEE_KW = ['comision', 'custodia', 'liquidac', 'interes'];

/**
 * Liquidación de intereses de la cuenta.
 *
 * El Excel de Movimientos NO trae el prefijo "Liquidac. Intereses" que sí pinta
 * la web: la fila llega como "PERIODO 02/07/2026 02/08/2026" a secas. Sin
 * reconocerla no casaba con ninguna palabra clave y caía al cajón de los
 * fondos, así que un abono de 0,33 € se importaba como la VENTA de un fondo
 * llamado "PERIODO 02/07/2026 02/08/2026" — un activo fantasma por cada mes de
 * intereses (visto en un extracto real de una cartera gestionada).
 *
 * Se exige la fecha detrás para no secuestrar un fondo que empiece por esa
 * palabra.
 */
const RE_MOV_INTERESES = /^periodo\s+\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/;

/**
 * "EFECTIVO-EUR": el efectivo DENTRO de la cartera de fondos. Sale del saldo de
 * la cuenta (la columna Saldo baja) pero sigue siendo dinero del usuario, así
 * que no es un fondo ni una salida: va a la liquidez final. Antes caía en "todo
 * lo demás es un fondo" y salía una posición "EFECTIVO-EUR [importe]".
 * El extracto real lo escribe "EFECTIVO-EUR @ 0" (la cola "@ participaciones"
 * de los fondos), así que la cola es opcional.
 */
const RE_MOV_EFECTIVO = /^efectivo[\s-]+[a-z]{3}(\s*@\s*[\d.,]+)?$/;

/**
 * Locates the movimientos table and returns its data rows, or null when the
 * text is not this format. Row: { line (1-based), fecha, descripcion, importe, saldo }.
 */
function prepareMovimientosRows(csvText) {
  const lines = (csvText || '').replace(/^﻿/, '').split('\n');

  let headerIdx = -1;
  let fechaIdx = -1, movIdx = -1, importeIdx = -1, saldoIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const cells = splitSemicolonLine(lines[i]).map(c => stripDiacritics(c.toLowerCase()));
    const mi = cells.findIndex(c => c.includes('movimiento'));
    const si = cells.findIndex(c => c.includes('saldo'));
    if (mi === -1 || si === -1) continue;
    headerIdx = i;
    movIdx = mi;
    saldoIdx = si;
    fechaIdx = cells.findIndex(c => c.includes('fecha'));
    importeIdx = cells.findIndex(c => c.includes('importe'));
    break;
  }
  if (headerIdx === -1 || fechaIdx === -1) return null;

  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = splitSemicolonLine(lines[i]);
    const fecha = (cells[fechaIdx] || '').trim();
    if (!DATE_RE.test(fecha)) continue;

    // Named columns first; fall back to a numeric scan right of the description
    // (some exports merge cells and shift the Importe column).
    let importe = parseFlexibleNumber(cells[importeIdx]);
    let saldo = parseFlexibleNumber(cells[saldoIdx]);
    if (Number.isNaN(importe) || Number.isNaN(saldo)) {
      const numeric = cells.slice(movIdx + 1).map(parseFlexibleNumber).filter(n => !Number.isNaN(n));
      if (numeric.length >= 2) {
        saldo = numeric[numeric.length - 1];
        importe = numeric[numeric.length - 2];
      } else if (numeric.length === 1 && Number.isNaN(importe)) {
        importe = numeric[0];
        saldo = NaN;
      }
    }
    if (Number.isNaN(importe)) continue;

    rows.push({
      line: i + 1,
      fecha,
      descripcion: (cells[movIdx] || '').trim(),
      importe,
      saldo,
    });
  }
  return rows.length > 0 ? rows : null;
}

// Ledger orientation: true when saldo_i ≈ saldo_{i-1} + importe_i holds for
// most rows (file is oldest-first, as MyInvestor exports it).
const chainMatches = (rows) => {
  let checked = 0, matched = 0;
  for (let i = 1; i < rows.length; i++) {
    if (Number.isNaN(rows[i].saldo) || Number.isNaN(rows[i - 1].saldo)) continue;
    checked++;
    if (Math.abs(rows[i - 1].saldo + rows[i].importe - rows[i].saldo) < 0.011) matched++;
  }
  return { checked, matched };
};

/**
 * Fund descriptions with an "@" tail carry real execution data:
 *  - "NAME qty @ price" — trusted only when qty×price reproduces the amount
 *  - "NAME @ X"         — X is the number of UNITS (verified against real
 *    NAVs: "VANGUARD 20 @ 0.21" for 28.42€ → 135.33/unit, matching the
 *    fund's market NAV that day); price is derived as |importe| / X
 * Anything unverifiable keeps the monetary representation with the "@" tail
 * stripped so the same fund always groups under a stable name.
 */
function parseFundDescription(descripcion, absAmount) {
  const qtyAtPrice = descripcion.match(/^(.+?)\s+(\d+(?:[.,]\d+)?)\s*@\s*(\d+(?:[.,]\d+)?)$/);
  if (qtyAtPrice) {
    const qty = parseFlexibleNumber(qtyAtPrice[2]);
    const price = parseFlexibleNumber(qtyAtPrice[3]);
    if (qty > 0 && price > 0 && Math.abs(qty * price - absAmount) <= Math.max(0.05, absAmount * 0.02)) {
      return { producto: qtyAtPrice[1].trim(), cantidad: qty, precio: price };
    }
  }

  const atUnits = descripcion.match(/^(.+?)\s*@\s*(\d+(?:[.,]\d+)?)$/);
  if (atUnits) {
    const units = parseFlexibleNumber(atUnits[2]);
    if (units > 0 && absAmount > 0) {
      return {
        producto: atUnits[1].trim(),
        cantidad: units,
        precio: Math.round((absAmount / units) * 100) / 100, // transactions.price is scale 2
      };
    }
  }

  return {
    producto: descripcion.replace(/\s*@\s*[\d.,]+$/, '').trim(),
    cantidad: absAmount,
    precio: 1,
  };
}

function parseMovimientos(rows) {
  const transactions = [];
  let efectivoCartera = 0; // ver RE_MOV_EFECTIVO

  rows.forEach(({ fecha, descripcion, importe }) => {
    if (importe === 0) return; // account-opening 0.0 rows carry no information
    const desc = stripDiacritics(descripcion.toLowerCase());
    if (RE_MOV_EFECTIVO.test(desc.trim())) {
      efectivoCartera -= importe;
      return;
    }
    const fechaDisplay = toDisplayDate(fecha);

    const base = {
      fecha: fechaDisplay,
      hora: '00:00',
      descripcion,
      moneda: 'EUR',
      comisiones: 0,
    };

    // startsWith, not includes: cash-movement descriptions BEGIN with the action
    // word ("Retirada de efectivo"), while fund names contain the same Spanish
    // vocabulary mid-name ("AMUNDI EURO INGRESO" is a BUY, not a transfer).
    if (RE_MOV_INTERESES.test(desc) || MOV_FEE_KW.some(kw => desc.startsWith(kw))) {
      transactions.push({ ...base, type: 'FEE', producto: '', isin: '', cantidad: 0, precio: 0, total: importe });
      return;
    }
    if (descripcion === '' || MOV_TRANSFER_KW.some(kw => desc.startsWith(kw))) {
      transactions.push({ ...base, type: 'TRANSFER', producto: '', isin: '', cantidad: 0, precio: 0, total: importe });
      return;
    }

    // Anything else is a fund subscription (negative) or redemption (positive)
    const absAmount = Math.abs(importe);
    const { producto, cantidad, precio } = parseFundDescription(descripcion, absAmount);
    transactions.push({
      ...base,
      type: importe < 0 ? 'BUY' : 'SELL',
      producto,
      isin: '',
      cantidad,
      precio,
      total: importe < 0 ? -absAmount : absAmount,
      noQuote: true, // no ISIN — never let a name-based quote search price these
    });
  });

  // Ending-cash snapshot from the ledger's running balance (same convention as
  // DeGiro/IBKR: netHoldings anchors the broker's cash on isEndingCash rows).
  const withSaldo = rows.filter(r => !Number.isNaN(r.saldo));
  if (withSaldo.length > 0) {
    const { checked, matched } = chainMatches(withSaldo);
    const oldestFirst = checked === 0 || matched >= checked * 0.5;
    const lastRow = oldestFirst ? withSaldo[withSaldo.length - 1] : withSaldo[0];
    transactions.push({
      fecha: toDisplayDate(lastRow.fecha),
      hora: '23:59:59',
      producto: 'Líquidez (EUR)',
      isin: 'CASH_EUR',
      descripcion: 'Saldo Final: EUR',
      type: 'CASH',
      cantidad: 0,
      precio: 0,
      total: Math.round((lastRow.saldo + efectivoCartera) * 100) / 100,
      moneda: 'EUR',
      comisiones: 0,
      isEndingCash: true,
    });
  }

  return transactions;
}

/**
 * Reconciles every movimiento against the file's own Saldo column (the export
 * is a ledger). Same return shape as auditDegiroLedger so the preview reuses
 * cartera.audit_ok / audit_mismatches: { checked, matched, mismatches } | null.
 */
export function auditMyInvestorLedger(csvText) {
  const rows = prepareMovimientosRows(csvText);
  if (!rows) return null;
  const ledger = rows.filter(r => !Number.isNaN(r.saldo));
  if (ledger.length < 2) return null;

  const runChain = (list) => {
    let checked = 0, matched = 0;
    const mismatches = [];
    for (let i = 1; i < list.length; i++) {
      checked++;
      const expected = list[i - 1].saldo + list[i].importe;
      if (Math.abs(expected - list[i].saldo) < 0.011) matched++;
      else mismatches.push({ line: list[i].line, currency: 'EUR', expected, actual: list[i].saldo });
    }
    return { checked, matched, mismatches };
  };

  const forward = runChain(ledger); // oldest-first (MyInvestor's export order)
  if (forward.matched >= forward.checked * 0.5) return forward;
  const backward = runChain([...ledger].reverse());
  return backward.matched > forward.matched ? backward : forward;
}

export function parseMyInvestorCSV(csvText) {
  const text = csvText.replace(/^﻿/, ''); // Strip UTF-8 BOM if present

  // Movimientos (XLSX ledger) format takes priority: it has a Movimiento+Saldo
  // header the Operaciones CSV never has.
  const movimientosRows = prepareMovimientosRows(text);
  if (movimientosRows) return parseMovimientos(movimientosRows);

  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 2) return [];

  const splitLine = (line) => line.split(';').map(s => s.trim().replace(/^"|"$/g, ''));

  // Normalise headers: lowercase + strip diacritics for robust column matching
  const headers = splitLine(lines[0]).map(h =>
    h.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  );

  // Partial-match column lookup — tolerates minor wording/order differences
  const idx = (keyword) => headers.findIndex(h => h.includes(keyword));
  const idxDate   = idx('fecha');
  const idxIsin   = idx('isin');
  const idxAmount = idx('importe');
  const idxShares = idx('participaciones');
  const idxStatus = idx('estado');

  if (idxDate === -1 || idxIsin === -1 || idxAmount === -1 || idxShares === -1) {
    throw new Error(
      'Formato MyInvestor no reconocido — exporta desde "Mi cartera → Operaciones → Exportar CSV".'
    );
  }

  // "9,139" or "9.139" → 9.139  (European decimal, no ambiguous thousands here)
  const parseEuropean = (str) => {
    if (!str) return 0;
    return parseFloat(str.replace(/\./g, '').replace(',', '.')) || 0;
  };

  // "1325 EUR" or "1.325,40 EUR" → { amount: 1325.40, currency: 'EUR' }
  const parseAmountField = (str) => {
    const m = (str || '').trim().match(/^([+-]?[\d.,]+)\s+([A-Z]{3})$/);
    if (m) return { amount: parseEuropean(m[1]), currency: m[2] };
    return { amount: parseEuropean(str), currency: 'EUR' };
  };

  // "DD/MM/YYYY" → "DD-MM-YYYY"  (matches DeGiro date convention)
  const convertDate = (str) => {
    const m = (str || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : (str || '');
  };

  const transactions = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = splitLine(lines[i]);
    if (cols.length < 4) continue;

    // Skip non-completed orders (pending, cancelled, etc.)
    const status = idxStatus !== -1 ? cols[idxStatus] : 'finalizada';
    if (status.toLowerCase() !== 'finalizada') continue;

    const isin  = cols[idxIsin]  || '';
    const fecha = convertDate(cols[idxDate]);
    const { amount, currency } = parseAmountField(cols[idxAmount]);
    const shares = parseEuropean(cols[idxShares]);

    if (!isin || shares === 0) continue;

    const type   = amount >= 0 ? 'BUY' : 'SELL';
    const absAmt = Math.abs(amount);
    const precio = shares > 0 ? absAmt / shares : 0;

    transactions.push({
      fecha,
      hora:       '00:00',
      type,
      producto:   isin,   // No name column — fetchPricesForImported resolves via ISIN search
      isin,
      cantidad:   shares,
      precio,
      moneda:     currency,
      total:      type === 'BUY' ? -absAmt : absAmt,
      comisiones: 0,
    });
  }

  return transactions;
}
