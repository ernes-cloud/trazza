import { describe, it, expect } from 'vitest';
import { computeSnapshotForUser, madridToday } from './portfolioSnapshots.js';

const pos = (qty, assetOver = {}) => ({
  quantity: qty,
  entry_price: 10,
  assets: {
    ticker: 'MSFT',
    currency: 'USD',
    current_price: 90,
    asset_class: 'Stock',
    ...assetOver,
  },
});

describe('computeSnapshotForUser', () => {
  it('valora con la quote viva (divisa de la quote) convertida a EUR', () => {
    const quotes = new Map([['MSFT', { current: 100, currency: 'USD' }]]);
    const snap = computeSnapshotForUser([pos(10)], quotes, { EUR: 1, USD: 0.9 });
    expect(snap.positionsValueEur).toBeCloseTo(900, 10); // 10 × 100 × 0.9
    expect(snap.cashEur).toBe(0);
    expect(snap.totalValueEur).toBeCloseTo(900, 10);
    expect(snap.quoteMisses).toBe(0);
  });

  it('cae al precio de la BD (assets.current_price) y cuenta el miss', () => {
    const snap = computeSnapshotForUser([pos(10)], new Map(), { USD: 0.9 });
    expect(snap.positionsValueEur).toBeCloseTo(10 * 90 * 0.9, 10);
    expect(snap.quoteMisses).toBe(1);
  });

  it('los fondos monetarios (ticker con espacios) usan precio BD sin contar como miss', () => {
    const snap = computeSnapshotForUser(
      [pos(5000, { ticker: 'BGIF EURO MARKETS', currency: 'EUR', current_price: 1 })],
      new Map(),
      { EUR: 1 },
    );
    expect(snap.positionsValueEur).toBeCloseTo(5000, 10);
    expect(snap.quoteMisses).toBe(0);
  });

  it('separa cash (por cantidad × rate) de posiciones invertidas', () => {
    const rows = [
      pos(10, {}),
      pos(2000, { ticker: 'CASH_USD', currency: 'USD', asset_class: 'Cash', current_price: 1 }),
    ];
    const quotes = new Map([['MSFT', { current: 100, currency: 'USD' }]]);
    const snap = computeSnapshotForUser(rows, quotes, { USD: 0.9 });
    expect(snap.cashEur).toBeCloseTo(1800, 10);      // 2000 × 0.9
    expect(snap.positionsValueEur).toBeCloseTo(900, 10);
    expect(snap.totalValueEur).toBeCloseTo(2700, 10);
  });

  it('ignora posiciones cerradas (qty 0) y genera breakdown ordenado por valor', () => {
    const rows = [
      pos(0),
      pos(1, { ticker: 'SMALL', currency: 'EUR', current_price: 50 }),
      pos(1, { ticker: 'BIG', currency: 'EUR', current_price: 500 }),
    ];
    const snap = computeSnapshotForUser(rows, new Map(), { EUR: 1 });
    expect(snap.breakdown.map(b => b.t)).toEqual(['BIG', 'SMALL']);
    expect(snap.breakdown[0].v).toBeCloseTo(500, 10);
  });

  it('resuelve el ticker antes de buscar la quote (ISIN → símbolo Yahoo)', () => {
    // US5949181045 está en el TICKER_MAP del server → MSFT
    const quotes = new Map([['MSFT', { current: 100, currency: 'USD' }]]);
    const snap = computeSnapshotForUser(
      [pos(1, { ticker: 'US5949181045' })],
      quotes,
      { USD: 1 },
    );
    expect(snap.positionsValueEur).toBeCloseTo(100, 10);
    expect(snap.quoteMisses).toBe(0);
  });

  it('divisa sin rate → rate 1 (no revienta, valor en divisa nativa)', () => {
    const quotes = new Map([['MSFT', { current: 100, currency: 'XXX' }]]);
    const snap = computeSnapshotForUser([pos(1)], quotes, {});
    expect(snap.positionsValueEur).toBeCloseTo(100, 10);
  });
});

describe('madridToday', () => {
  it('devuelve una fecha ISO YYYY-MM-DD', () => {
    expect(madridToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('posiciones de DeGiro ("ISIN (DIVISA)") — regresión 2026-10-02', () => {
  // La clave de DeGiro lleva espacio y paréntesis: el filtro de "cotizable" se
  // aplicaba a la clave EN BRUTO y la descartaba antes de traducirla a META,
  // así que esas posiciones se valoraban SIEMPRE con el precio guardado.
  it('se cotizan con el símbolo resuelto, no con el precio de la BD', () => {
    const quotes = new Map([['META', { current: 700, currency: 'USD' }]]);
    const snap = computeSnapshotForUser(
      [pos(2, { ticker: 'US30303M1027 (USD)', current_price: 999 })], quotes, { EUR: 1, USD: 0.9 },
    );
    expect(snap.positionsValueEur).toBeCloseTo(2 * 700 * 0.9, 10);
    expect(snap.quoteMisses).toBe(0);
  });

  it('una clave sin traducción (ISIN suelto) cuenta como miss y cae a la BD', () => {
    const snap = computeSnapshotForUser(
      [pos(1, { ticker: 'US6541061031 (USD)', current_price: 50 })], new Map(), { USD: 1 },
    );
    expect(snap.positionsValueEur).toBe(50);
    expect(snap.quoteMisses).toBe(1);
  });
});
