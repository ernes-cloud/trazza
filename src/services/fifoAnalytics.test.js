import { describe, it, expect, beforeEach } from 'vitest';
import { FIFOCalculator } from './fifoAnalytics';

describe('FIFOCalculator', () => {
  let fifo;

  beforeEach(() => {
    fifo = new FIFOCalculator();
  });

  it('debería calcular correctamente el Cost Basis FIFO de MSFT (estándar de oro)', () => {
    // Escenario de prueba:
    // MSFT compradas: 10 @ $100, 5 @ $150
    // MSFT vendidas: 12 @ $200
    // Cost Basis para 12: ((10 * 100) + (2 * 150)) / 12 = 1300 / 12 = $108.33
    // Beneficio (Profit): (12 * 200) - 1300 = 2400 - 1300 = $1100

    fifo.processBuy({ cantidad: 10, precio: 100, moneda: 'USD', isin: 'US5949181045' });
    fifo.processBuy({ cantidad: 5, precio: 150, moneda: 'USD', isin: 'US5949181045' });

    const result = fifo.processSell({ cantidad: 12, precio: 200, moneda: 'USD', isin: 'US5949181045' });

    // Verificaciones
    expect(result.avgBuyPrice).toBeCloseTo(108.3333, 4); // 1300 / 12
    expect(result.profit).toBe(1100);                    // 2400 - 1300
    expect(result.isMissingBuyData).toBe(false);         // No hay huérfanas
    expect(result.sharesMissingHistory).toBe(0);         // Se consumieron las 12 con historial

    // remainingQty is a Decimal instance — convert to number before asserting
    const queue = fifo.queues['US5949181045_USD'];
    expect(queue[0].remainingQty.toNumber()).toBe(0);    // First lot fully consumed
    expect(queue[1].remainingQty.toNumber()).toBe(3);    // 5 - 2 = 3 remaining
  });

  it('debería emitir isMissingBuyData: true y sharesMissingHistory si no hay historial suficiente (Huérfanas)', () => {
    const result = fifo.processSell({ cantidad: 50, precio: 50, moneda: 'EUR', isin: 'ORPHAN000000' });

    expect(result.avgBuyPrice).toBe(0);                  // Asumimos coste base cero
    expect(result.profit).toBe(2500);                    // 50 * 50 = $2500 de pura ganancia
    expect(result.isMissingBuyData).toBe(true);          // ¡Flag activo!
    expect(result.sharesMissingHistory).toBe(50);
  });

  it('profitPercent es null (no un +100% inventado) cuando no hay lotes de compra', () => {
    const result = fifo.processSell({ cantidad: 10, precio: 20, moneda: 'EUR', isin: 'ORPHAN000001' });
    expect(result.isMissingBuyData).toBe(true);
    expect(result.profitPercent).toBeNull();
  });
});

// Lotes consumidos por cada venta (informe fiscal al tipo de la fecha de cada
// compra). Contrato aditivo: los campos de siempre no cambian.
describe('FIFOCalculator.processSell — lots', () => {
  it('devuelve los lotes FIFO consumidos (varios lotes y venta parcial del último)', () => {
    const fifo = new FIFOCalculator();
    fifo.processBuy({ cantidad: 10, precio: 100, moneda: 'USD', isin: 'X', fecha: '02-01-2024' });
    fifo.processBuy({ cantidad: 5, precio: 120, moneda: 'USD', isin: 'X', fecha: '01-02-2024', fxRate: 0.92 });
    fifo.processBuy({ cantidad: 5, precio: 130, moneda: 'USD', isin: 'X', fecha: '01-03-2024' });

    const r1 = fifo.processSell({ cantidad: 12, precio: 150, moneda: 'USD', isin: 'X' });
    expect(r1.lots).toEqual([
      { date: '02-01-2024', qty: 10, unitCost: 100, fxRate: null },
      { date: '01-02-2024', qty: 2, unitCost: 120, fxRate: 0.92 },
    ]);
    // Resultados de siempre, intactos: 12×150 − (10×100 + 2×120)
    expect(r1.profit).toBe(1800 - 1240);
    expect(r1.avgBuyPrice).toBeCloseTo(1240 / 12, 10);
    expect(r1.isMissingBuyData).toBe(false);
    expect(r1.sharesMissingHistory).toBe(0);

    // La segunda venta arranca donde se quedó el lote parcial
    const r2 = fifo.processSell({ cantidad: 4, precio: 150, moneda: 'USD', isin: 'X' });
    expect(r2.lots).toEqual([
      { date: '01-02-2024', qty: 3, unitCost: 120, fxRate: 0.92 },
      { date: '01-03-2024', qty: 1, unitCost: 130, fxRate: null },
    ]);
    expect(r2.profit).toBe(600 - 490);
  });

  it('sin compras previas → lots vacío', () => {
    const fifo = new FIFOCalculator();
    const r = fifo.processSell({ cantidad: 3, precio: 10, moneda: 'EUR', isin: 'NOPE' });
    expect(r.lots).toEqual([]);
    expect(r.isMissingBuyData).toBe(true);
  });
});
