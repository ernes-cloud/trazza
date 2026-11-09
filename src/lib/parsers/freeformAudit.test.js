import { describe, it, expect } from 'vitest';
import { auditFreeformRows, readNumberToken, numbersIn, sourceLines } from './freeformAudit';

/* Extracto real: "Movimientos" de una cartera gestionada copiado de la web del
   banco. Llega apilado —fecha suelta de cabecera, y luego pares
   descripción/importe— que es donde el modelo desplazó el emparejamiento. */
const MOVIMIENTOS = `07/09/2026
Suscripcion Iic ISHARES EMERGING MARKETS INDEX
15,10 €
Suscripcion Iic FIDELITY MSCI JAPAN INDEX P AC
16,21 €
Suscripcion Iic FIDELITY MSCI PACFC EXJAPN IDX
4,47 €
04/09/2026
Suscripcion Iic ISHARES US INDEX FUND IE S EUR
81,89 €
Suscripcion Iic ISHARES ESG SCREENED GLB CORP
39,08 €
Suscripcion Iic FIDELITY MSCI EUROPE INDEX P A
20,01 €
03/09/2026
Suscripcion Iic BGIF EM MKT GOVER BOND INDEX D
13,84 €
Liquidac. Intereses PERIODO 02/08/2026 02/09/2026
0,06 €
01/09/2026
Abono Por Traspaso Aportacion a mi cartera
250,00 €`;

const row = (over = {}) => ({
  date: '2026-09-04', ticker: null, assetName: 'X', type: 'BUY',
  quantity: null, price: null, amount: null, currency: 'EUR', sourceLine: '', ...over,
});

describe('readNumberToken — cómo se lee un número escrito por un banco', () => {
  it('lee la coma decimal española', () => {
    expect(readNumberToken('15,10')).toContain(15.1);
    expect(readNumberToken('81,89')).toContain(81.89);
  });

  it('lee el punto decimal inglés', () => {
    expect(readNumberToken('0.24')).toContain(0.24);
  });

  it('resuelve el millar cuando hay los dos separadores', () => {
    expect(readNumberToken('1.234,56')).toContain(1234.56);
    expect(readNumberToken('1,234.56')).toContain(1234.56);
  });

  it('admite LAS DOS lecturas de una cola de tres cifras, que es ambigua', () => {
    // "0,589 participaciones" son 0,589; "1,234 €" podrían ser 1234
    expect(readNumberToken('0,589')).toContain(0.589);
    expect(readNumberToken('1,234')).toEqual(expect.arrayContaining([1.234, 1234]));
  });

  it('ignora la puntuación pegada al final', () => {
    expect(readNumberToken('15,10.')).toContain(15.1);
  });
});

describe('numbersIn — no confunde una fecha con un importe', () => {
  it('parte la fecha en sus tres números y no inventa uno', () => {
    expect(numbersIn('07/09/2026')).toEqual([7, 9, 2026]);
  });

  it('saca el importe de una línea con símbolo de divisa', () => {
    expect(numbersIn('81,89 €')).toContain(81.89);
  });
});

describe('sourceLines — misma numeración que el servidor', () => {
  it('recorta y descarta las líneas vacías', () => {
    expect(sourceLines('  a  \n\n\n  b ')).toEqual(['a', 'b']);
  });
});

