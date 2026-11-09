/**
 * Minimal XLSX reader — dependency-free.
 *
 * MyInvestor (and some other brokers) only export XLSX; an .xlsx is a ZIP of
 * OOXML parts. Instead of shipping SheetJS (the npm build carries known CVEs)
 * or exceljs (~1 MB) to read ONE sheet, this parses the ZIP directory and the
 * two XML parts we need (sharedStrings + first worksheet) directly, inflating
 * with the browser/Node-native DecompressionStream('deflate-raw').
 *
 * Scope (deliberate): first worksheet only, cell types s/str/inlineStr/n/b.
 * Dates stored as text (the broker exports "DD/MM/YYYY" strings) come through
 * verbatim; numeric cells come through as raw strings with dot decimals.
 */

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_STORED = 0;
const ZIP_DEFLATED = 8;
const EOCD_SEARCH_WINDOW = 65 * 1024; // EOCD comment can be up to 64 KB

const xlsxError = (message) => {
  const err = new Error(message);
  err.code = 'xlsx_unreadable';
  return err;
};

const findEndOfCentralDirectory = (view) => {
  const start = Math.max(0, view.byteLength - EOCD_SEARCH_WINDOW);
  for (let i = view.byteLength - 22; i >= start; i--) {
    if (view.getUint32(i, true) === ZIP_EOCD_SIG) return i;
  }
  return -1;
};

/** ZIP central directory → { name → { method, offset, compressedSize } } */
const readZipDirectory = (buffer) => {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) throw xlsxError('Not a ZIP container (no end-of-central-directory)');

  const entryCount = view.getUint16(eocd + 10, true);
  let pos = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries = {};

  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(pos, true) !== ZIP_CENTRAL_SIG) {
      throw xlsxError('Corrupt ZIP central directory');
    }
    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    entries[name] = { method, compressedSize, localOffset };
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
};

const inflateEntry = async (buffer, entry) => {
  const view = new DataView(buffer);
  const { localOffset, method, compressedSize } = entry;
  // Local header: name/extra lengths can differ from the central directory's
  const nameLen = view.getUint16(localOffset + 26, true);
  const extraLen = view.getUint16(localOffset + 28, true);
  const dataStart = localOffset + 30 + nameLen + extraLen;
  const data = new Uint8Array(buffer, dataStart, compressedSize);

  if (method === ZIP_STORED) return new TextDecoder().decode(data);
  if (method !== ZIP_DEFLATED) throw xlsxError(`Unsupported ZIP compression method ${method}`);

  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const inflated = await new Response(stream).arrayBuffer();
  return new TextDecoder().decode(inflated);
};

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXmlEntities = (text) =>
  text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? m : String.fromCodePoint(code);
    }
    return XML_ENTITIES[body] ?? m;
  });

/** Concatenate every <t> run inside a fragment (rich-text strings have several) */
const extractTextRuns = (fragment) =>
  decodeXmlEntities(
    [...fragment.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('')
  );

const parseSharedStrings = (xml) =>
  [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((m) => extractTextRuns(m[1]));

const columnLetterToIndex = (letters) => {
  let index = 0;
  for (let i = 0; i < letters.length; i++) index = index * 26 + (letters.charCodeAt(i) - 64);
  return index - 1;
};

const parseSheetRows = (xml, sharedStrings) => {
  const rows = [];
  for (const [, rowInner] of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const [, attrs, cellInner = ''] of rowInner.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
      if (!ref) continue;
      const type = /t="(\w+)"/.exec(attrs)?.[1];
      let value = '';
      if (type === 'inlineStr') {
        value = extractTextRuns(cellInner);
      } else {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(cellInner)?.[1];
        if (raw !== undefined) {
          value = type === 's' ? (sharedStrings[Number(raw)] ?? '') : decodeXmlEntities(raw);
        }
      }
      cells[columnLetterToIndex(ref)] = value;
    }
    // Densify: index gaps (skipped columns) become empty strings
    rows.push(Array.from(cells, (c) => c ?? ''));
  }
  return rows;
};

/**
 * ArrayBuffer of an .xlsx → dense string matrix of the first worksheet.
 * Throws { code: 'xlsx_unreadable' } for anything that isn't a readable workbook.
 */
export async function extractXlsxRows(arrayBuffer) {
  if (!arrayBuffer || arrayBuffer.byteLength < 22) throw xlsxError('File too small to be an XLSX');

  const entries = readZipDirectory(arrayBuffer);
  const sheetName = Object.keys(entries)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0];
  if (!sheetName) throw xlsxError('No worksheet found inside the XLSX');

  const sharedStrings = entries['xl/sharedStrings.xml']
    ? parseSharedStrings(await inflateEntry(arrayBuffer, entries['xl/sharedStrings.xml']))
    : [];

  return parseSheetRows(await inflateEntry(arrayBuffer, entries[sheetName]), sharedStrings);
}

/**
 * String matrix → CSV text (semicolon-delimited) so XLSX uploads can flow
 * through the exact same text pipeline as CSV files (parsers, ledger audit,
 * AI fallback, anonymized failure reports). Fully empty rows are dropped.
 */
export function rowsToCsv(rows, delimiter = ';') {
  const escapeCell = (cell) => {
    const s = String(cell ?? '');
    return s.includes(delimiter) || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  return rows
    .filter((row) => row.some((cell) => String(cell ?? '').trim() !== ''))
    .map((row) => row.map(escapeCell).join(delimiter))
    .join('\n');
}
