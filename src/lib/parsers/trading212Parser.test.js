import { describe, it, expect } from 'vitest';
import { parseTrading212CSV, isTrading212Csv, parseT212Time } from './trading212Parser.js';
import { calculateNetBuys } from '../../services/import/netHoldings.js';
import { detectBrokerCsv } from './brokerDetect.js';

// Fixtures SINTÉTICOS con la forma exacta de los exports de Trading 212 (sin
// datos de nadie). Dos variantes de cabecera que conviven en la práctica:
//  - NUEVA: divisa en columnas propias, "Time (UTC)", comisiones con su divisa.
//  - ANTIGUA: divisa de la cuenta en el nombre de la columna, "Time".

const NEW_HEADER = 'Action,Time (UTC),ISIN,Ticker,Name,Notes,ID,No. of shares,Price / share,Currency (Price / share),Exchange rate,Result,Currency (Result),Total,Currency (Total),Withholding tax,Currency (Withholding tax),Currency conversion fee,Currency (Currency conversion fee),French transaction tax,Currency (French transaction tax)';

const NEW_EXPORT = [
  NEW_HEADER,
  'Deposit,2025-01-02 09:00:00,,,,"Transaction ID: 111",D1,,,,,,,1000.00,EUR,,,,,,',
  // 10 AAPL a 150 USD con el euro a 1.08 USD → 1388.89 EUR + 2.08 EUR de conversión = 1390.97
  'Market buy,2025-01-03 15:30:12.345,US0378331005,AAPL,"Apple Inc.",,EOF1,10,150.00,USD,1.08,,EUR,1390.97,EUR,,,2.08,EUR,,',
  // Una francesa en EUR con impuesto de transacciones francés en EUR
  'Limit buy,2025-02-10 10:00:00,FR0000121014,MC,"LVMH Moët Hennessy, Louis Vuitton",,EOF2,0.5,600.00,EUR,1,,EUR,301.80,EUR,,,,,1.80,EUR',
  // Dividendo: Total NETO (0.24 × 10 = 2.40 USD brutos − 15% = 2.04 USD → 1.89 EUR)
  'Dividend (Dividends paid by us corporations),2025-02-15 00:00:00,US0378331005,AAPL,"Apple Inc.",,,10,0.24,USD,1.08,,EUR,1.89,EUR,0.36,USD,,,,',
  'Interest on cash,2025-02-28 00:00:00,,,,,,,,,,,,0.55,EUR,,,,,,',
  // Venta de 4 AAPL a 160 USD → 592.59 EUR − 0.89 de conversión = 591.70
  'Market sell,2025-03-05 16:00:00,US0378331005,AAPL,"Apple Inc.",,EOF3,4,160.00,USD,1.08,40.20,EUR,591.70,EUR,,,0.89,EUR,,',
  'Withdrawal,2025-03-10 09:00:00,,,,,,,,,,,,-100.00,EUR,,,,,,',
  'Currency conversion,2025-03-11 09:00:00,,,,,,,,,,,,10.00,EUR,,,,,,',
].join('\n');

const OLD_EXPORT = [
  'Action,Time,ISIN,Ticker,Name,No. of shares,Price / share,Currency (Price / share),Exchange rate,Result (EUR),Total (EUR),Withholding tax,Currency (Withholding tax),Charge amount (EUR),Notes,ID,Currency conversion fee (EUR)',
  'Deposit,2023-05-02 10:00:00,,,,,,,,,500.00,,,,,,',
  'Market buy,2023-05-03 15:31:00,US5949181045,MSFT,"Microsoft",1.5,300.00,USD,1.1,,409.70,,,,,EOF9,0.61',
].join('\n');