describe('auditFreeformRows — caza el importe emparejado con el nombre que no es', () => {
  it('marca la fila que se llevó el importe del grupo siguiente', () => {
    // El fallo REAL: a "ISHARES US INDEX" (81,89) le pusieron 39,08, que es el
    // importe del ESG Screened, dos líneas más abajo.
    const out = auditFreeformRows([
      row({ assetName: 'ISHARES US INDEX FUND IE S EUR', amount: 39.08, sourceLine: 'Suscripcion Iic ISHARES US INDEX FUND IE S EUR' }),
    ], MOVIMIENTOS);
    expect(out[0].unverified).toEqual(['amount']);
  });

  it('deja en paz la fila bien emparejada', () => {
    const out = auditFreeformRows([
      row({ assetName: 'ISHARES US INDEX FUND IE S EUR', amount: 81.89, sourceLine: 'Suscripcion Iic ISHARES US INDEX FUND IE S EUR' }),
      row({ assetName: 'ISHARES ESG SCREENED GLB CORP', amount: 39.08, sourceLine: 'Suscripcion Iic ISHARES ESG SCREENED GLB CORP' }),
      row({ type: 'DEPOSIT', assetName: null, amount: 250, sourceLine: 'Abono Por Traspaso Aportacion a mi cartera' }),
      row({ type: 'FEE', assetName: null, amount: 0.06, sourceLine: 'Liquidac. Intereses PERIODO 02/08/2026 02/09/2026' }),
    ], MOVIMIENTOS);
    expect(out.map((r) => r.unverified)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('marca un importe inventado que no está en ninguna parte', () => {
    const out = auditFreeformRows([
      row({ amount: 999.99, sourceLine: 'Suscripcion Iic BGIF EM MKT GOVER BOND INDEX D' }),
    ], MOVIMIENTOS);
    expect(out[0].unverified).toEqual(['amount']);
  });

  it('acepta las participaciones de una orden, con su cola de tres cifras', () => {
    const ORDENES = `02/09/2026
Suscripción Fondos de Inversión Fidelity MSCI Pacific ex-Japan Index Fund P-ACC-USD
5,17 US$
Puntual
Finalizada
0,589 participaciones`;
    const out = auditFreeformRows([
      row({ amount: 5.17, quantity: 0.589, currency: 'USD', sourceLine: 'Suscripción Fondos de Inversión Fidelity MSCI Pacific ex-Japan Index Fund P-ACC-USD' }),
    ], ORDENES);
    expect(out[0].unverified).toBeUndefined();
  });

  it('no marca nada cuando no hay texto contra el que auditar (vía de imágenes)', () => {
    const rows = [row({ amount: 123.45, sourceLine: 'AAPL 10 @ 150' })];
    expect(auditFreeformRows(rows, '')).toEqual(rows);
    expect(auditFreeformRows(rows, null)).toEqual(rows);
  });

  it('no marca una fila cuya línea de origen no aparece: es inauditable, no sospechosa', () => {
    const out = auditFreeformRows([
      row({ amount: 42, sourceLine: 'una línea que no está en el texto' }),
    ], MOVIMIENTOS);
    expect(out[0].unverified).toBeUndefined();
  });

  it('compara en valor absoluto: el signo lo lleva el tipo, no el número', () => {
    const out = auditFreeformRows([
      row({ type: 'FEE', amount: 2.5, sourceLine: 'Comision de custodia' }),
    ], 'Comision de custodia\n-2,50 €');
    expect(out[0].unverified).toBeUndefined();
  });

  it('audita el importe contra la propia línea cuando el formato no es apilado', () => {
    const UNA_LINEA = '24/05/2026 Compra 10 AAPL @ 150,50 USD total 1.505,00';
    const ok = auditFreeformRows([row({ amount: 1505, sourceLine: UNA_LINEA })], UNA_LINEA);
    expect(ok[0].unverified).toBeUndefined();

    const mal = auditFreeformRows([row({ amount: 1600 , sourceLine: UNA_LINEA })], UNA_LINEA);
    expect(mal[0].unverified).toEqual(['amount']);
  });

  it('el PRECIO no se audita: casi nunca está escrito, se deriva', () => {
    // Un extracto de fondos da importe y participaciones, no el NAV unitario;
    // exigir que el precio aparezca marcaría en ámbar filas correctas.
    const out = auditFreeformRows([
      row({ amount: 15.1, price: 99, sourceLine: 'Suscripcion Iic ISHARES EMERGING MARKETS INDEX' }),
    ], MOVIMIENTOS);
    expect(out[0].unverified).toBeUndefined();
  });

  it('caza la cantidad que se llevó del registro ANTERIOR', () => {
    // Caso real: al pegar unas "Órdenes", diez de diecisiete filas se llevaron
    // las participaciones del registro de arriba. Los importes cuadraban, así
    // que sin auditar la cantidad el error pasaba entero.
    const ORDENES = `02/09/2026
Suscripción Fondos de Inversión iShares ESG Screened Global Corporate Bond Index Fund EUR Hedged
39,09 €
Puntual
Finalizada
4,06 participaciones
Suscripción Fondos de Inversión iShares US Equity Index Fund clase S
81,97 €
Puntual
Finalizada
6,7 participaciones`;

    const out = auditFreeformRows([
      row({ amount: 39.09, quantity: 4.06, sourceLine: 'Suscripción Fondos de Inversión iShares ESG Screened Global Corporate Bond Index Fund EUR Hedged' }),
      // Esta se lleva 4,06 — las participaciones del ESG, que están MÁS ARRIBA
      row({ amount: 81.97, quantity: 4.06, sourceLine: 'Suscripción Fondos de Inversión iShares US Equity Index Fund clase S' }),
    ], ORDENES);

    expect(out[0].unverified).toBeUndefined();
    expect(out[1].unverified).toEqual(['quantity']);
  });

  it('acepta la cantidad correcta aunque esté cuatro renglones más abajo', () => {
    const ORDENES = `02/09/2026
Suscripción Fondos de Inversión iShares US Equity Index Fund clase S
81,97 €
Puntual
Finalizada
6,7 participaciones`;
    const out = auditFreeformRows([
      row({ amount: 81.97, quantity: 6.7, sourceLine: 'Suscripción Fondos de Inversión iShares US Equity Index Fund clase S' }),
    ], ORDENES);
    expect(out[0].unverified).toBeUndefined();
  });

  it('no rompe con filas vacías ni con una lista vacía', () => {
    expect(auditFreeformRows([], MOVIMIENTOS)).toEqual([]);
    expect(auditFreeformRows(null, MOVIMIENTOS)).toEqual([]);
  });
});
