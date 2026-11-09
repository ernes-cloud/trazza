import { describe, it, expect } from 'vitest';
import { computeProcessedImportData } from './processedImportData';

// Characterization tests del useMemo extraído de CarteraPage: pinnan el
// comportamiento observable (dedupe multiset, FIFO de ventas, cash con
// snapshot, totales csv-only) para que el servicio sea refactorizable.

const csvBuy = (over = {}) => ({
  type: 'BUY', fecha: '10-01-2025', hora: '10:00', producto: 'AAPL', isin: 'US0378331005',
  nombre: 'Apple', cantidad: 10, precio: 100, total: -1000, moneda: 'USD', comisiones: 0,
  ...over,
});

describe('computeProcessedImportData', () => {
  it('sin transacciones devuelve la forma vacía', () => {
    const r = computeProcessedImportData({ importedTransactions: [], dbTransactions: [] });
    expect(r.netBuys).toEqual([]);
    expect(r.totals.salesTotal).toBe(0);
    expect(r.charts.salesChartData).toEqual([]);
  });

  it('BUY + SELL: P&L FIFO en salesWithPL y salesTotal convertido', () => {
    const r = computeProcessedImportData({
      importedTransactions: [
        csvBuy(),
        { ...csvBuy(), type: 'SELL', fecha: '15-02-2025', cantidad: 5, precio: 120, total: 600 },
      ],
      dbTransactions: [],
      exchangeRates: { USD: 0.9 },
    });
    expect(r.salesWithPL).toHaveLength(1);
    // FIFO: (120 − 100) × 5 = 100 USD de beneficio
    expect(r.salesWithPL[0].profit).toBeCloseTo(100, 8);
    expect(r.totals.salesTotal).toBeCloseTo(90, 8); // × 0.9
    // netBuys conserva las 5 restantes a coste medio 100
    const apple = r.netBuys.find(n => n.isin === 'US0378331005');
    expect(apple.qty).toBeCloseTo(5, 8);
    expect(apple.precio).toBeCloseTo(100, 8);
  });

  it('dedupe MULTISET: una fila DB consume UNA fila CSV idéntica; el fill duplicado sobrevive', () => {
    const dbRow = { ...csvBuy(), isFromDB: true, transaction_type: 'BUY' };
    const r = computeProcessedImportData({
      // dos fills idénticos en el CSV, solo uno guardado en DB
      importedTransactions: [csvBuy(), csvBuy()],
      dbTransactions: [dbRow],
    });
    const apple = r.netBuys.find(n => n.isin === 'US0378331005');
    // 10 (DB) + 10 (fill superviviente) = 20 — un Set habría dejado 10
    expect(apple.qty).toBeCloseTo(20, 8);
  });

  it('csvBuyTotal solo cuenta filas NO-DB', () => {
    const r = computeProcessedImportData({
      importedTransactions: [csvBuy()],
      dbTransactions: [{ ...csvBuy(), fecha: '11-01-2025', isFromDB: true }],
      exchangeRates: { USD: 0.9 },
    });
    expect(r.totals.csvBuyTotal).toBeCloseTo(1000 * 0.9, 8);
  });

  it('totales csv-only excluyen filas isFromDB (se suman aparte a los de DB)', () => {
    const r = computeProcessedImportData({
      importedTransactions: [
        csvBuy(),
        { ...csvBuy(), type: 'SELL', fecha: '15-02-2025', cantidad: 10, precio: 110, total: 1100 },
      ],
      dbTransactions: [
        { ...csvBuy(), type: 'DIVIDEND', fecha: '20-02-2025', cantidad: 0, total: 50, isFromDB: true },
      ],
      exchangeRates: { USD: 1 },
    });
    expect(r.totals.salesTotalCsvOnly).toBeCloseTo(100, 8);
    expect(r.totals.dividendsTotal).toBeCloseTo(50, 8);
    expect(r.totals.dividendsTotalCsvOnly).toBe(0);
  });

  it('comisiones: agrupadas SIEMPRE en EUR y las filas DB no cuentan (ya están en historyTotals)', () => {
    const r = computeProcessedImportData({
      importedTransactions: [csvBuy({ comisiones: 3 })],
      dbTransactions: [
        { ...csvBuy(), fecha: '12-01-2025', type: 'FEE', total: -2.5, isFromDB: true },
      ],
      exchangeRates: { EUR: 1, USD: 0.9 },
    });
    // Solo la comisión CSV (3 €); la FEE de DB se salta
    expect(r.totals.commissionsBreakdown).toEqual({ EUR: 3 });
    expect(r.totals.commissionsTotal).toBeCloseTo(3, 8);
    // Pero ambas aparecen como filas para el historial
    expect(r.commissions).toHaveLength(2);
  });

  it('cash sin snapshot: acumulación compra/venta/transfer por divisa y broker', () => {
    const r = computeProcessedImportData({
      importedTransactions: [
        { type: 'TRANSFER', fecha: '01-01-2025', total: 5000, moneda: 'EUR' },
        csvBuy({ moneda: 'EUR', precio: 100, cantidad: 10 }), // −1000
      ],
      dbTransactions: [],
      exchangeRates: { EUR: 1 },
    });
    expect(r.totals.cashBreakdown.EUR).toBeCloseTo(4000, 8);
    const cashRow = r.netBuys.find(n => n.ticker === 'CASH_EUR');
    expect(cashRow.qty).toBeCloseTo(4000, 8);
  });

  it('cash CON snapshot isEndingCash: ancla el balance y solo aplica movimientos posteriores', () => {
    const r = computeProcessedImportData({
      importedTransactions: [
        // movimiento ANTERIOR al snapshot — no debe alterar el balance anclado
        { type: 'TRANSFER', fecha: '01-01-2025', total: 99999, moneda: 'EUR' },
        { type: 'CASH', fecha: '15-01-2025', hora: '12:00', total: 1500, moneda: 'EUR', isEndingCash: true },
        // movimiento POSTERIOR — sí aplica
        { type: 'TRANSFER', fecha: '20-01-2025', total: 500, moneda: 'EUR' },
      ],
      dbTransactions: [],
      exchangeRates: { EUR: 1 },
    });
    expect(r.totals.cashBreakdown.EUR).toBeCloseTo(2000, 8);
  });

  it('netBuys valora a precio de mercado de importPrices por displayTicker', () => {
    const r = computeProcessedImportData({
      importedTransactions: [csvBuy()],
      dbTransactions: [],
      dynamicTickerMap: { US0378331005: 'AAPL' },
      importPrices: { AAPL: 150 },
    });
    const apple = r.netBuys.find(n => n.isin === 'US0378331005');
    expect(apple.total).toBeCloseTo(10 * 150, 8); // market value, no coste
  });

  it('los charts mensuales agregan por YYYY-MM', () => {
    const r = computeProcessedImportData({
      importedTransactions: [
        csvBuy(),
        { ...csvBuy(), type: 'SELL', fecha: '15-02-2025', cantidad: 5, precio: 120, total: 600 },
        { ...csvBuy(), type: 'DIVIDEND', fecha: '17-02-2025', cantidad: 0, total: 40 },
      ],
      dbTransactions: [],
      exchangeRates: { USD: 1 },
    });
    const feb = r.charts.salesChartData.find(d => d.name === '2025-02');
    expect(feb.value).toBeCloseTo(100, 8);
    const febDiv = r.charts.dividendsChartData.find(d => d.name === '2025-02');
    expect(febDiv.value).toBeCloseTo(40, 8);
  });

  it('las listas de salida vienen invertidas (más reciente primero)', () => {
    const r = computeProcessedImportData({
      importedTransactions: [
        csvBuy({ fecha: '10-01-2025' }),
        csvBuy({ fecha: '10-03-2025' }),
      ],
      dbTransactions: [],
    });
    expect(r.buys[0].fecha).toBe('10-03-2025');
    expect(r.buys[1].fecha).toBe('10-01-2025');
  });
});
