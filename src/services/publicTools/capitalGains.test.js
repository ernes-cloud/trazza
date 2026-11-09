import { describe, it, expect } from 'vitest';
import { computeCapitalGains, addMonths } from './capitalGains';

let n = 0;
const buy = (date, qty, price, fee = 0, asset = 'ACME') => ({ id: `b${++n}`, asset, type: 'buy', date, qty, price, fee });
const sell = (date, qty, price, fee = 0, asset = 'ACME') => ({ id: `s${++n}`, asset, type: 'sell', date, qty, price, fee });

describe('addMonths', () => {
  it('suma y resta meses recortando al último día', () => {
    expect(addMonths('2025-03-01', 2)).toBe('2025-05-01');
    expect(addMonths('2025-04-30', -2)).toBe('2025-02-28');
    expect(addMonths('2025-12-31', 2)).toBe('2026-02-28');
  });
});

describe('computeCapitalGains — FIFO con comisiones', () => {
  it('vende primero lo primero que compró; la comisión de compra suma al coste y la de venta resta', () => {
    // Coste: 10×100+5 = 1.005 € + 5 acciones del 2º lote a (1.200+5)/10 = 602,50 € → 1.607,50 €
    // Importe: 15×130 − 10 = 1.940 € → ganancia 332,50 €
    const r = computeCapitalGains([
      buy('2023-01-10', 10, 100, 5),
      buy('2023-06-01', 10, 120, 5),
      sell('2024-03-01', 15, 130, 10),
    ]);
    const s = r.sales[0];
    expect(s.cost).toBeCloseTo(1607.5, 2);
    expect(s.proceeds).toBeCloseTo(1940, 2);
    expect(s.gain).toBeCloseTo(332.5, 2);
    expect(s.lots.map((l) => [l.date, l.qty])).toEqual([['2023-01-10', 10], ['2023-06-01', 5]]);
    expect(r.years[0]).toMatchObject({ year: 2024, net: 332.5 });
    expect(r.years[0].tax).toBeCloseTo(332.5 * 0.19, 1);
  });

  it('el impuesto va por tramos y suma los otros rendimientos del ahorro del año', () => {
    const r = computeCapitalGains([buy('2025-01-02', 1, 0), sell('2025-06-02', 1, 10000)], { otherSavingsIncome: 6000 });
    // Toda la ganancia cae en el tramo del 21 % porque los primeros 6.000 € ya los ocupan otros rendimientos.
    expect(r.years[0].tax).toBeCloseTo(2100, 2);
  });

  it('cada valor lleva su propia cola', () => {
    const r = computeCapitalGains([
      buy('2025-01-01', 10, 10, 0, 'AAA'),
      buy('2025-01-01', 10, 50, 0, 'BBB'),
      sell('2025-05-01', 10, 20, 0, 'BBB'),
    ]);
    expect(r.sales[0].gain).toBeCloseTo(-300, 2);
  });
});

