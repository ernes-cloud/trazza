/**
 * Huecos de honestidad en P0-3 que la implementación de Develop (7234230a)
 * aún no cubre:
 *
 * 1) currencyService.getExchangeRate, si el fetch falla, no lanza: devuelve 1
 *    o un par fijo (USDEUR=0.92, EURUSD=1.08, …). useExpenseRates inyecta
 *    cualquier número finito > 0, así que ese fallback se usa como rate
 *    válido y el agregado convierte (suma deshonesta).
 *    Contrato: un fetch fallido no puede acabar en `rates`. El agregado
 *    marca no convertible y no usa 1 ni el par fijo.
 *
 * 2) computeDayGroups (lista y widget del dashboard) sigue sumando
 *    `row.amount` nativo, sin preferredCurrency/rates ni marca de exclusión.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as expenseService from '../expenseService.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const YEAR = 2026;
const MONTH = 6;

const entry = (over = {}) => ({
  id: over.id || 'e1',
  type: 'expense',
  category: 'groceries',
  amount: 10,
  currency: 'EUR',
  entry_date: '2026-06-10',
  recurrence: 'none',
  recurring_source_id: null,
  source_month: null,
  ...over,
});

const MIXED = [
  entry({ id: 'ex-usd', type: 'expense', category: 'groceries', amount: 10, currency: 'USD', entry_date: '2026-06-10' }),
  entry({ id: 'ex-eur', type: 'expense', category: 'housing', amount: 10, currency: 'EUR', entry_date: '2026-06-10' }),
  entry({ id: 'in-eur', type: 'income', category: 'salary', amount: 20, currency: 'EUR', entry_date: '2026-06-01' }),
];

function marksNotConvertible(result) {
  return result?.notConvertible === true
    || (Number.isFinite(result?.excludedCount) && result.excludedCount > 0)
    || (Array.isArray(result?.excluded) && result.excluded.length > 0);
}

describe('P0-3 fetch FX fallido: no inyectar 1 ni el par fijo', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('@/services/yahooFinance');
    vi.doUnmock('../yahooFinance.js');
  });

  it('con getQuote rechazado, getExchangeRate no debe entregar un rate usable (ni 1 ni el par fijo)', async () => {
    vi.doMock('@/services/yahooFinance', () => ({
      yahooFinanceService: {
        getQuote: vi.fn().mockRejectedValue(new Error('yahoo down')),
      },
      barDateFromTimestamp: () => null,
    }));

    const { currencyService } = await import('@/services/currencyService.js');
    let rate = null;
    let threw = false;
    try {
      rate = await currencyService.getExchangeRate('USD', 'EUR', { allowFallback: false });
    } catch {
      threw = true;
      rate = null;
    }

    const usable = Number.isFinite(rate) && rate > 0;
    expect(
      threw || !usable,
      `fetch fallido no puede devolver un rate usable (got ${rate}); sería 1 o el par fijo USDEUR=0.92 inyectable como válido`,
    ).toBe(true);
  });

  it('un fetch fallido deja el agregado en «no convertible» y no convierte 10 USD con 1 ni con el par fijo', async () => {
    vi.doMock('@/services/yahooFinance', () => ({
      yahooFinanceService: {
        getQuote: vi.fn().mockRejectedValue(new Error('yahoo down')),
      },
      barDateFromTimestamp: () => null,
    }));

    const { currencyService } = await import('@/services/currencyService.js');
    const hookSrc = fs.readFileSync(path.join(ROOT, 'src/hooks/useExpenseRates.js'), 'utf8');
    expect(
      /allowFallback\s*:\s*false/.test(hookSrc) || /loadUsableExpenseRates/.test(hookSrc),
      'useExpenseRates no debe inyectar el 1/par fijo que getExchangeRate devuelve cuando el fetch falla',
    ).toBe(true);

    let rate = null;
    try {
      rate = await currencyService.getExchangeRate('USD', 'EUR', { allowFallback: false });
    } catch {
      rate = null;
    }
    const rates = {};
    if (Number.isFinite(rate) && rate > 0) rates.USD = rate;

    const summary = expenseService.computeMonthlySummary(MIXED, {
      year: YEAR,
      month: MONTH,
      preferredCurrency: 'EUR',
      rates,
    });
    expect(
      summary.expenses,
      `con fetch fallido no se convierte 10 USD (ni con 1 ni con el par fijo ${rate}); solo queda el 10 EUR`,
    ).toBe(10);
    expect(summary.expenses).not.toBe(20);
    expect(marksNotConvertible(summary), 'el agregado debe marcar no convertible / excluded').toBe(true);
    expect(rates.USD, 'el mapa inyectado no debe llevar el fallback').toBeUndefined();
  });
});

describe('P0-3 computeDayGroups: conversión o marca, no suma nativa', () => {
  const FX = { preferredCurrency: 'EUR', rates: { USD: 0.9 } };
  const sameDay = [
    entry({ id: 'ex-usd', amount: 10, currency: 'USD', entry_date: '2026-06-10' }),
    entry({ id: 'ex-eur', amount: 10, currency: 'EUR', category: 'housing', entry_date: '2026-06-10' }),
  ];

  it('acepta preferredCurrency/rates y el neto del día no es la suma cruda (20)', () => {
    expect(typeof expenseService.computeDayGroups).toBe('function');
    const groups = expenseService.computeDayGroups(sameDay, FX);
    expect(groups, 'debe devolver grupos').toBeTruthy();
    const day = Array.isArray(groups) ? groups.find((g) => g.day === '2026-06-10') : groups;
    expect(day, 'debe existir el grupo del 2026-06-10').toBeTruthy();
    // 10 USD * 0.9 + 10 EUR = 19 de gasto → net -19. Sin convertir sería -20.
    expect(
      day.net,
      'computeDayGroups suma amount nativo (-20); debe convertir (net -19) o excluir lo no convertible',
    ).not.toBe(-20);
    expect(day.net === -19 || marksNotConvertible(day) || marksNotConvertible(groups)).toBe(true);
  });

  it('sin rate usable excluye la fila y marca no convertible (no suma 10 USD en crudo)', () => {
    const groups = expenseService.computeDayGroups(sameDay, {
      preferredCurrency: 'EUR',
      rates: {},
    });
    const day = Array.isArray(groups) ? groups.find((g) => g.day === '2026-06-10') : groups;
    expect(day.net, 'sin rate, el neto no puede ser -20 (10 USD + 10 EUR en crudo)').not.toBe(-20);
    expect(day.net).toBe(-10);
    expect(marksNotConvertible(day) || marksNotConvertible(groups)).toBe(true);
  });
});
