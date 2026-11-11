import { describe, it, expect, vi } from 'vitest';
import { EXPENSE_PAGINATION_CAP_CODE, applyExpenseImportKeysResult } from './expenseFetchResult.js';
import { PAGE_SIZE, MAX_PAGES } from './paginatedFetch.js';

const maxRows = PAGE_SIZE * MAX_PAGES;

function fakeT(key, opts) {
  if (opts?.max != null) return `${key}:${opts.max}`;
  return key;
}

describe('applyExpenseImportKeysResult', () => {
  it('en tope de paginación: toast i18n, no vacía claves, cierra diálogo', () => {
    const previous = new Set(['ik-existing']);
    let keys = previous;
    const setImportedKeys = vi.fn((next) => { keys = next; });
    const setIsBankImportOpen = vi.fn();
    const toast = vi.fn();
    const error = { code: EXPENSE_PAGINATION_CAP_CODE, maxRows, message: 'cap' };
    const ok = applyExpenseImportKeysResult(
      { data: null, error },
      { setImportedKeys, setIsBankImportOpen, toast, t: fakeT },
    );
    expect(ok).toBe(false);
    expect(setImportedKeys).not.toHaveBeenCalled();
    expect(keys).toBe(previous);
    expect(keys.size).toBe(1);
    expect(setIsBankImportOpen).toHaveBeenCalledWith(false);
    expect(toast).toHaveBeenCalledWith({
      title: 'expenses.pagination_cap_title',
      description: `expenses.pagination_cap_desc:${maxRows}`,
      variant: 'destructive',
    });
  });

  it('error genérico: toast_error, claves intactas, diálogo cerrado', () => {
    const previous = new Set(['a', 'b']);
    let keys = previous;
    const setImportedKeys = vi.fn((next) => { keys = next; });
    const setIsBankImportOpen = vi.fn();
    const toast = vi.fn();
    applyExpenseImportKeysResult(
      { data: null, error: { message: 'network' } },
      { setImportedKeys, setIsBankImportOpen, toast, t: fakeT },
    );
    expect(setImportedKeys).not.toHaveBeenCalled();
    expect(keys).toBe(previous);
    expect(setIsBankImportOpen).toHaveBeenCalledWith(false);
    expect(toast).toHaveBeenCalledWith({
      title: 'expenses.toast_error',
      description: 'network',
      variant: 'destructive',
    });
  });

  it('éxito: rellena import_key y abre diálogo', () => {
    const setImportedKeys = vi.fn();
    const setIsBankImportOpen = vi.fn();
    const toast = vi.fn();
    const data = [
      { import_key: 'k1' },
      { import_key: null },
      { import_key: 'k2' },
    ];
    const ok = applyExpenseImportKeysResult(
      { data, error: null },
      { setImportedKeys, setIsBankImportOpen, toast, t: fakeT },
    );
    expect(ok).toBe(true);
    expect(setIsBankImportOpen).toHaveBeenCalledWith(true);
    expect(setImportedKeys).toHaveBeenCalledTimes(1);
    const arg = setImportedKeys.mock.calls[0][0];
    expect(arg).toBeInstanceOf(Set);
    expect([...arg]).toEqual(['k1', 'k2']);
    expect(toast).not.toHaveBeenCalled();
  });
});
