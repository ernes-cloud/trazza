import { PAGE_SIZE, MAX_PAGES } from './paginatedFetch.js';

export const EXPENSE_PAGINATION_CAP_CODE = 'EXPENSE_PAGINATION_CAP';

export const EXPENSE_PAGINATION_MAX_ROWS = PAGE_SIZE * MAX_PAGES;

export function isExpensePaginationCapError(error) {
  if (!error) return false;
  return error.code === EXPENSE_PAGINATION_CAP_CODE;
}

/**
 * @param {object | null} error
 * @param {{ toast: (opts: object) => void, t: (key: string, opts?: object) => string }} deps
 */
export function toastExpenseFetchError(error, { toast, t }) {
  if (!error) return;
  if (isExpensePaginationCapError(error)) {
    const max = error.maxRows ?? EXPENSE_PAGINATION_MAX_ROWS;
    toast({
      title: t('expenses.pagination_cap_title'),
      description: t('expenses.pagination_cap_desc', { max }),
      variant: 'destructive',
    });
    return;
  }
  toast({
    title: t('expenses.toast_error'),
    description: error.message,
    variant: 'destructive',
  });
}

/**
 * @param {{ data: object[] | null, error: object | null }} result
 * @param {{ setImportedKeys: (s: Set) => void, setIsBankImportOpen: (b: boolean) => void, toast: (opts: object) => void, t: (key: string, opts?: object) => string }} deps
 * @returns {boolean} true si el fetch fue exitoso
 */
export function applyExpenseImportKeysResult({ data, error }, { setImportedKeys, setIsBankImportOpen, toast, t }) {
  if (error) {
    toastExpenseFetchError(error, { toast, t });
    setIsBankImportOpen(false);
    return false;
  }
  setImportedKeys(new Set((data || []).map((r) => r.import_key).filter(Boolean)));
  setIsBankImportOpen(true);
  return true;
}

/**
 * @param {{ data: object[] | null, error: object | null }} result
 * @param {{ setExpenseRows: (rows: object[]) => void, toast: (opts: object) => void, t: (key: string, opts?: object) => string }} deps
 * @returns {boolean} true si el fetch fue exitoso
 */
export function applyDashboardExpenseRowsResult({ data, error }, { setExpenseRows, toast, t }) {
  if (error) {
    toastExpenseFetchError(error, { toast, t });
    return false;
  }
  setExpenseRows(data || []);
  return true;
}
