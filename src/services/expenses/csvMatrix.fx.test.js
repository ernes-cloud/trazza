import { describe, it, expect } from 'vitest';
import { expensesToCsv } from '../expenseService.js';

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

const labels = {
  date: 'Fecha', type: 'Tipo', category: 'Categoría', amount: 'Importe',
  currency: 'Divisa', notes: 'Notas', income: 'Ingreso', expense: 'Gasto', total: 'Total',
  monthNames: ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'],
  categoryNames: { groceries: 'Comida' },
};

function matrixRow(csv, categoryLabel) {
  const lines = csv.split('\n');
  return lines.find((l) => l.startsWith(`${categoryLabel};`));
}

describe('expensesToCsv matrix — no raw foreign sums', () => {
  const mixed = [
    entry({ id: 'usd', amount: 10, currency: 'USD', entry_date: '2026-06-05' }),
    entry({ id: 'eur', amount: 10, currency: 'EUR', entry_date: '2026-06-08' }),
  ];

  it('without preferredCurrency, matrix sums only convertible rows (EUR 10, not 20)', () => {
    const csv = expensesToCsv(mixed, { year: 2026, labels });
    expect(csv.split('\n')[0]).toBe('Fecha;Tipo;Categoría;Importe;Divisa;Notas');
    const row = matrixRow(csv, 'Comida');
    expect(row).toBeTruthy();
    const cols = row.split(';');
    expect(cols[6]).toBe('10,00'); // June column (index 6: cat + 5 months before Jun)
    expect(cols[13]).toBe('10,00'); // total
  });

  it('with rates but no preferredCurrency column, matrix converts USD into default EUR', () => {
    const csv = expensesToCsv(mixed, { year: 2026, labels, rates: { USD: 0.9 } });
    expect(csv.split('\n')[0]).toBe('Fecha;Tipo;Categoría;Importe;Divisa;Notas');
    const row = matrixRow(csv, 'Comida');
    const cols = row.split(';');
    expect(cols[6]).toBe('19,00');
    expect(cols[13]).toBe('19,00');
  });
});
