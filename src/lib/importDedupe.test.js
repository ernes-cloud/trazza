import { describe, it, expect } from 'vitest';
import { transCheckKey, csvRowsNotInDb, previewTxKey, DEDUPE_SELECT_FIELDS } from './importDedupe';

describe('transCheckKey — BUY/SELL', () => {
  it('la fila del DB (price escala 2) casa con la fila del CSV (precio crudo)', () => {
    // Arrange: el CSV trae 556.4886, el DB lo almacenó como 556.49
    const dbRow = {
      transaction_type: 'BUY',
      transaction_date: '2024-05-12T09:30:00',
      quantity: 3,
      price: 556.49,
      position_id: 'pos-1',
    };
    const csvRow = {
      transaction_type: 'BUY',
      transaction_date: '2024-05-12T09:30:00',
      quantity: 3,
      price: 556.4886,
      position_id: 'pos-1',
    };

    // Act + Assert
    expect(transCheckKey(csvRow)).toBe(transCheckKey(dbRow));
  });

  it('cantidades distintas producen claves distintas', () => {
    const base = {
      transaction_type: 'SELL',
      transaction_date: '2024-05-12T09:30:00',
      price: 100,
      position_id: 'pos-1',
    };
    expect(transCheckKey({ ...base, quantity: 3 })).not.toBe(transCheckKey({ ...base, quantity: 4 }));
  });
});

describe('transCheckKey — DIVIDEND/FEE/TAX/CASH/TRANSFER (regresión duplicados en re-import)', () => {
  const csvDividend = {
    transaction_type: 'DIVIDEND',
    transaction_date: '2024-06-01T00:00:00',
    quantity: 0,
    price: 0,
    total_amount: 23.45,
    notes: 'Dividendo META PLATFORMS INC',
    position_id: 'pos-2',
  };

  it('la fila del DB con total_amount casa con la del CSV', () => {
    const dbRow = { ...csvDividend, id: 'row-1', eur_total: null, commission: null };
    expect(transCheckKey(dbRow)).toBe(transCheckKey(csvDividend));
  });

  it('BUG histórico: sin total_amount en el SELECT la clave NO casa (esto duplicaba dividendos)', () => {
    // El SELECT antiguo no traía total_amount → el lado "existente" siempre era 0.00
    const dbRowOldSelect = { ...csvDividend };
    delete dbRowOldSelect.total_amount;
    expect(transCheckKey(dbRowOldSelect)).not.toBe(transCheckKey(csvDividend));
  });

  it('el SELECT compartido incluye total_amount', () => {
    expect(DEDUPE_SELECT_FIELDS.split(',').map(s => s.trim())).toContain('total_amount');
  });

  it('dos comisiones iguales el mismo día se distinguen por el concepto', () => {
    const base = {
      transaction_type: 'FEES',
      transaction_date: '2024-01-02T00:00:00',
      total_amount: 2.5,
      position_id: 'pos-3',
    };
    const feeA = { ...base, notes: 'Comisión de conectividad NASDAQ' };
    const feeB = { ...base, notes: 'Comisión de conectividad XETRA' };
    expect(transCheckKey(feeA)).not.toBe(transCheckKey(feeB));
  });

  it('el importe se normaliza en valor absoluto con 2 decimales', () => {
    const a = { transaction_type: 'TRANSFER', transaction_date: 'd', total_amount: -500, notes: 'Retirada', position_id: 'p' };
    const b = { transaction_type: 'TRANSFER', transaction_date: 'd', total_amount: 500.004, notes: 'Retirada', position_id: 'p' };
    expect(transCheckKey(a)).toBe(transCheckKey(b));
  });
});

describe('transCheckKey — normalización de fecha (timestamptz vs string del cliente)', () => {
  it('la fecha del DB con sufijo de zona horaria casa con la del cliente', () => {
    const csvRow = {
      transaction_type: 'DIVIDEND',
      transaction_date: '2026-03-26T17:09:00',
      total_amount: 23.45,
      notes: 'Dividendo',
      position_id: 'pos-1',
    };
    const dbTz = { ...csvRow, transaction_date: '2026-03-26T17:09:00+00:00' };
    const dbMs = { ...csvRow, transaction_date: '2026-03-26T17:09:00.000Z' };
    expect(transCheckKey(dbTz)).toBe(transCheckKey(csvRow));
    expect(transCheckKey(dbMs)).toBe(transCheckKey(csvRow));
  });

  it('fechas realmente distintas siguen produciendo claves distintas', () => {
    const base = { transaction_type: 'BUY', quantity: 1, price: 10, position_id: 'p' };
    const a = { ...base, transaction_date: '2026-03-26T17:09:00' };
    const b = { ...base, transaction_date: '2026-03-26T17:09:01' };
    expect(transCheckKey(a)).not.toBe(transCheckKey(b));
  });
});

