import { describe, it, expect } from 'vitest';
import { computeMoneyFlow } from '../expenseService.js';

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

describe('computeMoneyFlow biggest — converted amounts', () => {
  it('uses converted value for biggest when FX rates are present', () => {
    const rows = [
      entry({ id: 'usd', amount: 10, currency: 'USD', entry_date: '2026-06-05' }),
      entry({ id: 'eur', amount: 5, currency: 'EUR', entry_date: '2026-06-08', notes: 'pequeño' }),
    ];
    const flow = computeMoneyFlow(rows, {
      year: 2026,
      month: 6,
      preferredCurrency: 'EUR',
      rates: { USD: 0.9 },
    });
    const groceries = flow.sinks.find((n) => n.category === 'groceries');
    expect(groceries.count).toBe(2);
    expect(groceries.biggest.amount).toBe(9);
    expect(groceries.biggest.amount).not.toBe(10);
  });

  it('does not pick a non-convertible foreign row by native amount', () => {
    const rows = [
      entry({ id: 'usd', amount: 10, currency: 'USD', entry_date: '2026-06-05' }),
      entry({ id: 'eur', amount: 5, currency: 'EUR', entry_date: '2026-06-08' }),
    ];
    const flow = computeMoneyFlow(rows, {
      year: 2026,
      month: 6,
      preferredCurrency: 'EUR',
      rates: {},
    });
    const groceries = flow.sinks.find((n) => n.category === 'groceries');
    expect(groceries.count).toBe(1);
    expect(groceries.biggest).toEqual({
      amount: 5,
      notes: null,
      entry_date: '2026-06-08',
    });
  });
});
