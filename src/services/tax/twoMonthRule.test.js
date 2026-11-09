import { describe, it, expect } from 'vitest';
import { applyTwoMonthRule, addMonths } from './twoMonthRule';

// Núcleo de la regla de los dos meses (art. 33.5.f LIRPF). Las operaciones
// llegan YA en la moneda del informe y con la comisión dentro del importe.
let seq = 0;
const buy = (date, qty, unitCostEur, key = 'K') => ({ id: `b${seq++}`, key, type: 'buy', date, qty, unitCostEur });
const sell = (date, qty, netProceedsEur, key = 'K') => ({ id: `s${seq++}`, key, type: 'sell', date, qty, netProceedsEur });

describe('applyTwoMonthRule', () => {
  it('aplaza la pérdida con recompra posterior y la libera en la venta definitiva', () => {
    const r = applyTwoMonthRule([
      buy('2025-01-01', 10, 100),
      sell('2025-03-01', 10, 800),
      buy('2025-04-15', 10, 85),
      sell('2026-02-01', 10, 900),
    ]);
    const [a, b] = r.sales;
    expect(a.gain).toBeCloseTo(-200, 9);
    expect(a.deferred).toBeCloseTo(200, 9);
    expect(a.computable).toBeCloseTo(0, 9);
    expect(a.blockedBy).toEqual([expect.objectContaining({ date: '2025-04-15', qty: 10 })]);
    expect(b.released).toBeCloseTo(200, 9);
    expect(b.computable).toBeCloseTo(50 - 200, 9);
    expect(r.stillDeferred).toBeCloseTo(0, 9);
    expect(r.pendingByLot).toEqual([]);
  });

  it('lo aplazado pendiente sale por lote, con la compra que lo lleva', () => {
    const r = applyTwoMonthRule([
      buy('2025-01-01', 1000, 10),
      sell('2025-06-01', 1000, 8000),
      buy('2025-06-20', 300, 8),
    ]);
    expect(r.sales[0].deferred).toBeCloseTo(600, 9);
    expect(r.stillDeferred).toBeCloseTo(600, 9);
    expect(r.pendingByLot).toHaveLength(1);
    expect(r.pendingByLot[0]).toMatchObject({ key: 'K', date: '2025-06-20', remainingQty: 300, deferredShares: 300 });
    expect(r.pendingByLot[0].deferredAmount).toBeCloseTo(600, 9);
  });

  it('respeta el orden de entrada dentro del mismo día', () => {
    const r = applyTwoMonthRule([
      buy('2025-05-01', 10, 100),
      sell('2025-05-01', 10, 900),
      buy('2025-05-01', 10, 90),
    ]);
    // La venta consume el primer lote; la segunda compra (mismo día, después) repone.
    expect(r.sales[0].lots).toEqual([expect.objectContaining({ qty: 10, unitCost: 100 })]);
    expect(r.sales[0].deferred).toBeCloseTo(100, 9);
  });

  it('venta por encima de lo comprado: devuelve las acciones sin historial', () => {
    const r = applyTwoMonthRule([buy('2025-01-01', 5, 10), sell('2025-02-01', 8, 80)]);
    expect(r.sales[0].missingShares).toBe(3);
  });

  it('importe desconocido (sin tipo de cambio): gain y computable null, no bloquea ni inventa', () => {
    const r = applyTwoMonthRule([
      buy('2025-01-01', 10, null),
      sell('2025-03-01', 10, 500),
      buy('2025-03-10', 10, 50),
      sell('2025-12-01', 10, null),
    ]);
    expect(r.sales[0].amountUnknown).toBe(true);
    expect(r.sales[0].gain).toBeNull();
    expect(r.sales[0].computable).toBeNull();
    expect(r.sales[0].deferred).toBe(0);
    expect(r.sales[1].amountUnknown).toBe(true);
    expect(r.sales[1].gain).toBeNull();
  });

  describe('knownPartOnly (historial parcial: solo computa la parte con compra)', () => {
    it('9 compradas a 100 y 10 vendidas a 50: −450 de las 9 conocidas; 1 sin coste fuera', () => {
      const r = applyTwoMonthRule([buy('2025-01-01', 9, 100), sell('2025-03-01', 10, 500)], { knownPartOnly: true });
      const [s] = r.sales;
      expect(s.missingShares).toBe(1);
      expect(s.knownQty).toBe(9);
      expect(s.gain).toBeCloseTo(-450, 9);
      expect(s.knownProceeds).toBeCloseTo(450, 9);
      expect(s.excludedProceeds).toBeCloseTo(50, 9);
      expect(s.computable).toBeCloseTo(-450, 9);
    });

    it('la pérdida aplazada usa solo las unidades conocidas (5 de reposición sobre 9 conocidas)', () => {
      const r = applyTwoMonthRule([
        buy('2025-01-01', 9, 100), sell('2025-03-01', 10, 500), buy('2025-04-01', 5, 50),
      ], { knownPartOnly: true });
      const [s] = r.sales;
      expect(s.deferred).toBeCloseTo(450 * (5 / 9), 9);
      expect(s.computable).toBeCloseTo(-450 * (4 / 9), 9);
      expect(s.blockedBy).toEqual([expect.objectContaining({ qty: 5 })]);
    });

    it('una recompra MAYOR que las conocidas bloquea solo las conocidas: nunca se aplaza más que la pérdida', () => {
      const r = applyTwoMonthRule([
        buy('2025-01-01', 9, 100), sell('2025-03-01', 10, 500), buy('2025-04-01', 10, 50),
      ], { knownPartOnly: true });
      const [s] = r.sales;
      expect(s.deferred).toBeCloseTo(450, 9);
      expect(s.computable).toBeCloseTo(0, 9);
      expect(s.blockedBy).toEqual([expect.objectContaining({ qty: 9 })]);
    });

    it('si TODAS carecen de compra: gain 0, nada aplazado y todo el importe excluido', () => {
      const r = applyTwoMonthRule([sell('2025-03-01', 10, 500), buy('2025-04-01', 5, 50)], { knownPartOnly: true });
      const [s] = r.sales;
      expect(s.knownQty).toBe(0);
      expect(s.gain).toBe(0);
      expect(s.deferred).toBe(0);
      expect(s.excludedProceeds).toBe(500);
    });

    it('sin la opción no cambia nada: las que faltan cuentan a coste 0 y no hay campos nuevos', () => {
      const r = applyTwoMonthRule([buy('2025-01-01', 9, 100), sell('2025-03-01', 10, 500)]);
      const [s] = r.sales;
      expect(s.gain).toBeCloseTo(-400, 9);
      expect(s).not.toHaveProperty('knownQty');
      expect(s).not.toHaveProperty('excludedProceeds');
    });
  });

  it('addMonths recorta al último día del mes', () => {
    expect(addMonths('2025-04-30', -2)).toBe('2025-02-28');
    expect(addMonths('2024-12-31', 2)).toBe('2025-02-28');
    expect(addMonths('2024-02-29', 12)).toBe('2025-02-28');
  });
});
