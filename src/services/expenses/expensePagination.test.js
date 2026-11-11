/**
 * P0-2 paginación PostgREST (máx. 1000 filas por respuesta).
 *
 * El fetch de import_key (ExpensesPage.openBankImport) y el del Dashboard
 * (Dashboard.fetchExpenseRows) deben devolver el conjunto completo para que
 * un reimport no cree altas duplicadas y los totales del Dashboard no se
 * queden cortos. Hoy ambos son un select sin .range — el mock recorta a
 * 1000 y estos casos quedan rojos por esa razón.
 *
 * Si Develop publica un helper (paginatedFetch.js / expenseQueries.js) con
 * fetchExpenseImportKeys y fetchDashboardExpenseRows, este test lo usa.
 * Si no, ejecuta el patrón actual de las páginas (código real, sin paginar).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const PAGE_SIZE = 1000;
const OVERSIZE = 1105;

function createPostgrestMock(tables, { maxRows = PAGE_SIZE } = {}) {
  const from = (name) => {
    let rows = [...(tables[name] || [])];
    let columns = '*';
    const builder = {
      select(cols) { columns = cols; return builder; },
      eq(col, val) { rows = rows.filter((r) => r[col] === val); return builder; },
      not(col, op, val) {
        if (op === 'is' && val === null) rows = rows.filter((r) => r[col] != null);
        return builder;
      },
      order(col, { ascending } = {}) {
        rows = [...rows].sort((a, b) => {
          if (a[col] === b[col]) return 0;
          const cmp = a[col] < b[col] ? -1 : 1;
          return ascending === false ? -cmp : cmp;
        });
        return builder;
      },
      range(fromIdx, toIdx) {
        builder._range = { from: fromIdx, to: toIdx };
        return builder;
      },
      then(resolve, reject) {
        return Promise.resolve().then(() => {
          const start = builder._range ? builder._range.from : 0;
          const requestedEnd = builder._range ? builder._range.to : maxRows - 1;
          const end = Math.min(requestedEnd, start + maxRows - 1);
          const page = rows.slice(start, end + 1);
          const data = columns === '*'
            ? page
            : page.map((row) => {
              const out = {};
              for (const col of columns.split(',').map((c) => c.trim())) out[col] = row[col];
              return out;
            });
          return { data, error: null };
        }).then(resolve, reject);
      },
    };
    return builder;
  };
  return { from };
}

/** Patrón actual de ExpensesPage.openBankImport (src/pages/ExpensesPage.jsx). */
export async function currentOpenBankImportFetch(supabase, userId) {
  const { data, error } = await supabase
    .from('expense_entries')
    .select('import_key')
    .eq('user_id', userId);
  return { data, error };
}

/** Patrón actual de Dashboard.fetchExpenseRows (src/pages/Dashboard.jsx). */
export async function currentDashboardFetch(supabase, userId) {
  const { data, error } = await supabase
    .from('expense_entries')
    .select('*')
    .eq('user_id', userId)
    .order('entry_date', { ascending: false });
  return { data, error };
}

async function loadProdFetchers() {
  const candidates = [
    path.join(HERE, 'paginatedFetch.js'),
    path.join(HERE, 'expenseQueries.js'),
    path.join(ROOT, 'src/lib/expenseQueries.js'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const mod = await import(pathToFileURL(file).href);
    if (typeof mod.fetchExpenseImportKeys === 'function' && typeof mod.fetchDashboardExpenseRows === 'function') {
      return { source: file, ...mod };
    }
  }
  return {
    source: 'current-unpaged-page-code',
    fetchExpenseImportKeys: currentOpenBankImportFetch,
    fetchDashboardExpenseRows: currentDashboardFetch,
  };
}

function seedEntries(n, userId) {
  return Array.from({ length: n }, (_, i) => ({
    id: `e-${i}`,
    user_id: userId,
    import_key: `key-${String(i).padStart(5, '0')}`,
    amount: 1,
    type: 'expense',
    entry_date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
  }));
}

function extractFn(src, name) {
  const start = src.search(new RegExp(`(const|async function|function)\\s+${name}\\b`));
  if (start < 0) return '';
  return src.slice(start, start + 900);
}

function usesPagination(fnSrc) {
  return /fetchAllRows|\.range\s*\(|fetchExpenseImportKeys|fetchDashboardExpenseRows|paginatedFetch|MAX_PAGES/.test(fnSrc);
}

const userId = 'user-a';

describe('P0-2 paginación import_key y Dashboard (>1000 filas)', () => {
  it('el fetch de import_key de ExpensesPage.openBankImport debe paginar (código real)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/pages/ExpensesPage.jsx'), 'utf8');
    const body = extractFn(src, 'openBankImport');
    expect(body, 'no se encontró openBankImport en ExpensesPage.jsx').toContain('import_key');
    expect(
      usesPagination(body),
      'openBankImport hace un select de import_key sin paginar; PostgREST cortará a 1000',
    ).toBe(true);
  });

  it('el fetch del Dashboard (fetchExpenseRows) debe paginar (código real)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/pages/Dashboard.jsx'), 'utf8');
    const body = extractFn(src, 'fetchExpenseRows');
    expect(body, 'no se encontró fetchExpenseRows en Dashboard.jsx').toContain('expense_entries');
    expect(
      usesPagination(body),
      'fetchExpenseRows hace un select * sin paginar; los totales del Dashboard quedan cortos',
    ).toBe(true);
  });

  it('con más de 1000 import_key, un reimport da 0 altas', async () => {
    const impl = await loadProdFetchers();
    const rows = seedEntries(OVERSIZE, userId);
    const supabase = createPostgrestMock({ expense_entries: rows });
    const { data, error } = await impl.fetchExpenseImportKeys(supabase, userId);
    expect(error).toBeNull();
    const existing = new Set((data || []).map((r) => r.import_key).filter(Boolean));
    const incoming = rows.map((r) => r.import_key);
    const altas = incoming.filter((k) => !existing.has(k));
    expect(
      existing.size,
      `el fetch debe devolver las ${OVERSIZE} claves (impl: ${impl.source}); PostgREST recorta a ${PAGE_SIZE} si no hay paginación`,
    ).toBe(OVERSIZE);
    expect(altas, 'un reimport del mismo extracto debe dar 0 altas').toHaveLength(0);
  });

  it('con más de 1000 filas, el fetch del Dashboard da totales completos', async () => {
    const impl = await loadProdFetchers();
    const rows = seedEntries(OVERSIZE, userId);
    const supabase = createPostgrestMock({ expense_entries: rows });
    const { data, error } = await impl.fetchDashboardExpenseRows(supabase, userId);
    expect(error).toBeNull();
    const total = (data || []).reduce((s, r) => s + Number(r.amount), 0);
    expect(data, `impl: ${impl.source}`).toHaveLength(OVERSIZE);
    expect(total, 'el total debe incluir todas las filas, no solo la primera página').toBe(OVERSIZE);
  });

  it('el mock recorta cada página a 1000 como PostgREST (incluso si se pide un range mayor)', async () => {
    const rows = seedEntries(OVERSIZE, userId);
    const supabase = createPostgrestMock({ expense_entries: rows });
    const { data } = await supabase.from('expense_entries').select('import_key').eq('user_id', userId).range(0, 9999);
    expect(data).toHaveLength(PAGE_SIZE);
  });
});
