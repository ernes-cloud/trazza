import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { extractXlsxRows, rowsToCsv } from './xlsxReader';

// Construye un .xlsx mínimo (ZIP + OOXML) en memoria. Replica la estructura del
// export real de MyInvestor (Movimientos_*.xlsx): sharedStrings + celdas numéricas
// inline, datos que empiezan en la columna B, celdas vacías intercaladas.

const te = new TextEncoder();

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** Zip STORE/DEFLATE de una lista de {name, text, deflate} → Uint8Array */
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, text, deflate } of entries) {
    const nameBytes = te.encode(name);
    const raw = te.encode(text);
    const data = deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
    const method = deflate ? 8 : 0;
    const crc = crc32(raw);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);

    chunks.push(local, data);
    central.push(cd);
    offset += local.length + data.length;
  }

  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const all = [...chunks, ...central, eocd];
  const total = all.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of all) { out.set(c, pos); pos += c.length; }
  return out;
}

const SHARED_STRINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="5" uniqueCount="5"><si><t>Fecha Operación</t></si><si><t>Movimiento</t></si><si><t>Inicio cartera</t></si><si><t>FIDELITY MSCI EUROPE &amp; ASIA</t></si><si><t xml:space="preserve">14/06/2026</t></si></sst>`;

// Fila 1: cabecera en B..D (A vacía). Fila 2: fecha compartida, movimiento, importe
// numérico inline. Fila 3: celda self-closing (vacía) + string con entidad XML.
const SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="B1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c><c r="D1" t="str"><v>Importe</v></c></row>
<row r="2"><c r="B2" t="s"><v>4</v></c><c r="C2" t="s"><v>2</v></c><c r="D2"><v>207.49</v></c></row>
<row r="3"><c r="B3" t="s"><v>4</v></c><c r="C3" t="s"><v>3</v></c><c r="D3"><v>-14.8</v></c><c r="E3"/></row>
<row r="4"><c r="B4" t="inlineStr"><is><t>inline</t></is></c></row>
</sheetData></worksheet>`;

const buildTestXlsx = ({ deflate }) => buildZip([
  { name: '[Content_Types].xml', text: '<Types/>', deflate },
  { name: 'xl/workbook.xml', text: '<workbook/>', deflate },
  { name: 'xl/sharedStrings.xml', text: SHARED_STRINGS, deflate },
  { name: 'xl/worksheets/sheet1.xml', text: SHEET, deflate },
]).buffer;

describe('extractXlsxRows — lector XLSX sin dependencias', () => {
  it.each([{ deflate: false }, { deflate: true }])(
    'extrae la matriz de celdas (entradas %j)',
    async ({ deflate }) => {
      const rows = await extractXlsxRows(buildTestXlsx({ deflate }));
      expect(rows).toHaveLength(4);
      // A vacía, cabecera desde B; t="str" también se lee
      expect(rows[0]).toEqual(['', 'Fecha Operación', 'Movimiento', 'Importe']);
      // shared string + número inline como string crudo (decimal con punto)
      expect(rows[1]).toEqual(['', '14/06/2026', 'Inicio cartera', '207.49']);
      // entidad XML decodificada; celda self-closing vacía
      expect(rows[2]).toEqual(['', '14/06/2026', 'FIDELITY MSCI EUROPE & ASIA', '-14.8', '']);
      // inline string (t="inlineStr")
      expect(rows[3]).toEqual(['', 'inline']);
    }
  );

  it('lanza error tipado con un archivo que no es ZIP', async () => {
    const garbage = te.encode('esto no es un xlsx').buffer;
    await expect(extractXlsxRows(garbage)).rejects.toMatchObject({ code: 'xlsx_unreadable' });
  });

  it('lanza error tipado si el ZIP no contiene hoja de cálculo', async () => {
    const zip = buildZip([{ name: 'hello.txt', text: 'hi', deflate: false }]).buffer;
    await expect(extractXlsxRows(zip)).rejects.toMatchObject({ code: 'xlsx_unreadable' });
  });
});

describe('rowsToCsv — conversión a texto CSV para el pipeline existente', () => {
  it('une con ; y escapa celdas con delimitador, comillas o saltos de línea', () => {
    const csv = rowsToCsv([
      ['Fecha', 'Movimiento', 'Importe'],
      ['14/06/2026', 'FONDO; RARO', '207.49'],
      ['15/06/2026', 'Nombre "quoted"', '-14.8'],
    ]);
    expect(csv.split('\n')).toEqual([
      'Fecha;Movimiento;Importe',
      '14/06/2026;"FONDO; RARO";207.49',
      '15/06/2026;"Nombre ""quoted""";-14.8',
    ]);
  });

  it('las filas totalmente vacías se omiten', () => {
    const csv = rowsToCsv([['a', 'b'], ['', ''], ['c', 'd']]);
    expect(csv.split('\n')).toEqual(['a;b', 'c;d']);
  });
});
