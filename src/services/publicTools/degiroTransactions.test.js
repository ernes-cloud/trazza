import { describe, it, expect } from 'vitest';
import { parseDegiroTransactions, parseDegiroNumber, isCsvTooBig, MAX_CSV_BYTES } from './degiroTransactions';
import { computeCapitalGains } from './capitalGains';

// CSV de EJEMPLO, INVENTADO para los tests (no son operaciones reales de nadie).
// Copia el formato del Transactions.csv de DEGIRO en español: columnas sin nombre
// con la divisa, decimales con coma entre comillas, lo más reciente arriba.
const HEADER = 'Fecha,Hora,Producto,ISIN,Bolsa de,Centro de ejecución,Número,Precio,,Valor local,,Valor,,Tipo de cambio,Costes de transacción,,Total,,ID Orden';
const EXAMPLE_CSV = [
  HEADER,
  '15-01-2025,10:05,EJEMPLO ETF MUNDIAL,IE00EJEMPLO01,EAM,XAMS,-15,"130,00",EUR,"-1950,00",EUR,"1950,00",EUR,,"-2,00",EUR,"1948,00",EUR,ord-3',
  '01-06-2023,09:30,EJEMPLO ETF MUNDIAL,IE00EJEMPLO01,EAM,XAMS,10,"120,00",EUR,"-1200,00",EUR,"-1200,00",EUR,,"-2,00",EUR,"-1202,00",EUR,ord-2',
  '10-01-2023,09:30,EJEMPLO ETF MUNDIAL,IE00EJEMPLO01,EAM,XAMS,10,"100,00",EUR,"-1000,00",EUR,"-1000,00",EUR,,"-2,00",EUR,"-1002,00",EUR,ord-1',
].join('\n');

describe('parseDegiroNumber', () => {
  it('lee coma decimal, punto de miles y formato inglés', () => {
    expect(parseDegiroNumber('"1234,56"')).toBe(1234.56);
    expect(parseDegiroNumber('-1.234,56')).toBe(-1234.56);
    expect(parseDegiroNumber('1,234.56')).toBe(1234.56);
    expect(parseDegiroNumber('12.5')).toBe(12.5);
    expect(parseDegiroNumber('')).toBeNull();
  });
});

describe('parseDegiroTransactions — CSV de ejemplo', () => {
  it('saca compras y ventas en euros, ordenadas de la más antigua a la más reciente', () => {
    const r = parseDegiroTransactions(EXAMPLE_CSV);
    expect(r.ok).toBe(true);
    expect(r.skipped).toEqual([]);
    expect(r.operations.map((o) => [o.date, o.type, o.qty, o.fee])).toEqual([
      ['2023-01-10', 'buy', 10, 2],
      ['2023-06-01', 'buy', 10, 2],
      ['2025-01-15', 'sell', 15, 2],
    ]);
    expect(r.operations[0].price).toBeCloseTo(100, 6);
    expect(r.products.IE00EJEMPLO01).toBe('EJEMPLO ETF MUNDIAL');
  });

  it('con computeCapitalGains da el FIFO con comisiones (art. 35 y 37.2 LIRPF)', () => {
    const r = computeCapitalGains(parseDegiroTransactions(EXAMPLE_CSV).operations);
    // Coste: 1.002 + 5 × 120,20 = 1.603; importe: 1.950 − 2 = 1.948 → +345
    expect(r.sales[0].cost).toBeCloseTo(1603, 2);
    expect(r.sales[0].proceeds).toBeCloseTo(1948, 2);
    expect(r.sales[0].gain).toBeCloseTo(345, 2);
  });

  it('usa el «Valor» en EUR de DEGIRO para operaciones en divisa y suma la comisión AutoFX', () => {
    const csv = [
      'Fecha,Hora,Producto,ISIN,Bolsa de,Centro de ejecución,Número,Precio,,Valor local,,Valor,,Tipo de cambio,Comisión AutoFX,Costes de transacción,,Total,,ID Orden',
      '03-02-2025,15:40,EJEMPLO CORP,US0000EJEMP1,NDQ,XNAS,4,"200,00",USD,"-800,00",USD,"-740,00",EUR,"1,0811","-1,85","-1,00",EUR,"-742,85",EUR,ord-9',
    ].join('\n');
    const [op] = parseDegiroTransactions(csv).operations;
    expect(op).toMatchObject({ type: 'buy', qty: 4, eurValue: 740, localValue: 800, localCurrency: 'USD', fxRate: 1.0811, fee: 2.85 });
  });

  it('también lee la cabecera en inglés separada por punto y coma', () => {
    const csv = [
      'Date;Time;Product;ISIN;Reference exchange;Venue;Quantity;Price;;Local value;;Value;;Exchange rate;Transaction and/or third party fees;;Total;;Order ID',
      '05-03-2024;11:00;SAMPLE PLC;GB00SAMPLE01;LSE;XLON;-3;12,5;GBP;37,5;GBP;43,80;EUR;0,8562;-4,90;EUR;38,90;EUR;ord-x',
    ].join('\n');
    const [op] = parseDegiroTransactions(csv).operations;
    expect(op).toMatchObject({ type: 'sell', qty: 3, eurValue: 43.8, fee: 4.9 });
  });

  it('descarta (y explica) lo que no está en euros: cuenta en otra moneda', () => {
    const csv = [HEADER, '10-01-2023,09:30,X,IE00EJEMPLO01,EAM,XAMS,10,"100,00",USD,"-1000,00",USD,"-1000,00",USD,,"-2,00",USD,"-1002,00",USD,ord-1'].join('\n');
    const r = parseDegiroTransactions(csv);
    expect(r.operations).toHaveLength(0);
    expect(r.skipped).toEqual([{ line: 2, reason: 'not_eur', asset: 'IE00EJEMPLO01' }]);
  });

  it('reconoce el Estado de cuenta (Account.csv) y otros ficheros como equivocados', () => {
    expect(parseDegiroTransactions('Fecha,Hora,Fecha valor,Producto,ISIN,Descripción,Tipo,Variación,,Saldo,,ID Orden').error).toBe('account_file');
    expect(parseDegiroTransactions('a,b,c\n1,2,3').error).toBe('not_transactions');
    expect(parseDegiroTransactions('').error).toBe('empty');
  });

  it('marca la regla de los dos meses (art. 33.5.f LIRPF) con datos del CSV', () => {
    const csv = [
      HEADER,
      '20-03-2025,10:00,EJEMPLO ETF MUNDIAL,IE00EJEMPLO01,EAM,XAMS,10,"80,00",EUR,"-800,00",EUR,"-800,00",EUR,,,,"-800,00",EUR,ord-3',
      '01-03-2025,10:00,EJEMPLO ETF MUNDIAL,IE00EJEMPLO01,EAM,XAMS,-10,"80,00",EUR,"800,00",EUR,"800,00",EUR,,,,"800,00",EUR,ord-2',
      '10-01-2024,10:00,EJEMPLO ETF MUNDIAL,IE00EJEMPLO01,EAM,XAMS,10,"100,00",EUR,"-1000,00",EUR,"-1000,00",EUR,,,,"-1000,00",EUR,ord-1',
    ].join('\n');
    const r = computeCapitalGains(parseDegiroTransactions(csv).operations);
    expect(r.sales[0].gain).toBeCloseTo(-200, 2);
    expect(r.sales[0].deferred).toBeCloseTo(200, 2);
  });
});

