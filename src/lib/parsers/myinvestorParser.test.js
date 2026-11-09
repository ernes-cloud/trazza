import { describe, it, expect } from 'vitest';
import { parseMyInvestorCSV, auditMyInvestorLedger } from './myinvestorParser';

// ── Formato Movimientos (XLSX → CSV via xlsxReader.rowsToCsv) ────────────────
// Estructura del export real "Movimientos_*.xlsx" de una cartera de fondos
// MyInvestor, anonimizado: cabecera TITULAR/CUENTA/Saldo, tabla
// Fecha Operación | Fecha Valor | Movimiento | (vacía) | Importe | Saldo.
// Sin ISIN, sin participaciones, sin precio: solo importes EUR y saldo corrido.

const MOVIMIENTOS_FIXTURE = [
  ';;;TITULAR:;NOMBRE APELLIDO APELLIDO',
  ';;;CUENTA:;0000000000',
  ';;;Saldo:;2,68€',
  ';Movimientos',
  ';Fecha Operación;Fecha Valor;Movimiento;;Importe;Saldo',
  ';14/06/2026;14/06/2026;;;0.0;0.0',
  ';14/06/2026;14/06/2026;Inicio cartera;;207.49;207.49',
  ';14/06/2026;14/06/2026;;;90.0;297.49',
  ';15/06/2026;18/06/2026;BGIF EM MKT GOVER BOND INDEX D;;-14.8;282.69',
  ';16/06/2026;17/06/2026;VANGUARD 20 @ 0.21;;-28.42;254.27',
  ';16/06/2026;17/06/2026;VANGUARD US GOVERNMENT BD INDE;;-29.55;224.72',
  ';16/06/2026;17/06/2026;FIDELITY MSCI EUROPE INDEX P A;;-23.68;201.04',
  ';16/06/2026;18/06/2026;ISHARES ESG SCREENED GLB CORP;;-44.4;156.64',
  ';16/06/2026;18/06/2026;ISHARES US INDEX FUND IE S EUR;;-100.64;56.0',
  ';17/06/2026;18/06/2026;FIDELITY MSCI PACFC EXJAPN IDX;;-5.96;50.04',
  ';17/06/2026;18/06/2026;FIDELITY MSCI JAPAN INDEX P AC;;-23.68;26.36',
  ';17/06/2026;22/06/2026;ISHARES EMERGING MARKETS INDEX;;-23.68;2.68',
].join('\n');