describe('detección del formato', () => {
  it('reconoce las dos variantes de cabecera y nada más', () => {
    expect(isTrading212Csv(NEW_EXPORT)).toBe(true);
    expect(isTrading212Csv(OLD_EXPORT)).toBe(true);
    expect(isTrading212Csv('Fecha,Hora,Fecha valor,Producto,ISIN,Descripción')).toBe(false);
  });

  it('detectBrokerCsv lo manda al importador nativo', () => {
    expect(detectBrokerCsv(NEW_EXPORT)?.broker).toBe('trading212');
  });

  it('lee la hora en UTC con milisegundos y el formato re-guardado con Excel', () => {
    expect(parseT212Time('2025-01-03 15:30:12.345')).toEqual({ fecha: '03-01-2025', hora: '15:30:12' });
    expect(parseT212Time('01/08/2025 07:00')).toEqual({ fecha: '01-08-2025', hora: '07:00:00' });
    expect(parseT212Time('basura')).toBeNull();
  });
});

describe('parseTrading212CSV — export nuevo', () => {
  const { transactions, warnings } = parseTrading212CSV(NEW_EXPORT);
  const byId = (id) => transactions.find((t) => t.idOrden === id);

  it('compra en USD: precio y total en USD, comisión en EUR aparte, bruto en EUR', () => {
    expect(byId('EOF1')).toMatchObject({
      type: 'BUY', isin: 'US0378331005', producto: 'AAPL', fecha: '03-01-2025',
      cantidad: 10, precio: 150, moneda: 'USD', total: 1500,
    });
    expect(byId('EOF1').comisiones).toBeCloseTo(2.08, 2);
    // 1390.97 − 2.08 = 1388.89 EUR = 1500 / 1.08: la comisión NO está en el coste
    expect(byId('EOF1').totalEUR).toBeCloseTo(1388.89, 2);
    expect(byId('EOF1').totalEUR).toBeCloseTo(1500 / 1.08, 1);
  });

  it('nombre con coma entre comillas y comisión de una columna nueva (impuesto francés)', () => {
    expect(byId('EOF2')).toMatchObject({ type: 'BUY', nombre: 'LVMH Moët Hennessy, Louis Vuitton', moneda: 'EUR', precio: 600 });
    expect(byId('EOF2').comisiones).toBeCloseTo(1.8, 2);
    expect(byId('EOF2').totalEUR).toBeCloseTo(300, 2);
  });

  it('venta: el bruto en EUR SUMA la comisión que el Total ya había descontado', () => {
    expect(byId('EOF3')).toMatchObject({ type: 'SELL', cantidad: 4, precio: 160, moneda: 'USD', total: 640 });
    expect(byId('EOF3').totalEUR).toBeCloseTo(592.59, 2);
  });

  it('dividendo NETO en la divisa de la cuenta, con la retención en la descripción', () => {
    const div = transactions.find((t) => t.type === 'DIVIDEND' && t.isin);
    expect(div).toMatchObject({ isin: 'US0378331005', total: 1.89, moneda: 'EUR', cantidad: 0 });
    expect(div.descripcion).toMatch(/retención 0\.36 USD/);
  });

  it('interés de la liquidez = ingreso sin valor detrás', () => {
    expect(transactions.find((t) => t.producto === 'Interest on cash')).toMatchObject({ type: 'DIVIDEND', isin: '', total: 0.55 });
  });

  it('ingresos y retiradas con su signo; la conversión de divisa interna no es un movimiento', () => {
    const transfers = transactions.filter((t) => t.type === 'TRANSFER').map((t) => t.total);
    expect(transfers).toEqual([1000, -100]);
    expect(transactions.some((t) => /conversion/i.test(t.descripcion || '') && t.type !== 'BUY' && t.type !== 'SELL')).toBe(false);
  });

  it('la caja sale del propio fichero y la de dólares queda a cero (nunca existió)', () => {
    const snaps = transactions.filter((t) => t.isEndingCash);
    // 1000 − 1390.97 − 301.80 + 1.89 + 0.55 + 591.70 − 100 = −198.63 → el
    // fichero no cubre toda la historia y se avisa (ver test siguiente)
    expect(snaps.find((s) => s.moneda === 'EUR').total).toBeCloseTo(-198.63, 2);
    expect(snaps.find((s) => s.moneda === 'USD').total).toBe(0);
  });

  it('avisa cuando el saldo calculado sale negativo: falta el principio de la historia', () => {
    expect(warnings.find((w) => w.code === 't212_cash_incomplete')).toMatchObject({ currency: 'EUR' });
  });
});

