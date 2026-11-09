import { describe, it, expect } from 'vitest';
import { computeCapitalGains } from './capitalGains';
import { computeCapitalGains as legacyComputeCapitalGains, addMonths } from './__legacy__/capitalGains.legacy';

// Equivalencia: la calculadora pública (envoltorio fino sobre tax/twoMonthRule)
// tiene que dar EXACTAMENTE lo mismo que la implementación anterior, congelada
// en __legacy__/capitalGains.legacy.js, en miles de carteras pseudoaleatorias.
// Semilla fija: si falla, el caso es reproducible (se imprime su número).

const EQUIVALENCE_CASES = 6000;

/** mulberry32: PRNG de 32 bits, determinista y sin dependencias. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const shiftDays = (iso, days) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10);
};

// Fechas ancla: fines de mes (28/29/30/31, bisiestos incluidos) y días normales.
const ANCHORS = [
  '2024-01-31', '2024-02-29', '2024-03-31', '2024-04-30', '2024-05-15', '2024-08-31',
  '2024-10-31', '2024-12-31', '2025-01-31', '2025-02-28', '2025-03-30', '2025-04-30',
  '2025-06-30', '2025-07-01', '2025-11-30', '2025-12-31', '2026-01-01', '2026-02-28',
];
// Nombres que se normalizan igual (trim + mayúsculas) y uno distinto.
const ASSET_SPELLINGS = [['ACME', 'acme', ' Acme '], ['Beta SA'], ['GAMMA', 'gamma']];

function generatePortfolio(rand) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const nAssets = int(1, 3);
  const nOps = int(2, 25);
  const held = new Map();
  const ops = [];
  let date = pick(ANCHORS);

  for (let i = 0; i < nOps; i += 1) {
    const assetIdx = int(0, nAssets - 1);
    const asset = pick(ASSET_SPELLINGS[assetIdx]);
    // Siguiente fecha: misma fecha, días sueltos, o justo en el borde de ±2 meses (±1 día).
    const r = rand();
    if (r < 0.15) { /* misma fecha */ }
    else if (r < 0.45) date = shiftDays(date, int(1, 20));
    else if (r < 0.75) date = shiftDays(addMonths(date, pick([1, 2])), int(-1, 1));
    else if (r < 0.85) date = shiftDays(date, -int(1, 40)); // fuera de orden: prepare ordena
    else date = pick(ANCHORS);

    const h = held.get(assetIdx) || 0;
    const price = Math.round((1 + rand() * 199) * 10 ** int(0, 4)) / 10 ** int(0, 4) || 0.5;
    const fee = rand() < 0.5 ? 0 : Math.round(rand() * 1500) / 100;
    let type = 'buy';
    let qty;
    if (h > 0 && rand() < 0.55) {
      type = 'sell';
      const s = rand();
      if (s < 0.3) qty = h;                                     // vende todo (recompras después)
      else if (s < 0.9) qty = Math.max(1, Math.floor(h * rand())) || 1;
      else qty = h + int(1, 5);                                 // sobreventa
    } else if (h === 0 && rand() < 0.08) {
      type = 'sell'; qty = int(1, 10);                          // venta sin compras
    } else {
      qty = rand() < 0.2 ? Math.round(rand() * 1000) / 100 || 1 : int(1, 300);
    }
    held.set(assetIdx, type === 'buy' ? h + qty : Math.max(0, h - qty));

    const op = { id: `op${i}`, asset, type, date, qty, price, fee };
    // De vez en cuando, filas inválidas (deben quedar fuera igual en las dos).
    const bad = rand();
    if (bad < 0.01) op.date = '31-12-2025';
    else if (bad < 0.02) op.qty = 0;
    else if (bad < 0.025) op.fee = -1;
    ops.push(op);
  }
  // A veces se entregan desordenadas del todo.
  if (rand() < 0.2) ops.sort(() => rand() - 0.5);
  return { ops, otherSavingsIncome: rand() < 0.3 ? int(0, 300000) : 0 };
}

describe('computeCapitalGains — equivalencia con la implementación anterior', () => {
  it(`${EQUIVALENCE_CASES} carteras pseudoaleatorias dan la misma salida`, () => {
    const rand = mulberry32(20261022);
    let withDeferral = 0;
    let withRelease = 0;
    let withOversold = 0;
    for (let n = 0; n < EQUIVALENCE_CASES; n += 1) {
      const { ops, otherSavingsIncome } = generatePortfolio(rand);
      const legacy = legacyComputeCapitalGains(ops, { otherSavingsIncome });
      const current = computeCapitalGains(ops, { otherSavingsIncome });
      if (legacy.sales.some((s) => s.deferred > 0)) withDeferral += 1;
      if (legacy.sales.some((s) => s.released > 0)) withRelease += 1;
      if (legacy.oversold.length > 0) withOversold += 1;
      try {
        expect(current).toEqual(legacy);
      } catch (error) {
        throw new Error(`caso ${n}: ${JSON.stringify({ ops, otherSavingsIncome })}\n${error.message}`);
      }
    }
    // El generador tiene que ejercitar de verdad la regla, no solo FIFO.
    expect(withDeferral).toBeGreaterThan(EQUIVALENCE_CASES * 0.2);
    expect(withRelease).toBeGreaterThan(EQUIVALENCE_CASES * 0.05);
    expect(withOversold).toBeGreaterThan(EQUIVALENCE_CASES * 0.05);
  }, 120000);
});