describe('valores con filas descartadas (revisión d350801a)', () => {
  it('compras de 10 y 20 € con una venta descartada: ese ISIN no se calcula', () => {
    const csv = [
      HEADER,
      '10-04-2025,10:00,EJEMPLO ETF MUNDIAL,IE00EJEMPLO01,EAM,XAMS,-10,"20,00",EUR,"200,00",EUR,"200,00",EUR,,,,"200,00",EUR,o4',
      '01-03-2025,10:00,EJEMPLO ETF MUNDIAL,IE00EJEMPLO01,EAM,XAMS,-10,"15,00",GBP,"150,00",GBP,"150,00",GBP,,,,"150,00",GBP,o3',
      '01-02-2025,10:00,EJEMPLO ETF MUNDIAL,IE00EJEMPLO01,EAM,XAMS,10,"20,00",EUR,"-200,00",EUR,"-200,00",EUR,,,,"-200,00",EUR,o2',
      '01-01-2025,10:00,EJEMPLO ETF MUNDIAL,IE00EJEMPLO01,EAM,XAMS,10,"10,00",EUR,"-100,00",EUR,"-100,00",EUR,,,,"-100,00",EUR,o1',
      '01-01-2025,11:00,OTRO EJEMPLO,IE00EJEMPLO02,EAM,XAMS,1,"5,00",EUR,"-5,00",EUR,"-5,00",EUR,,,,"-5,00",EUR,o5',
    ].join('\n');
    const r = parseDegiroTransactions(csv);
    expect(r.incompleteAssets).toEqual(['IE00EJEMPLO01']);
    expect(r.operations.every((o) => o.asset === 'IE00EJEMPLO02')).toBe(true);
    expect(computeCapitalGains(r.operations).sales).toHaveLength(0);
  });

  it('una compra descartada dentro de los dos meses: no se aplica la regla con datos incompletos', () => {
    const csv = [
      HEADER,
      '20-03-2025,10:00,EJEMPLO ETF MUNDIAL,IE00EJEMPLO01,EAM,XAMS,10,"80,00",USD,"-800,00",USD,"-800,00",USD,,,,"-800,00",USD,o3',
      '01-03-2025,10:00,EJEMPLO ETF MUNDIAL,IE00EJEMPLO01,EAM,XAMS,-10,"80,00",EUR,"800,00",EUR,"800,00",EUR,,,,"800,00",EUR,o2',
      '10-01-2024,10:00,EJEMPLO ETF MUNDIAL,IE00EJEMPLO01,EAM,XAMS,10,"100,00",EUR,"-1000,00",EUR,"-1000,00",EUR,,,,"-1000,00",EUR,o1',
    ].join('\n');
    const r = parseDegiroTransactions(csv);
    expect(r.skipped).toEqual([{ line: 2, reason: 'not_eur', asset: 'IE00EJEMPLO01' }]);
    expect(r.incompleteAssets).toEqual(['IE00EJEMPLO01']);
    expect(r.operations).toEqual([]);
  });

  it('una fila descartada sin ISIN deja sin calcular todos los valores', () => {
    const csv = [HEADER, 'xx-01-2025,10:00,,,,,1,,,,,,,,,,,,', EXAMPLE_CSV.split('\n')[3]].join('\n');
    const r = parseDegiroTransactions(csv);
    expect(r.incompleteAll).toBe(true);
    expect(r.operations).toEqual([]);
    expect(r.incompleteAssets).toEqual(['IE00EJEMPLO01']);
  });
});