describe('parseTrading212CSV — export antiguo (divisa en el nombre de la columna)', () => {
  const { transactions, warnings } = parseTrading212CSV(OLD_EXPORT);

  it('lee "Total (EUR)" y la comisión "Currency conversion fee (EUR)"', () => {
    const buy = transactions.find((t) => t.type === 'BUY');
    expect(buy).toMatchObject({ cantidad: 1.5, precio: 300, moneda: 'USD', total: 450 });
    expect(buy.comisiones).toBeCloseTo(0.61, 2);
    expect(buy.totalEUR).toBeCloseTo(409.09, 2); // 450 / 1.1
  });

  it('con la historia completa, el saldo cuadra y no hay aviso', () => {
    expect(transactions.find((t) => t.isEndingCash && t.moneda === 'EUR').total).toBeCloseTo(90.3, 2);
    expect(warnings).toEqual([]);
  });
});

describe('integración con el cálculo de posiciones y caja', () => {
  it('las posiciones netas y la liquidez salen como en Trading 212', () => {
    const { transactions } = parseTrading212CSV(OLD_EXPORT);
    const net = calculateNetBuys(transactions, 'trading212');
    const msft = net.find((n) => n.isin === 'US5949181045');
    expect(msft.qty).toBeCloseTo(1.5, 6);
    expect(msft.precio).toBeCloseTo(300, 6);
    const cashEur = net.find((n) => n.isin === 'CASH_EUR');
    expect(cashEur.qty).toBeCloseTo(90.3, 2);
    // Sin la foto de caja, la compra en USD habría dejado CASH_USD en −450
    expect(net.find((n) => n.isin === 'CASH_USD')?.qty ?? 0).toBeCloseTo(0, 6);
  });
});

describe('lo que no se importa se dice', () => {
  it('splits y acciones desconocidas generan avisos con los valores afectados', () => {
    const csv = [
      NEW_HEADER,
      'Deposit,2025-01-02 09:00:00,,,,,D1,,,,,,,100.00,EUR,,,,,,',
      'Stock split open,2025-06-10 00:00:00,US67066G1040,NVDA,"NVIDIA",,,10,12.00,USD,1.08,,EUR,111.11,EUR,,,,,,',
      'Stock split close,2025-06-10 00:00:00,US67066G1040,NVDA,"NVIDIA",,,1,120.00,USD,1.08,,EUR,111.11,EUR,,,,,,',
      'Spin off,2025-07-01 00:00:00,US0000000001,SPIN,"Spin Co",,,3,10.00,USD,1.08,,EUR,27.78,EUR,,,,,,',
    ].join('\n');
    const { warnings } = parseTrading212CSV(csv);
    expect(warnings.find((w) => w.code === 't212_stock_splits').symbols).toEqual(['NVDA']);
    expect(warnings.find((w) => w.code === 't212_unsupported_actions').types).toEqual(['Spin off']);
  });

  it('un CSV de otro broker devuelve vacío sin lanzar', () => {
    expect(parseTrading212CSV('Fecha,Hora,Producto\n01-01-2025,10:00,X')).toEqual({ transactions: [], warnings: [] });
  });

  it('peniques (GBX) se pasan a libras', () => {
    const csv = [
      'Action,Time,ISIN,Ticker,Name,No. of shares,Price / share,Currency (Price / share),Exchange rate,Total,Currency (Total),ID',
      'Market buy,2025-01-03 10:00:00,GB00B03MLX29,RDSA,"Shell",10,2500,GBX,100,250.00,GBP,X1',
    ].join('\n');
    const buy = parseTrading212CSV(csv).transactions.find((t) => t.type === 'BUY');
    expect(buy).toMatchObject({ precio: 25, moneda: 'GBP', total: 250 });
    expect(buy.totalEUR).toBeUndefined(); // cuenta en GBP: no hay importe en euros
  });
});
