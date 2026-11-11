import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const toast = vi.fn();

function fakeT(key, opts) {
  if (opts?.max != null) return `${key}:${opts.max}`;
  return key;
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: fakeT }),
}));

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast }),
}));

const ENGLISH_CAP = 'Expense pagination cap (100000 rows); more rows pending.';

const fetchDashboardExpenseRows = vi.hoisted(() => vi.fn());

vi.mock('@/services/expenses/paginatedFetch', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchDashboardExpenseRows,
  };
});

vi.mock('@/lib/customSupabaseClient', () => ({
  supabase: { from: vi.fn() },
}));

const { useExpenseEntries } = await import('./useExpenseEntries.js');

function mountHook(userId = 'user-1') {
  let api;
  function Probe() {
    api = useExpenseEntries(userId);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return api;
}

async function flushLoad() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('useExpenseEntries — pagination cap fetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('en tope de paginación: toast i18n, sin publicar filas truncadas', async () => {
    fetchDashboardExpenseRows.mockResolvedValue({
      data: null,
      error: {
        code: 'EXPENSE_PAGINATION_CAP',
        maxRows: 100000,
        message: ENGLISH_CAP,
      },
    });
    const api = mountHook();
    expect(api.entries).toEqual([]);
    await api.reload();
    await flushLoad();

    expect(toast).toHaveBeenCalledWith({
      title: 'expenses.pagination_cap_title',
      description: 'expenses.pagination_cap_desc:100000',
      variant: 'destructive',
    });
    const serialized = JSON.stringify(toast.mock.calls);
    expect(serialized).not.toContain(ENGLISH_CAP);
    expect(api.entries).toEqual([]);
  });

  it('error genérico de fetch: toast_error y mensaje del error', async () => {
    fetchDashboardExpenseRows.mockResolvedValue({
      data: null,
      error: { message: 'boom' },
    });
    const api = mountHook();
    await api.reload();
    await flushLoad();

    expect(toast).toHaveBeenCalledWith({
      title: 'expenses.toast_error',
      description: 'boom',
      variant: 'destructive',
    });
  });
});
