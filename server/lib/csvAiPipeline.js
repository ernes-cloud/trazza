/**
 * Pure helpers for the AI CSV fallback (/api/analyze-csv).
 *
 * Chunking and row sanitisation are pure functions so the behaviour is pinned
 * by unit tests (csvAiPipeline.test.js) — same decision/IO split as the
 * deterministic import pipeline (src/services/import/).
 *
 * The route sends each chunk to the LLM with the header row repeated, then
 * sanitises every returned row before it reaches the client preview: the model
 * is never trusted with types, date formats, number types or money signs.
 */

export const CSV_CHUNK_ROWS = 60; // data rows per LLM call (header re-sent each time)
export const CSV_MAX_CHUNKS = 6;  // 360 analysable rows per import; beyond → truncated flag

/**
 * Split a CSV into LLM-sized chunks, repeating the header line in each so the
 * model can always map columns. Replaces the old hard truncation at 80 rows.
 *
 * @returns {{ chunks: string[], truncated: boolean, totalRows: number, analyzedRows: number }}
 *   totalRows/analyzedRows count DATA rows (header excluded).
 */
export function buildCsvChunks(csvText, { chunkRows = CSV_CHUNK_ROWS, maxChunks = CSV_MAX_CHUNKS } = {}) {
  const lines = String(csvText ?? '')
    .split('\n')
    .map(l => l.replace(/\r$/, ''))
    .filter(l => l.trim());

  if (lines.length === 0) {
    return { chunks: [], truncated: false, totalRows: 0, analyzedRows: 0 };
  }

  const [header, ...rows] = lines;
  if (rows.length === 0) {
    // Single-line input: still worth one call — some exports cram everything in one line
    return { chunks: [header], truncated: false, totalRows: 1, analyzedRows: 1 };
  }

  const chunks = [];
  for (let start = 0; start < rows.length && chunks.length < maxChunks; start += chunkRows) {
    chunks.push([header, ...rows.slice(start, start + chunkRows)].join('\n'));
  }

  const analyzedRows = Math.min(rows.length, chunkRows * maxChunks);
  return { chunks, truncated: rows.length > analyzedRows, totalRows: rows.length, analyzedRows };
}

const CSV_TYPES    = new Set(['BUY', 'SELL', 'DIVIDEND', 'FEES']);
const TYPE_ALIASES = { FEE: 'FEES', COMMISSION: 'FEES', DIV: 'DIVIDEND', PURCHASE: 'BUY' };
const CURRENCY_RE  = /^[A-Z]{3}$/;

// Downstream (importPlanner, netHoldings, CarteraPage sorters) requires DD-MM-YYYY.
// The model is told to output DD-MM-YYYY but sometimes emits ISO — normalise both.
function normaliseFecha(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, 10).replace(/[./]/g, '-');
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[3].padStart(2, '0')}-${m[2].padStart(2, '0')}-${m[1]}`;
  m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m) return `${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}-${m[3]}`;
  return null;
}

function normaliseHora(v) {
  if (typeof v !== 'string') return '00:00';
  const m = v.trim().match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '00:00';
}

function toFiniteNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v.replace(/\s+/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Validate/normalise one LLM row into the Trazza CSV-import schema
 * (same shape as parseDegiroCSV output). Returns null to discard the row.
 *
 * Guarantees for surviving rows:
 *  - type ∈ {BUY, SELL, DIVIDEND, FEES}
 *  - fecha is DD-MM-YYYY, hora is HH:MM
 *  - isin non-empty (identity key downstream)
 *  - cantidad/precio/comisiones are finite numbers ≥ 0
 *  - total sign is carried by type (BUY/FEES negative, SELL/DIVIDEND positive)
 */
export function sanitiseCsvRow(r) {
  if (!r || typeof r !== 'object') return null;

  const rawType = typeof r.type === 'string' ? r.type.toUpperCase().trim() : '';
  const type = CSV_TYPES.has(rawType) ? rawType : (TYPE_ALIASES[rawType] || null);
  if (!type) return null;

  const fecha = normaliseFecha(r.fecha);
  const isin  = (typeof r.isin === 'string' && r.isin.trim()) ? r.isin.trim().slice(0, 20) : null;
  if (!fecha || !isin) return null; // dates drive FIFO, isin drives asset identity

  const cantidad   = Math.abs(toFiniteNumber(r.cantidad) ?? 0);
  const precio     = Math.abs(toFiniteNumber(r.precio) ?? 0);
  const totalAbs   = Math.abs(toFiniteNumber(r.total) ?? 0);
  const comisiones = Math.abs(toFiniteNumber(r.comisiones) ?? 0);
  if (cantidad === 0 && precio === 0 && totalAbs === 0) return null; // no numeric signal

  const monedaRaw = typeof r.moneda === 'string' ? r.moneda.toUpperCase().trim() : '';
  const moneda = CURRENCY_RE.test(monedaRaw) ? monedaRaw : '';

  return {
    fecha,
    hora: normaliseHora(r.hora),
    type,
    producto: (typeof r.producto === 'string' && r.producto.trim()) ? r.producto.trim().slice(0, 120) : isin,
    isin,
    cantidad,
    precio,
    total: (type === 'BUY' || type === 'FEES') ? -totalAbs : totalAbs,
    moneda,
    comisiones,
  };
}

// Dedupe across chunks (repeated header rows, model double-emits)
export const csvRowHash = (r) =>
  `${r.fecha}|${r.hora}|${r.type}|${r.isin}|${r.cantidad}|${r.precio}|${r.total}`;
