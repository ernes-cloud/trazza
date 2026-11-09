import { describe, it, expect } from 'vitest';
import { performanceService } from './performanceService.js';

/**
 * El sub-periodo del DÍA DE VENTA en la cadena TTWROR (2026-10-02).
 *
 * Antes, las acciones vendidas se valoraban al CIERRE del día de la venta,
 * como si se hubiesen vendido en el último instante: vender a 104 un valor
 * que cierra a 95 apuntaba un −5 % que nunca ocurrió (el dinero se cobró a
 * 104). Ahora el día es el eslabón GIPS con la salida al final del día:
 *   R = (valor al cierre de lo que sigue + lo cobrado − valor inicial) / valor inicial
 * con lo cobrado al precio de EJECUCIÓN (la comisión es coste, no mercado).
 * Mismo espíritu y mismas defensas que el sub-periodo del día de compra
 * (performanceService.buyDay.test.js).
 */

const day = (d) => `2026-02-${String(d).padStart(2, '0')}`;
const priceSeries = (closes) => Object.entries(closes).map(([d, close]) => ({ time: d, close }));
const asset = (currency = 'EUR') => ({ positions: { assets: { ticker: 'TEST', currency, company_name: 'Test Co' } } });

// Compra al CIERRE del día 24 (100) — el día de compra aporta 0 y no interfiere.
const buy = (qty = 1, over = {}) => ({
  transaction_date: `${day(24)}T17:00:00`, transaction_type: 'BUY', quantity: qty, price: 100,
  isin: 'TEST0000001', ...asset(), ...over,
});
const sell = (qty = 1, price = 104, over = {}) => ({
  transaction_date: `${day(26)}T11:00:00`, transaction_type: 'SELL', quantity: qty, price,
  isin: 'TEST0000001', ...asset(), ...over,
});
const resolve = (t) => (t && t.startsWith('TEST0') ? null : t);
const run = (txs, prices, opts = {}) => performanceService.calculateDailyTWR(
  txs, prices, opts.fx || {}, opts.rates || {}, 'EUR', {}, resolve, txs,
);
const closes = { TEST: priceSeries({ [day(24)]: 100, [day(25)]: 100, [day(26)]: 95, [day(27)]: 90 }) };
const at = (out, d) => out.find((p) => p.date === d);

describe('TTWROR — sub-periodo del día de venta', () => {
  it('vender todo a 104 con cierre a 95 es +4 %, no −5 %', () => {
    const out = run([buy(), sell()], closes);
    expect(at(out, day(26)).ttwror).toBeCloseTo(4, 6);
    // Y lo que el valor haga después ya no es asunto de la cartera
    expect(out[out.length - 1].ttwror).toBeCloseTo(4, 6);
  });

  it('venta parcial: lo que sigue en cartera se valora al cierre y lo vendido a lo cobrado', () => {
    // 2 acciones a 100; vende 1 a 104; cierre 95 → (95 + 104 − 200) / 200 = −0,5 %
    const out = run([buy(2), sell(1)], closes);
    expect(at(out, day(26)).ttwror).toBeCloseTo(-0.5, 6);
  });

  it('usa el precio de ejecución, no eur_total (la comisión no es mercado)', () => {
    const out = run([buy(), sell(1, 104, { eur_total: 101 })], closes);
    expect(at(out, day(26)).ttwror).toBeCloseTo(4, 6);
  });

  it('si la divisa de ejecución no es la de cotización, no crea el eslabón (comportamiento anterior)', () => {
    // Caso Xetra: el valor cotiza en USD pero la venta se liquidó en EUR.
    // Comparar esos precios mediría el tipo de cambio, no el mercado.
    const usd = { positions: { assets: { ticker: 'TEST', currency: 'USD', company_name: 'Test Co' } } };
    const out = run([buy(1, usd), sell(1, 104, { transaction_currency: 'EUR', ...usd })], closes, { rates: { USD: 1 } });
    expect(at(out, day(26)).ttwror).toBeCloseTo(-5, 6);
  });

  it('un precio de venta absurdo (dato sucio) descarta el eslabón en vez de inventar un salto', () => {
    // 5.000 en vez de 104 (y lejos de cualquier ratio de split): +4.900 % en
    // un día no es mercado.
    const out = run([buy(), sell(1, 5000)], closes);
    expect(at(out, day(26)).ttwror).toBeCloseTo(0, 6);
  });
});
