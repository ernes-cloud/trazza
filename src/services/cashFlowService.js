/**
 * Cash flow parsing and aggregation for the DeGiro account CSV export.
 *
 * DeGiro CSV format (comma-delimited, European numbers):
 *   Fecha, Hora, Fecha valor, Producto, ISIN, Descripción, Tipo, Variación(cur), Variación(amt), Saldo(cur), Saldo(amt), ID Orden
 *
 * The file is sorted newest-first, so the FIRST row for a given day is the
 * end-of-day balance. We take it as-is for saldoEfectivo.
 */

const CASH_FLOW_KEYWORDS = [
  'flatex deposit',
  'flatex withdrawal',
  'ingreso',
  'retirada',
  'withdrawal',
  'deposit',
  'transferir desde su cuenta de efectivo',
];

// RFC 4180 CSV parser — handles quoted fields containing commas/newlines.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const n = text.length;

  for (let i = 0; i < n; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\r' && next === '\n') {
        row.push(field);
        field = '';
        rows.push(row);
        row = [];
        i++;
      } else if (ch === '\n' || ch === '\r') {
        row.push(field);
        field = '';
        rows.push(row);
        row = [];
      } else {
        field += ch;
      }
    }
  }

  // Flush last field/row
  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

// "15-10-2024" → "2024-10-15"
function parseDateDMY(str) {
  if (!str) return null;
  const parts = str.trim().split('-');
  if (parts.length !== 3) return null;
  const [d, m, y] = parts;
  if (y.length !== 4) return null;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// Handles both European ("1.993,70", "-843,75") and standard ("1993.70") number strings.
// Strips surrounding whitespace and quotes before parsing.
function parseEuropeanNumber(raw) {
  if (raw == null) return NaN;
  let s = String(raw).trim().replace(/^"|"$/g, '');
  if (s === '' || s === '-') return NaN;

  // Detect European format: ends with ,\d{1,2} (comma as decimal separator)
  if (/,\d{1,2}$/.test(s)) {
    // Remove thousand separators (dots), replace decimal comma with dot
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    // Standard format: remove commas used as thousand separators
    s = s.replace(/,/g, '');
  }

  return parseFloat(s);
}

function isDepositOrWithdrawal(description) {
  if (!description) return false;
  const lower = description.toLowerCase();
  return CASH_FLOW_KEYWORDS.some(kw => lower.includes(kw));
}

/**
 * Parse a DeGiro Account.csv export and return daily cash-flow data.
 *
 * @param {string} csvString - Raw CSV text from DeGiro account export
 * @returns {{ date: string, aportacionAcumulada: number, saldoEfectivo: number|null }[]}
 *   Sorted ascending by date.
 */
export function processDegiroCSV(csvString) {
  if (!csvString || !csvString.trim()) return [];

  const allRows = parseCSV(csvString.trim());
  if (allRows.length < 2) return [];

  // Skip header row; remaining rows are newest-first.
  const dataRows = allRows.slice(1).filter(r => r.length >= 11);

  // dayMap: date → { balanceEOD: number|null, netDeposit: number }
  // DeGiro CSV is newest-first → first row seen for a day = EOD balance.
  const dayMap = {};

  dataRows.forEach(cols => {
    const dateStr = parseDateDMY(cols[0]);
    if (!dateStr) return;

    const description = (cols[5] || '').trim();
    const variacionAmt = parseEuropeanNumber(cols[8]);  // col index 8 = variación amount
    const saldoAmt = parseEuropeanNumber(cols[10]);     // col index 10 = balance amount

    if (!dayMap[dateStr]) {
      dayMap[dateStr] = {
        balanceEOD: Number.isFinite(saldoAmt) ? saldoAmt : null,
        netDeposit: 0,
      };
    }

    if (isDepositOrWithdrawal(description) && Number.isFinite(variacionAmt)) {
      dayMap[dateStr].netDeposit += variacionAmt;
    }
  });

  // Sort days ascending and build cumulative deposit total.
  const sortedDays = Object.keys(dayMap).sort();
  let cumulativeDeposit = 0;
  const result = [];

  sortedDays.forEach(date => {
    const { balanceEOD, netDeposit } = dayMap[date];
    cumulativeDeposit += netDeposit;
    result.push({
      date,
      aportacionAcumulada: Math.round(cumulativeDeposit * 100) / 100,
      saldoEfectivo: balanceEOD !== null ? Math.round(balanceEOD * 100) / 100 : null,
    });
  });

  return result;
}
