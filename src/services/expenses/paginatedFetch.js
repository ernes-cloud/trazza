/**
 * Paginación explícita de expense_entries para PostgREST (max-rows 1000).
 * PostgREST devuelve la primera página sin error — los totales y los import_key
 * quedan cortos si no se itera con .range.
 */

export const PAGE_SIZE = 1000;
/** 25×1000=25k era justo con historial bancario largo + recurrentes materializadas; 100 páginas es techo de sanidad, no tamaño esperado. */
export const MAX_PAGES = 100;

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} [opts.columns]
 * @param {{ col: string, ascending: boolean }[]} [opts.orders]
 * @returns {Promise<{ data: object[] | null, error: object | null }>}
 */
export async function fetchAllRows(supabase, { userId, columns = '*', orders }) {
  const effectiveOrders = orders?.length
    ? orders
    : [{ col: 'id', ascending: true }];
  const all = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    let q = supabase
      .from('expense_entries')
      .select(columns)
      .eq('user_id', userId);
    for (const { col, ascending } of effectiveOrders) {
      q = q.order(col, { ascending });
    }
    const { data, error } = await q.range(from, from + PAGE_SIZE - 1);
    if (error) return { data: null, error };
    const rows = data || [];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) {
      return { data: all, error: null };
    }
    if (page === MAX_PAGES - 1) {
      const maxRows = PAGE_SIZE * MAX_PAGES;
      return {
        data: null,
        error: {
          code: 'EXPENSE_PAGINATION_CAP',
          maxRows,
          message: `Expense pagination cap (${maxRows} rows); more rows pending.`,
        },
      };
    }
  }
  return { data: all, error: null };
}

export async function fetchExpenseImportKeys(supabase, userId) {
  return fetchAllRows(supabase, {
    userId,
    columns: 'import_key',
    orders: [
      { col: 'entry_date', ascending: false },
      { col: 'id', ascending: false },
    ],
  });
}

export async function fetchDashboardExpenseRows(supabase, userId) {
  return fetchAllRows(supabase, {
    userId,
    columns: '*',
    orders: [
      { col: 'entry_date', ascending: false },
      { col: 'id', ascending: false },
    ],
  });
}
