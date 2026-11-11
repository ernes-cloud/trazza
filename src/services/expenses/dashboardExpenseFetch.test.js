import { describe, it, expect, vi } from 'vitest';
import { EXPENSE_PAGINATION_CAP_CODE, applyDashboardExpenseRowsResult } from './expenseFetchResult.js';
import { PAGE_SIZE, MAX_PAGES } from './paginatedFetch.js';

const maxRows = PAGE_SIZE * MAX_PAGES;

function fakeT(key, opts) {
  if (opts?.max != null) return `${key}:${opts.max}`;
  return key;
}

describe('applyDashboardExpenseRowsResult', () => {
  it('en tope de paginación: toast con claves i18n y no actualiza filas', () => {
    const setExpenseRows = vi.fn();
    const toast = vi.fn();
    const prior = [{ id: 'keep' }];
    let rows = prior;
    const setRows = (next) => {
      setExpenseRows(next);
      rows = next;
    };
    const error = { code: EXPENSE_PAGINATION_CAP_CODE, maxRows, message: 'cap' };
    const ok = applyDashboardExpenseRowsResult(
      { data: null, error },
      { setExpenseRows: setRows, toast, t: fakeT },
    );
    expect(ok).toBe(false);
    expect(setExpenseRows).not.toHaveBeenCalled();
    expect(rows).toBe(prior);
    expect(toast).toHaveBeenCalledWith({
      title: 'expenses.pagination_cap_title',
      description: `expenses.pagination_cap_desc:${maxRows}`,
      variant: 'destructive',
    });
  });

  it('error genérico: toast_error y no actualiza filas', () => {
    const setExpenseRows = vi.fn();
    const toast = vi.fn();
    const ok = applyDashboardExpenseRowsResult(
      { data: [{ id: 'trunc' }], error: { message: 'boom' } },
      { setExpenseRows, toast, t: fakeT },
    );
    expect(ok).toBe(false);
    expect(setExpenseRows).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith({
      title: 'expenses.toast_error',
      description: 'boom',
      variant: 'destructive',
    });
  });

  it('éxito: asigna filas', () => {
    const setExpenseRows = vi.fn();
    const toast = vi.fn();
    const data = [{ id: 'a' }, { id: 'b' }];
    const ok = applyDashboardExpenseRowsResult(
      { data, error: null },
      { setExpenseRows, toast, t: fakeT },
    );
    expect(ok).toBe(true);
    expect(setExpenseRows).toHaveBeenCalledWith(data);
    expect(toast).not.toHaveBeenCalled();
  });

  it('éxito sin filas: lista vacía', () => {
    const setExpenseRows = vi.fn();
    const toast = vi.fn();
    applyDashboardExpenseRowsResult(
      { data: null, error: null },
      { setExpenseRows, toast, t: fakeT },
    );
    expect(setExpenseRows).toHaveBeenCalledWith([]);
  });
});