describe('parseMyInvestorCSV — formato Movimientos (cartera de fondos, XLSX)', () => {
  const txs = parseMyInvestorCSV(MOVIMIENTOS_FIXTURE);

  it('detecta el formato y clasifica todos los movimientos', () => {
    const byType = txs.reduce((acc, t) => ({ ...acc, [t.type]: (acc[t.type] || 0) + 1 }), {});
    // 2 aportaciones (la fila 0.0 se omite), 9 compras de fondos, 1 snapshot de caja
    expect(byType).toEqual({ TRANSFER: 2, BUY: 9, CASH: 1 });
  });

  it('aportaciones → TRANSFER con importe firmado y fecha DD-MM-YYYY', () => {
    const transfers = txs.filter(t => t.type === 'TRANSFER');
    expect(transfers[0]).toMatchObject({ fecha: '14-06-2026', total: 207.49, moneda: 'EUR' });
    expect(transfers[1]).toMatchObject({ fecha: '14-06-2026', total: 90.0, moneda: 'EUR' });
  });

  it('compra de fondo → BUY monetario: cantidad=importe, precio=1, sin ISIN, noQuote', () => {
    const buy = txs.find(t => t.producto === 'BGIF EM MKT GOVER BOND INDEX D');
    expect(buy).toMatchObject({
      type: 'BUY',
      fecha: '15-06-2026',
      isin: '',
      cantidad: 14.8,
      precio: 1,
      total: -14.8,
      moneda: 'EUR',
      comisiones: 0,
      noQuote: true,
    });
  });

  it('descripción "NOMBRE @ X" → X son PARTICIPACIONES; precio = importe / X', () => {
    // Verificado contra el NAV real del fondo: 28.42€ / 0.21 uds = 135.33,
    // y el NAV de mercado de "VANGUARD 20" ese día era ≈135.9 — el sufijo
    // "@ X" del extracto MyInvestor son unidades, no precio.
    const buy = txs.find(t => t.producto === 'VANGUARD 20');
    expect(buy).toMatchObject({ type: 'BUY', cantidad: 0.21, precio: 135.33, total: -28.42, noQuote: true });
  });

  it('emite snapshot de caja final (isEndingCash) con el último saldo del ledger', () => {
    const cash = txs.find(t => t.type === 'CASH');
    expect(cash).toMatchObject({
      isin: 'CASH_EUR',
      moneda: 'EUR',
      total: 2.68,
      isEndingCash: true,
      fecha: '17-06-2026',
    });
  });

  it('reembolso de fondo (importe positivo con nombre) → SELL', () => {
    const withSell = MOVIMIENTOS_FIXTURE + '\n;18/06/2026;19/06/2026;ISHARES US INDEX FUND IE S EUR;;50.0;52.68';
    const sell = parseMyInvestorCSV(withSell).find(t => t.type === 'SELL');
    expect(sell).toMatchObject({
      producto: 'ISHARES US INDEX FUND IE S EUR',
      cantidad: 50.0,
      precio: 1,
      total: 50.0,
      noQuote: true,
    });
  });

  it('comisiones → FEE, retiradas → TRANSFER negativo', () => {
    const extra = MOVIMIENTOS_FIXTURE
      + '\n;18/06/2026;18/06/2026;Comisión de gestión;;-0.35;2.33'
      + '\n;19/06/2026;19/06/2026;Retirada de efectivo;;-2.0;0.33';
    const parsed = parseMyInvestorCSV(extra);
    expect(parsed.find(t => t.type === 'FEE')).toMatchObject({ total: -0.35, moneda: 'EUR' });
    const retirada = parsed.filter(t => t.type === 'TRANSFER').find(t => t.total < 0);
    expect(retirada).toMatchObject({ total: -2.0, fecha: '19-06-2026' });
  });

  it('nombre de fondo que CONTIENE una palabra de transferencia → sigue siendo BUY', () => {
    // "INGRESO"/"ABONO" son vocabulario habitual en nombres de fondos de reparto;
    // solo una descripción que EMPIEZA por la palabra clave es un movimiento de caja.
    const extra = MOVIMIENTOS_FIXTURE
      + '\n;18/06/2026;19/06/2026;AMUNDI EURO INGRESO;;-200.0;-197.32'
      + '\n;18/06/2026;19/06/2026;FONDO ABONO GLOBAL;;-50.0;-247.32';
    const parsed = parseMyInvestorCSV(extra);
    expect(parsed.find(t => t.producto === 'AMUNDI EURO INGRESO')?.type).toBe('BUY');
    expect(parsed.find(t => t.producto === 'FONDO ABONO GLOBAL')?.type).toBe('BUY');
    // Y las descripciones de caja reales siguen clasificando como TRANSFER
    expect(parsed.filter(t => t.type === 'TRANSFER')).toHaveLength(2);
  });

  it('descripción "@" con aritmética consistente → unidades y precio reales', () => {
    const extra = MOVIMIENTOS_FIXTURE + '\n;18/06/2026;19/06/2026;FONDO EJEMPLO 2 @ 14.21;;-28.42;-25.74';
    const buy = parseMyInvestorCSV(extra).find(t => t.producto === 'FONDO EJEMPLO');
    expect(buy).toMatchObject({ type: 'BUY', cantidad: 2, precio: 14.21, total: -28.42, noQuote: true });
  });
});

describe('parseMyInvestorCSV — formato Operaciones (CSV con ISIN, regresión)', () => {
  it('el formato antiguo sigue parseando igual', () => {
    const csv = [
      'Fecha de la orden;ISIN;Importe estimado;Nº de participaciones;Estado',
      '10/01/2026;IE00B4L5Y983;500 EUR;5,25;Finalizada',
      '12/01/2026;IE00B4L5Y983;-200 EUR;2,10;Finalizada',
      '13/01/2026;IE00B4L5Y983;100 EUR;1,00;Pendiente',
    ].join('\n');
    const txs = parseMyInvestorCSV(csv);
    expect(txs).toHaveLength(2); // la pendiente se omite
    expect(txs[0]).toMatchObject({ type: 'BUY', isin: 'IE00B4L5Y983', cantidad: 5.25, total: -500 });
    expect(txs[1]).toMatchObject({ type: 'SELL', isin: 'IE00B4L5Y983', cantidad: 2.10, total: 200 });
  });
});