describe('csvRowsNotInDb — dedupe MULTISET del preview (fills parciales idénticos)', () => {
  // Fill DeGiro/IBKR: una orden ejecutada como N trades idénticos (misma qty/precio/minuto)
  const fill = (over = {}) => ({
    type: 'BUY',
    fecha: '15-04-2025',
    hora: '15:30',
    isin: 'US0231351067',
    producto: 'Amazon.com Inc (USD)',
    cantidad: 1,
    precio: 163,
    total: -163,
    ...over,
  });

  it('REGRESIÓN (Amazon de Enric): BD dañada con 1 fill de 2 → el fill sobrante del CSV SOBREVIVE', () => {
    // El Set de clave única descartaba AMBOS fills del CSV contra la única fila
    // guardada → netBuys contaba qty 1 y el re-sync nunca reparaba el coste.
    const dbRows = [fill()];               // solo se guardó un fill (bug antiguo)
    const csvRows = [fill(), fill()];      // el CSV trae los dos trades reales
    const survivors = csvRowsNotInDb(csvRows, dbRows);
    expect(survivors).toHaveLength(1);     // 1 consumido por la BD, 1 se re-inserta
  });

  it('BD ya reparada (2 fills guardados): los 2 fills del CSV se consumen, no se duplican', () => {
    const survivors = csvRowsNotInDb([fill(), fill()], [fill(), fill()]);
    expect(survivors).toHaveLength(0);
  });

  it('import fresco (BD vacía): todos los fills idénticos sobreviven', () => {
    const survivors = csvRowsNotInDb([fill(), fill()], []);
    expect(survivors).toHaveLength(2);
  });

  it('la clave BUY/SELL compara el precio a 2 decimales (columna price con escala 2)', () => {
    // CSV 556.4886 vs BD 556.49 — deben casar (si no, el trade se contaba dos veces)
    const dbRow = fill({ precio: 556.49 });
    const csvRow = fill({ precio: 556.4886 });
    expect(previewTxKey(csvRow)).toBe(previewTxKey(dbRow));
    expect(csvRowsNotInDb([csvRow], [dbRow])).toHaveLength(0);
  });

  it('dos fills del mismo día con precios distintos NO se colapsan', () => {
    const survivors = csvRowsNotInDb([fill({ precio: 411 }), fill({ precio: 412 })], [fill({ precio: 411 })]);
    expect(survivors).toHaveLength(1);
    expect(survivors[0].precio).toBe(412);
  });

  it('FEE/TAX casan por importe + concepto (producto difiere entre BD y CSV)', () => {
    const dbFee = { type: 'FEE', fecha: '02-01-2024', producto: 'CASH_EUR', total_amount: -2.5, notes: 'Comisión de conectividad NASDAQ' };
    const csvFee = { type: 'FEE', fecha: '02-01-2024', producto: 'Comisión de conectividad', total: -2.5, descripcion: 'Comisión de conectividad NASDAQ' };
    expect(csvRowsNotInDb([csvFee], [dbFee])).toHaveLength(0);
  });
});

describe('transCheckKey — el concepto no puede truncarse antes de lo que distingue', () => {
  it('las comisiones de conectividad reales (mismo día/importe) generan claves DISTINTAS', () => {
    // Regresión: con slice(0,30) las cinco comisiones "Comisión de conectividad
    // con el mercado 2026 (...)" colisionaban en UNA clave → 4 de 5 se
    // descartaban en el primer import y los re-syncs parcheaban notas en bucle.
    const base = { transaction_date: '2026-02-01T10:00:00', transaction_type: 'FEE', total_amount: -2.5, position_id: 'cash1' };
    const markets = [
      'Comisión de conectividad con el mercado 2026 (London Stock Exchange (LSE) - LSE)',
      'Comisión de conectividad con el mercado 2026 (Euronext Amsterdam - EAM)',
      'Comisión de conectividad con el mercado 2026 (Nasdaq - NDQ)',
      'Comisión de conectividad con el mercado 2026 (Euronext Paris - EPA)',
      'Comisión de conectividad con el mercado 2026 (Tradegate AG - TDG)',
    ];
    const keys = new Set(markets.map(notes => transCheckKey({ ...base, notes })));
    expect(keys.size).toBe(5);
  });
});