describe('CSV conforme a RFC 4180', () => {
  it('admite saltos de línea y comillas escapadas dentro de un campo entre comillas', () => {
    const csv = [HEADER, '10-01-2023,09:30,"EJEMPLO ""ETF""\nMUNDIAL",IE00EJEMPLO01,EAM,XAMS,10,"100,00",EUR,"-1000,00",EUR,"-1000,00",EUR,,"-2,00",EUR,"-1002,00",EUR,ord-1'].join('\r\n');
    const r = parseDegiroTransactions(csv);
    expect(r.skipped).toEqual([]);
    expect(r.operations).toHaveLength(1);
    expect(r.operations[0].product).toBe('EJEMPLO "ETF"\nMUNDIAL');
  });

  it('rechaza con error claro una comilla sin cerrar', () => {
    const csv = [HEADER, '10-01-2023,09:30,"EJEMPLO,IE00EJEMPLO01,EAM,XAMS,10'].join('\n');
    expect(parseDegiroTransactions(csv).error).toBe('malformed');
  });

  it('rechaza una comilla suelta en mitad de un campo sin comillas (no fusiona filas)', () => {
    const csv = [
      HEADER,
      '15-01-2025,10:05,EJEMPLO ETF "MUNDIAL,IE00EJEMPLO01,EAM,XAMS,-10,"130,00",EUR,"-1300,00",EUR,"1300,00",EUR,,"-2,00",EUR,"1298,00",EUR,ord-2',
      '10-01-2023,09:30,EJEMPLO ETF MUNDIAL,IE00EJEMPLO01,EAM,XAMS,10,"110,00",EUR,"-1100,00",EUR,"-1100,00",EUR,,"-2,00",EUR,"-1102,00",EUR,ord-1',
    ].join('\n');
    const r = parseDegiroTransactions(csv);
    expect(r.ok).toBeFalsy();
    expect(r.error).toBe('malformed');
    expect(r.operations ?? []).toEqual([]);
  });

  it('rechaza comillas sueltas en número par en un CSV sin comillas (no fusiona filas en silencio)', () => {
    // Sin la guarda, las dos comillas «se cierran» entre sí: las filas o2 y o1 se
    // fusionan y sale ok con 3 operaciones de 4, sin ningún aviso.
    const H = 'Fecha,Hora,Producto,ISIN,Bolsa de,Centro de ejecución,Número,Precio,,Valor local,,Valor,,Tipo de cambio,Costes de transacción,,Total,,ID Orden';
    const csv = [
      H,
      '10-06-2025,10:00,TV PANEL,IE00T,EAM,XAMS,-10,30,EUR,300,EUR,300,EUR,,,,300,EUR,o4',
      '01-03-2025,10:00,TV PANEL,IE00T,EAM,XAMS,10,25,EUR,-250,EUR,-250,EUR,,,,-250,EUR,o3',
      '01-02-2025,10:00,TV 55" PANEL,IE00T,EAM,XAMS,10,20,EUR,-200,EUR,-200,EUR,,,,-200,EUR,o2',
      '01-01-2025,10:00,MONITOR 27",IE00T,EAM,XAMS,10,10,EUR,-100,EUR,-100,EUR,,,,-100,EUR,o1',
    ].join('\n');
    const r = parseDegiroTransactions(csv);
    expect(r.ok).toBeFalsy();
    expect(r.error).toBe('malformed');
    expect(r.operations ?? []).toEqual([]);
  });

  it('rechaza texto pegado tras cerrar comillas', () => {
    const csv = [HEADER, '10-01-2023,09:30,"EJEMPLO"X,IE00EJEMPLO01,EAM,XAMS,10,"100,00",EUR,"-1000,00",EUR,"-1000,00",EUR,,"-2,00",EUR,"-1002,00",EUR,ord-1'].join('\n');
    expect(parseDegiroTransactions(csv).error).toBe('malformed');
  });
});

describe('tope de tamaño del CSV', () => {
  it('es de 20 MB y rechaza solo lo que lo supera', () => {
    expect(MAX_CSV_BYTES).toBe(20 * 1024 * 1024);
    expect(isCsvTooBig(MAX_CSV_BYTES)).toBe(false);
    expect(isCsvTooBig(MAX_CSV_BYTES + 1)).toBe(true);
    expect(isCsvTooBig(21 * 1024 * 1024)).toBe(true);
  });
});
