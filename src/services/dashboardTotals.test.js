import { describe, it, expect } from 'vitest';
import { computeUnsavedCsvTotals, groupInvestedByTicker } from './dashboardTotals';

const row = (o) => ({ moneda: 'USD', isin: 'US0378331005', producto: 'APPLE', ...o });

describe('computeUnsavedCsvTotals', () => {
  const rates = { USD: 0.9, EUR: 1 };

  it('sin filas devuelve ceros', () => {
    expect(computeUnsavedCsvTotals([], 'EUR', rates)).toEqual({
      realizedGain: 0, totalDivs: 0, totalFees: 0, embeddedComisiones: 0,
      costBasis: 0, totalBuyCost: 0, firstBuyDate: null,
    });
  });

  it('compra, venta parcial, dividendo y comisión en la divisa de la cartera', () => {
    // Llegan DESORDENADAS a propósito: la venta no puede consumir un lote futuro.
    const csv = [
      row({ type: 'SELL', fecha: '10-03-2024', cantidad: 4, precio: 150, comisiones: 1 }),
      row({ type: 'BUY', fecha: '01-02-2024', cantidad: 10, precio: 100, comisiones: 2 }),
      row({ type: 'DIVIDEND', fecha: '15-03-2024', total: 5 }),
      row({ type: 'FEE', fecha: '15-03-2024', total: -2.5, moneda: 'EUR' }),
    ];
    const out = computeUnsavedCsvTotals(csv, 'EUR', rates);
    expect(out.totalBuyCost).toBeCloseTo(10 * 100 * 0.9, 6);
    expect(out.realizedGain).toBeCloseTo(4 * 50 * 0.9, 6);       // FIFO: 4 × (150 − 100)
    expect(out.costBasis).toBeCloseTo(6 * 100 * 0.9, 6);         // quedan 6 a coste medio
    expect(out.totalDivs).toBeCloseTo(5 * 0.9, 6);
    expect(out.totalFees).toBe(2.5);                             // en bruto: lo convierte el llamante
    expect(out.embeddedComisiones).toBe(3);
    expect(out.firstBuyDate).toBe('2024-02-01');
  });

  it('ignora la liquidez y lo que no se reconoce', () => {
    const csv = [
      { type: 'CASH', moneda: 'EUR', total: 1000 },
      { type: 'BUY', isin: 'CASH_EUR', cantidad: 5, precio: 1 },
      row({ type: 'TRANSFER', total: 100 }),
    ];
    const out = computeUnsavedCsvTotals(csv, 'EUR', rates);
    expect(out.totalBuyCost).toBe(0);
    expect(out.totalDivs).toBe(0);
  });

  it('una posición vendida entera no deja coste abierto', () => {
    const csv = [
      row({ type: 'BUY', fecha: '01-01-2024', cantidad: 2, precio: 10 }),
      row({ type: 'SELL', fecha: '02-01-2024', cantidad: 2, precio: 12 }),
    ];
    expect(computeUnsavedCsvTotals(csv, 'USD', rates).costBasis).toBe(0);
  });

  it('no muta la entrada', () => {
    const csv = [row({ type: 'SELL', fecha: '02-01-2024' }), row({ type: 'BUY', fecha: '01-01-2024' })];
    const copy = JSON.parse(JSON.stringify(csv));
    computeUnsavedCsvTotals(csv, 'EUR', rates);
    expect(csv).toEqual(copy);
  });
});

describe('groupInvestedByTicker', () => {
  const pos = (asset_id, assets, quantity) => ({ asset_id, quantity, assets });

  it('la misma acción en dos brokers y dos divisas es UN grupo con dos miembros', () => {
    const groups = groupInvestedByTicker([
      pos('a1', { ticker: 'AAPL', company_name: 'Apple', currency: 'USD', current_price: 200 }, '2'),
      pos('a2', { ticker: 'AAPL', company_name: 'Apple', currency: 'EUR', current_price: 180 }, '3'),
      pos('b1', { ticker: 'MSFT', company_name: 'Microsoft', currency: 'USD' }, '1'),
    ]);
    expect(groups).toHaveLength(2);
    const aapl = groups.find((g) => g.ticker === 'AAPL');
    expect(aapl.quantity).toBe(5);
    expect(aapl.members).toEqual([
      { asset_id: 'a1', currency: 'USD', dbPrice: 200, quantity: 2 },
      { asset_id: 'a2', currency: 'EUR', dbPrice: 180, quantity: 3 },
    ]);
  });

  it('el nombre se completa con el de otro miembro si el primero no lo traía', () => {
    const [g] = groupInvestedByTicker([
      pos('a1', { ticker: 'AAPL', currency: 'USD' }, 1),
      pos('a2', { ticker: 'AAPL', company_name: 'Apple Inc.', currency: 'USD' }, 1),
    ]);
    expect(g.name).toBe('Apple Inc.');
  });
});
