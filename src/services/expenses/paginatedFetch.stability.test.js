/**
 * Estabilidad de orden en paginación PostgREST (sin tocar el test TDD expensePagination.test.js).
 */
import { describe, it, expect } from 'vitest';
import {
  PAGE_SIZE,
  MAX_PAGES,
  fetchExpenseImportKeys,
  fetchDashboardExpenseRows,
} from './paginatedFetch.js';

let unstableCallId = 0;

/**
 * Mock PostgREST: .range inclusivo, respuesta ≤1000 filas; orden estable solo si hubo .order.
 */
function createPostgrestMock(tables, { maxRows = PAGE_SIZE } = {}) {
  const from = (name) => {
    let base = [...(tables[name] || [])];
    let columns = '*';
    const orderSpecs = [];
    let rangeSpec = null;
    const builder = {
      select(cols) {
        columns = cols;
        return builder;
      },
      eq(col, val) {
        base = base.filter((r) => r[col] === val);
        return builder;
      },
      order(col, { ascending = true } = {}) {
        orderSpecs.push({ col, ascending });
        return builder;
      },
      range(fromIdx, toIdx) {
        rangeSpec = { from: fromIdx, to: toIdx };
        return builder;
      },
      then(resolve, reject) {
        return Promise.resolve()
          .then(() => {
            let rows = [...base];
            if (orderSpecs.length > 0) {
              rows.sort((a, b) => {
                for (const { col, ascending } of orderSpecs) {
                  if (a[col] === b[col]) continue;
                  const cmp = a[col] < b[col] ? -1 : 1;
                  return ascending ? cmp : -cmp;
                }
                return 0;
              });
            } else {
              const n = rows.length;
              const shift = (unstableCallId * 37) % Math.max(n, 1);
              unstableCallId += 1;
              rows = [...rows.slice(shift), ...rows.slice(0, shift)];
            }
            const start = rangeSpec?.from ?? 0;
            const requestedEnd = rangeSpec?.to ?? start + maxRows - 1;
            const end = Math.min(requestedEnd, start + maxRows - 1);
            const page = rows.slice(start, end + 1);
            const data =
              columns === '*'
                ? page
                : page.map((row) => {
                    const out = {};
                    for (const col of columns.split(',').map((c) => c.trim())) {
                      out[col] = row[col];
                    }
                    return out;
                  });
            return { data, error: null };
          })
          .then(resolve, reject);
      },
    };
    return builder;
  };
  return { from };
}

function buildExpenseRows(count, userId, { idPrefix = 'row' } = {}) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const day = String((i % 28) + 1).padStart(2, '0');
    rows.push({
      id: `${idPrefix}-${i}`,
      user_id: userId,
      entry_date: `2026-01-${day}`,
      import_key: `ik-${i}`,
      amount: 1,
      type: 'expense',
      category: 'other',
    });
  }
  return rows;
}

describe('paginatedFetch stability', () => {
  const userId = 'user-stability';

  it('fetchExpenseImportKeys devuelve todos los import_key sin duplicados ni pérdidas (>1000)', async () => {
    unstableCallId = 0;
    const count = 1105;
    const rows = buildExpenseRows(count, userId);
    const supabase = createPostgrestMock({ expense_entries: rows });
    const { data, error } = await fetchExpenseImportKeys(supabase, userId);
    expect(error).toBeNull();
    expect(data).toHaveLength(count);
    const keys = data.map((r) => r.import_key);
    expect(new Set(keys).size).toBe(count);
    for (let i = 0; i < count; i += 1) {
      expect(keys).toContain(`ik-${i}`);
    }
  });

  it('fetchDashboardExpenseRows devuelve el conjunto completo ordenado sin duplicados', async () => {
    unstableCallId = 0;
    const count = 1105;
    const rows = buildExpenseRows(count, userId);
    const supabase = createPostgrestMock({ expense_entries: rows });
    const { data, error } = await fetchDashboardExpenseRows(supabase, userId);
    expect(error).toBeNull();
    expect(data).toHaveLength(count);
    const ids = data.map((r) => r.id);
    expect(new Set(ids).size).toBe(count);
    for (let i = 1; i < data.length; i += 1) {
      const prev = data[i - 1];
      const cur = data[i];
      const dateCmp = cur.entry_date.localeCompare(prev.entry_date);
      expect(dateCmp <= 0).toBe(true);
      if (dateCmp === 0) {
        expect(String(cur.id).localeCompare(String(prev.id)) <= 0).toBe(true);
      }
    }
  });

  it('no devuelve en silencio cuando supera MAX_PAGES × PAGE_SIZE', async () => {
    unstableCallId = 0;
    const count = MAX_PAGES * PAGE_SIZE + 1;
    const rows = buildExpenseRows(count, userId, { idPrefix: 'cap' });
    const supabase = createPostgrestMock({ expense_entries: rows });
    const { data, error } = await fetchExpenseImportKeys(supabase, userId);
    expect(error).not.toBeNull();
    expect(error.code).toBe('EXPENSE_PAGINATION_CAP');
    expect(error.maxRows).toBe(PAGE_SIZE * MAX_PAGES);
    expect(error.message).toMatch(/pagination cap/i);
    expect(data).toBeNull();
  });
});