describe('computeCapitalGains — regla de los dos meses', () => {
  it('recompra dentro del plazo: la pérdida se aplaza entera y entra al vender lo recomprado', () => {
    const r = computeCapitalGains([
      buy('2025-01-01', 10, 100),
      sell('2025-03-01', 10, 80),     // pérdida −200
      buy('2025-04-15', 10, 85),      // dentro de los dos meses posteriores
      sell('2026-02-01', 10, 90),     // vende lo recomprado: +50, y se libera la pérdida
    ]);
    const [first, second] = r.sales;
    expect(first.gain).toBeCloseTo(-200, 2);
    expect(first.deferred).toBeCloseTo(200, 2);
    expect(first.computable).toBeCloseTo(0, 2);
    expect(second.gain).toBeCloseTo(50, 2);
    expect(second.released).toBeCloseTo(200, 2);
    expect(second.computable).toBeCloseTo(-150, 2);
    expect(r.years.find((y) => y.year === 2025).net).toBeCloseTo(0, 2);
    expect(r.years.find((y) => y.year === 2026).net).toBeCloseTo(-150, 2);
    expect(r.stillDeferred).toBeCloseTo(0, 2);
  });

  it('venta no definitiva de lo recomprado (vuelve a comprar en los dos meses): la pérdida sigue aplazada', () => {
    // Caso del Reviewer (AEAT: la transmisión es definitiva si en los dos meses
    // anteriores o posteriores no se adquieren de nuevo valores homogéneos).
    const r = computeCapitalGains([
      buy('2025-01-10', 100, 50),
      sell('2025-03-15', 100, 40),    // −1.000, aplazada por la recompra del 2-abr
      buy('2025-04-02', 100, 41),
      sell('2025-12-10', 100, 45),    // +400, pero no es definitiva: compra el 15-ene-2026
      buy('2026-01-15', 100, 44),
    ]);
    const [first, second] = r.sales;
    expect(first.deferred).toBeCloseTo(1000, 2);
    expect(second.gain).toBeCloseTo(400, 2);
    expect(second.released).toBeCloseTo(0, 2);
    expect(second.computable).toBeCloseTo(400, 2);
    expect(r.years.find((y) => y.year === 2025).net).toBeCloseTo(400, 2);
    expect(r.years.find((y) => y.year === 2025).released).toBeCloseTo(0, 2);
    expect(r.stillDeferred).toBeCloseTo(1000, 2);
  });

  it('la pérdida que pasó al lote nuevo se libera cuando ese lote se vende de forma definitiva', () => {
    const r = computeCapitalGains([
      buy('2025-01-10', 100, 50),
      sell('2025-03-15', 100, 40),
      buy('2025-04-02', 100, 41),
      sell('2025-12-10', 100, 45),
      buy('2026-01-15', 100, 44),
      sell('2026-09-01', 100, 46),    // +200 y sin compras en los dos meses de alrededor
    ]);
    const last = r.sales[r.sales.length - 1];
    expect(last.gain).toBeCloseTo(200, 2);
    expect(last.released).toBeCloseTo(1000, 2);
    expect(r.years.find((y) => y.year === 2026).net).toBeCloseTo(-800, 2);
    expect(r.stillDeferred).toBeCloseTo(0, 2);
  });

  it('caso G: venta no definitiva CON pérdida: aplaza su pérdida propia y el arrastre en las mismas acciones de reposición', () => {
    const r = computeCapitalGains([
      buy('2025-01-10', 100, 50),
      sell('2025-03-15', 100, 40),    // −1.000, aplazada (recompra 2-abr)
      buy('2025-04-02', 100, 41),
      sell('2025-12-10', 100, 39),    // −200 propia; no definitiva (compra 15-ene)
      buy('2026-01-15', 100, 38),
      sell('2026-06-01', 100, 39),    // +100, definitiva: se integran 1.200
    ]);
    const [, s2, s3] = r.sales;
    expect(s2.gain).toBeCloseTo(-200, 2);
    expect(s2.deferred).toBeCloseTo(200, 2);
    expect(s2.released).toBeCloseTo(0, 2);
    expect(s3.released).toBeCloseTo(1200, 2);
    expect(r.years.find((y) => y.year === 2025).net).toBeCloseTo(0, 2);
    expect(r.years.find((y) => y.year === 2026).net).toBeCloseTo(-1100, 2);
    expect(r.stillDeferred).toBeCloseTo(0, 2);
  });

  it('caso E: un lote comprado en la ventana que la venta consume en parte sigue contando como reposición', () => {
    const r = computeCapitalGains([
      buy('2025-01-10', 100, 50),
      sell('2025-03-15', 100, 40),    // −1.000, aplazada
      buy('2025-04-02', 100, 41),
      buy('2025-11-01', 100, 44),
      sell('2025-12-10', 150, 45),    // FIFO: 100 del 2-abr + 50 del 1-nov → +450; quedan 50 del 1-nov
    ]);
    const s2 = r.sales[1];
    expect(s2.gain).toBeCloseTo(450, 2);
    expect(s2.released).toBeCloseTo(500, 2);
    expect(s2.computable).toBeCloseTo(-50, 2);
    expect(r.years.find((y) => y.year === 2025).net).toBeCloseTo(-50, 2);
    expect(r.stillDeferred).toBeCloseTo(500, 2);
  });

  it('caso H: las acciones de reposición ya vendidas liberan su reserva y el resto del lote puede reponer', () => {
    const r = computeCapitalGains([
      buy('2025-01-10', 5, 50),
      sell('2025-02-01', 5, 40),      // −50, aplazada en 5 acciones del lote del 1-mar
      buy('2025-03-01', 10, 41),
      sell('2025-04-01', 5, 39),      // −10 propia; repone con las otras 5 del 1-mar: aplaza 10 + 50
      sell('2026-03-01', 5, 45),      // +20, definitiva: se integran 60
    ]);
    expect(r.years.find((y) => y.year === 2025).net).toBeCloseTo(0, 2);
    expect(r.years.find((y) => y.year === 2026).net).toBeCloseTo(-40, 2);
    expect(r.sales[2].released).toBeCloseTo(60, 2);
    expect(r.stillDeferred).toBeCloseTo(0, 2);
  });

  it('si recompra menos de lo vendido, solo se aplaza la parte proporcional', () => {
    const r = computeCapitalGains([
      buy('2025-01-01', 1000, 10),
      sell('2025-06-01', 1000, 8),    // −2.000
      buy('2025-06-20', 300, 8),      // 300 de 1.000 → se aplaza el 30 %
    ]);
    expect(r.sales[0].deferred).toBeCloseTo(600, 2);
    expect(r.sales[0].computable).toBeCloseTo(-1400, 2);
    expect(r.stillDeferred).toBeCloseTo(600, 2);
  });

  it('una compra anterior que esta misma venta consume no bloquea la pérdida', () => {
    const r = computeCapitalGains([buy('2025-05-01', 10, 100), sell('2025-05-20', 10, 90)]);
    expect(r.sales[0].deferred).toBe(0);
    expect(r.sales[0].computable).toBeCloseTo(-100, 2);
  });

  it('una compra anterior que sigue en cartera sí la bloquea', () => {
    const r = computeCapitalGains([
      buy('2025-01-01', 10, 100),
      buy('2025-04-01', 10, 90),      // dentro de los dos meses anteriores y sigue en cartera
      sell('2025-05-01', 10, 80),     // FIFO vende el lote de enero: −200
    ]);
    expect(r.sales[0].gain).toBeCloseTo(-200, 2);
    expect(r.sales[0].deferred).toBeCloseTo(200, 2);
  });

  it('una compra fuera del plazo no bloquea, y otro valor tampoco', () => {
    const r = computeCapitalGains([
      buy('2025-01-01', 10, 100),
      sell('2025-03-01', 10, 80),
      buy('2025-05-02', 10, 80),             // un día después del plazo
      buy('2025-03-10', 10, 5, 0, 'OTRO'),   // otro valor
    ]);
    expect(r.sales[0].deferred).toBe(0);
  });

  it('las ganancias no se tocan aunque haya recompra', () => {
    const r = computeCapitalGains([buy('2025-01-01', 10, 100), sell('2025-03-01', 10, 120), buy('2025-03-05', 10, 118)]);
    expect(r.sales[0].deferred).toBe(0);
    expect(r.sales[0].computable).toBeCloseTo(200, 2);
  });
});

describe('computeCapitalGains — datos raros', () => {
  it('vender más de lo comprado se marca', () => {
    const r = computeCapitalGains([buy('2025-01-01', 5, 10), sell('2025-02-01', 8, 12)]);
    expect(r.oversold).toEqual([{ id: r.sales[0].id, missing: 3 }]);
  });

  it('las filas incompletas se apartan con su motivo', () => {
    const r = computeCapitalGains([
      { id: 'x1', asset: 'A', type: 'buy', date: '', qty: 1, price: 1 },
      { id: 'x2', asset: 'A', type: 'buy', date: '2025-01-01', qty: 0, price: 1 },
      { id: 'x3', asset: 'A', type: 'sell', date: '2025-01-01', qty: 1, price: -1 },
    ]);
    expect(r.invalid.map((i) => i.reason)).toEqual(['date', 'qty', 'price']);
    expect(r.sales).toEqual([]);
  });

  it('una pérdida neta no paga impuesto', () => {
    const r = computeCapitalGains([buy('2025-01-01', 10, 100), sell('2025-09-01', 10, 50)]);
    expect(r.years[0].net).toBeCloseTo(-500, 2);
    expect(r.years[0].tax).toBe(0);
  });
});