describe('auditMyInvestorLedger — reconciliación contra la columna Saldo', () => {
  it('el fixture real cuadra completo', () => {
    const audit = auditMyInvestorLedger(MOVIMIENTOS_FIXTURE);
    expect(audit).not.toBeNull();
    expect(audit.checked).toBeGreaterThanOrEqual(11);
    expect(audit.mismatches).toEqual([]);
    expect(audit.matched).toBe(audit.checked);
  });

  it('un saldo corrupto señala la línea exacta', () => {
    const corrupted = MOVIMIENTOS_FIXTURE.replace(';-14.8;282.69', ';-14.8;999.99');
    const audit = auditMyInvestorLedger(corrupted);
    expect(audit.mismatches.length).toBeGreaterThan(0);
    expect(audit.matched).toBeLessThan(audit.checked);
  });

  it('devuelve null para el formato Operaciones (no es un ledger)', () => {
    const csv = 'Fecha de la orden;ISIN;Importe estimado;Nº de participaciones;Estado\n10/01/2026;IE00B4L5Y983;500 EUR;5,25;Finalizada';
    expect(auditMyInvestorLedger(csv)).toBeNull();
  });
});

describe('Movimientos — la liquidación de intereses no es un fondo', () => {
  // El Excel se come el prefijo "Liquidac. Intereses" que sí pinta la web: la
  // fila llega como "PERIODO <fecha> <fecha>" a secas. Sin reconocerla, un
  // abono de céntimos se importaba como la VENTA de un fondo llamado
  // "PERIODO 02/07/2026 02/08/2026" — un activo fantasma por cada mes.
  const CON_INTERESES = [
    ';;;TITULAR:;NOMBRE APELLIDO APELLIDO',
    ';;;CUENTA:;0000000000',
    ';;;Saldo:;80,33€',
    ';Movimientos',
    ';Fecha Operación;Fecha Valor;Movimiento;;Importe;Saldo',
    ';02/07/2026;02/07/2026;Aportacion a mi cartera;;100.0;100.0',
    ';06/07/2026;07/07/2026;FIDELITY MSCI EUROPE INDEX P A;;-20.0;80.0',
    ';03/08/2026;02/08/2026;PERIODO 02/07/2026 02/08/2026;;0.33;80.33',
  ].join('\n');

  const tx = parseMyInvestorCSV(CON_INTERESES);

  it('la clasifica como comisión/interés, no como venta', () => {
    const intereses = tx.filter(t => t.type === 'FEE');
    expect(intereses).toHaveLength(1);
    expect(intereses[0].total).toBe(0.33);
  });

  it('no crea ningún activo llamado "PERIODO …"', () => {
    expect(tx.some(t => /PERIODO/i.test(t.producto || ''))).toBe(false);
    expect(tx.some(t => t.type === 'SELL')).toBe(false);
  });

  it('no secuestra un fondo cuyo nombre empiece por esa palabra', () => {
    const conFondo = CON_INTERESES.replace(
      'PERIODO 02/07/2026 02/08/2026',
      'PERIODO GLOBAL EQUITY FUND'
    ).replace(';;0.33;', ';;-0.33;');
    const filas = parseMyInvestorCSV(conFondo);
    expect(filas.some(t => t.type === 'BUY' && /PERIODO GLOBAL/i.test(t.producto))).toBe(true);
  });
});

describe('parseMyInvestorCSV — fila EFECTIVO-EUR (2026-10-15)', () => {
  // Reimport real: "EFECTIVO-EUR" acababa como un FONDO "[importe]" de 0,45 €.
  // Es el efectivo de la cartera: sale del saldo de la cuenta pero sigue siendo
  // dinero del usuario, así que va a la liquidez y no a una posición.
  // El extracto real (Movimientos 13-10-2026) lo escribe "EFECTIVO-EUR @ 0", con
  // la cola "@ participaciones" de los fondos; se prueban las dos grafías.
  describe.each(['EFECTIVO-EUR @ 0', 'EFECTIVO-EUR'])('descripción "%s"', (descripcion) => {
    const withEfectivo = MOVIMIENTOS_FIXTURE + `\n;18/06/2026;18/06/2026;${descripcion};;-0.45;2.23`;
    const txs = parseMyInvestorCSV(withEfectivo);

    it('no crea ninguna compra de "EFECTIVO-EUR"', () => {
      expect(txs.some((t) => /EFECTIVO/i.test(t.producto || ''))).toBe(false);
      expect(txs.filter((t) => t.type === 'BUY')).toHaveLength(9);
    });

    it('el efectivo de la cartera se suma a la liquidez final', () => {
      const cash = txs.find((t) => t.isEndingCash);
      expect(cash.total).toBeCloseTo(2.68, 2); // saldo 2,23 + 0,45 de efectivo
      expect(cash.fecha).toBe('18-06-2026');
    });
  });
});
