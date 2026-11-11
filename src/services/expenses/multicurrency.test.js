/**
 * P0-3 Multidivisa honesta.
 *
 * Los agregados de Gastos deben convertir a `preferredCurrency` con rates
 * inyectados con la misma forma que `currencyService.getExchangeRate(from, to)`
 * (unidades de `to` por 1 unidad de `from`), como hace la cartera en
 * `computeHistoryTotals` / RebalancingCalculator. Sin provider nuevo.
 *
 * Contrato (expenseService):
 * - `convertExpenseAmount(amount, currency, preferredCurrency, rates)` es la
 *   única fórmula. Misma divisa → el importe, sin consultar rates.
 *   `currency` ausente, vacía o no string → se trata como `preferredCurrency`
 *   (no se excluye). Rate ausente, 0, negativo o NaN → no convertible.
 * - Importes convertidos se redondean a 2 decimales (half-up). Los agregados
 *   suman esos valores ya redondeados, para que donut, Sankey, presupuestos,
 *   proyección y CSV coincidan.
 * - Las funciones de agregado aceptan `{ preferredCurrency, rates }` y, si hay
 *   exclusiones, exponen `notConvertible: true` y una lista `excluded` (filas
 *   con al menos `id` o `currency`+`amount`) o un `excludedCount` visible.
 * - `expensesToCsv(..., { preferredCurrency, rates, labels })` incluye importe
 *   original, moneda original e importe convertido, o `labels.notConvertible`.
 * - `presentBreakdown(rows, { privacyMode })` en modo privacidad devuelve
 *   porcentajes y no importes.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as expenseService from '../expenseService.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const YEAR = 2026;
const MONTH = 6;
const PREFERRED = 'EUR';
const RATES = { USD: 0.9, GBP: 1.15 };
const FX = { preferredCurrency: PREFERRED, rates: RATES };

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

/** 10 USD (comida) + 10 EUR (vivienda) + 20 EUR de ingreso. Totales en EUR: gastos 19, ingresos 20. */
const MIXED = [
  entry({ id: 'ex-usd', type: 'expense', category: 'groceries', amount: 10, currency: 'USD', entry_date: '2026-06-10' }),
  entry({ id: 'ex-eur', type: 'expense', category: 'housing', amount: 10, currency: 'EUR', entry_date: '2026-06-11' }),
  entry({ id: 'in-eur', type: 'income', category: 'salary', amount: 20, currency: 'EUR', entry_date: '2026-06-01' }),
];
const EXPECTED_EXPENSES = 19; // 9 + 10, no 20
const EXPECTED_INCOME = 20;
const EXPECTED_NET = 1;
const RAW_EXPENSES = 20; // lo que haría una suma cruda

const CSV_LABELS = {
  date: 'Fecha',
  type: 'Tipo',
  category: 'Categoría',
  amount: 'Importe original',
  currency: 'Moneda original',
  converted: 'Importe convertido',
  notConvertible: 'no convertible',
  notes: 'Notas',
  income: 'Ingreso',
  expense: 'Gasto',
  total: 'Total',
  monthNames: ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'],
  categoryNames: { groceries: 'Comida', housing: 'Vivienda', salary: 'Nómina' },
};

function excludedList(result) {
  if (Array.isArray(result?.excluded)) return result.excluded;
  if (Array.isArray(result?.notConvertibleRows)) return result.notConvertibleRows;
  if (Array.isArray(result?.unconverted)) return result.unconverted;
  return [];
}

function excludedCount(result) {
  if (Number.isFinite(result?.excludedCount)) return result.excludedCount;
  return excludedList(result).length;
}

function marksNotConvertible(result) {
  return result?.notConvertible === true
    || excludedCount(result) > 0
    || excludedList(result).length > 0;
}

describe('P0-3 convertExpenseAmount (fórmula única, rates de currencyService)', () => {
  it('está exportado por expenseService y convierte con rates inyectados (getExchangeRate: from→preferred)', () => {
    expect(typeof expenseService.convertExpenseAmount, 'falta convertExpenseAmount en expenseService — es la fórmula única').toBe('function');
    const usd = expenseService.convertExpenseAmount(10, 'USD', 'EUR', { USD: 0.9 });
    const value = usd && typeof usd === 'object' ? usd.value : usd;
    expect(value).toBe(9);
  });

  it('10 USD + 10 EUR, con USD→EUR 0.9, no suman 20: el mensual da 19 EUR', () => {
    const summary = expenseService.computeMonthlySummary(MIXED, { year: YEAR, month: MONTH, ...FX });
    expect(summary.expenses, 'suma cruda de 10+10=20; debe convertir a preferredCurrency').toBe(EXPECTED_EXPENSES);
    expect(summary.income).toBe(EXPECTED_INCOME);
    expect(summary.net).toBe(EXPECTED_NET);
    expect(summary.expenses).not.toBe(RAW_EXPENSES);
  });
});

describe('P0-3 sin rate: no se suma en crudo y se marca lo no convertible', () => {
  const partialRates = { preferredCurrency: 'EUR', rates: {} }; // USD sin tipo
  const rows = [
    entry({ id: 'ok', amount: 10, currency: 'EUR', entry_date: '2026-06-11' }),
    entry({ id: 'fx', amount: 10, currency: 'USD', entry_date: '2026-06-10' }),
  ];

  it('el agregado excluye la fila sin rate y no la suma en crudo (10, no 20)', () => {
    const summary = expenseService.computeMonthlySummary(rows, { year: YEAR, month: MONTH, ...partialRates });
    expect(summary.expenses, 'sin rate no puede sumar 10 USD + 10 EUR en crudo').toBe(10);
    expect(summary.expenses).not.toBe(20);
    expect(marksNotConvertible(summary), 'debe marcar notConvertible o exponer excluded/excludedCount').toBe(true);
    expect(excludedCount(summary), 'el recuento de excluidas tiene que ser visible y mayor que 0').toBeGreaterThan(0);
    const list = excludedList(summary);
    if (list.length) {
      const ids = list.map((e) => e.id || e.entryId).filter(Boolean);
      if (ids.length) expect(ids).toContain('fx');
      else expect(list.some((e) => String(e.currency || '').toUpperCase() === 'USD')).toBe(true);
    }
  });
});

describe('P0-3 cada agregado usa la misma fórmula y los mismos totales', () => {
  const opts = { year: YEAR, month: MONTH, ...FX };
  const rangeOpts = { from: '2026-06-01', to: '2026-06-30', type: 'expense', ...FX };

  it('donut (computeCategoryBreakdownRange): total de gastos 19 EUR', () => {
    const donut = expenseService.computeCategoryBreakdownRange(MIXED, rangeOpts);
    expect(donut.total).toBe(EXPECTED_EXPENSES);
    const byCat = Object.fromEntries(donut.rows.map((r) => [r.category, r.value]));
    expect(byCat.groceries).toBe(9);
    expect(byCat.housing).toBe(10);
  });

  it('Sankey (computeMoneyFlow): expenses 19, income 20, net 1', () => {
    const flow = expenseService.computeMoneyFlow(MIXED, opts);
    expect(flow.expenses).toBe(EXPECTED_EXPENSES);
    expect(flow.income).toBe(EXPECTED_INCOME);
    expect(flow.net).toBe(EXPECTED_NET);
  });

  it('presupuestos (computeBudgetStatus): spent de comida+vivienda suma 19', () => {
    const statuses = expenseService.computeBudgetStatus(
      MIXED,
      { groceries: 100, housing: 100 },
      opts,
    );
    const spent = statuses.reduce((s, r) => s + r.spent, 0);
    expect(spent).toBe(EXPECTED_EXPENSES);
    expect(statuses.find((s) => s.category === 'groceries')?.spent).toBe(9);
    expect(statuses.find((s) => s.category === 'housing')?.spent).toBe(10);
  });

  it('proyección (projectAnnualSavings): realizedExpenses 19 (junio realizado)', () => {
    const proj = expenseService.projectAnnualSavings({
      entries: MIXED,
      templates: [],
      year: YEAR,
      today: '2026-06-30',
      initialBalance: 0,
      ...FX,
    });
    expect(proj.realizedExpenses).toBe(EXPECTED_EXPENSES);
    expect(proj.realizedIncome).toBe(EXPECTED_INCOME);
    expect(proj.realizedNet).toBe(EXPECTED_NET);
  });

  it('export CSV: mismas filas convertidas suman 19, con moneda e importe originales', () => {
    const csv = expenseService.expensesToCsv(MIXED, { year: YEAR, labels: CSV_LABELS, ...FX });
    expect(typeof csv).toBe('string');
    const lines = csv.split('\n').filter((l) => l.trim());
    const header = lines[0];
    expect(header, 'debe conservar importe y moneda originales').toMatch(/Importe original/i);
    expect(header).toMatch(/Moneda original/i);
    expect(header, 'debe añadir la columna de importe convertido').toMatch(/Importe convertido/i);
    const cols = header.split(';');
    const iAmount = cols.findIndex((c) => /Importe original/i.test(c));
    const iCur = cols.findIndex((c) => /Moneda original/i.test(c));
    const iConv = cols.findIndex((c) => /Importe convertido/i.test(c));
    expect(iAmount).toBeGreaterThanOrEqual(0);
    expect(iCur).toBeGreaterThanOrEqual(0);
    expect(iConv).toBeGreaterThanOrEqual(0);
    const dataLines = lines.slice(1).filter((l) => {
      const c0 = l.split(';')[0];
      return /^\d{4}-\d{2}-\d{2}$/.test(c0);
    });
    const converted = dataLines
      .filter((l) => l.split(';')[1] === 'Gasto' || l.split(';')[iCur] === 'USD' || /Comida|Vivienda/.test(l))
      .map((l) => l.split(';')[iConv])
      .filter((v) => v && !/no convertible/i.test(v))
      .map((v) => Number(String(v).replace(',', '.')));
    // Las dos filas de gasto (USD y EUR) deben aparecer con originales y convertidos
    const expenseLines = dataLines.filter((l) => l.includes('Gasto') || l.includes('Comida') || l.includes('Vivienda'));
    expect(expenseLines.length).toBeGreaterThanOrEqual(2);
    const hasUsdOriginal = dataLines.some((l) => {
      const c = l.split(';');
      return c[iCur] === 'USD' && /10/.test(c[iAmount]);
    });
    const hasEurOriginal = dataLines.some((l) => {
      const c = l.split(';');
      return c[iCur] === 'EUR' && /10/.test(c[iAmount]);
    });
    expect(hasUsdOriginal, 'CSV debe conservar 10 USD originales').toBe(true);
    expect(hasEurOriginal, 'CSV debe conservar 10 EUR originales').toBe(true);
    const expenseConverted = dataLines
      .filter((l) => l.includes('Gasto'))
      .map((l) => Math.abs(Number(String(l.split(';')[iConv]).replace(',', '.'))));
    const sum = expenseConverted.reduce((a, b) => a + b, 0);
    expect(sum, `convertidos de gasto deben sumar 19, no 20 (got ${expenseConverted})`).toBe(EXPECTED_EXPENSES);
  });

  it('los cinco agregados coinciden entre sí (misma fórmula)', () => {
    const donut = expenseService.computeCategoryBreakdownRange(MIXED, rangeOpts);
    const flow = expenseService.computeMoneyFlow(MIXED, opts);
    const spent = expenseService.computeBudgetStatus(MIXED, { groceries: 100, housing: 100 }, opts)
      .reduce((s, r) => s + r.spent, 0);
    const proj = expenseService.projectAnnualSavings({
      entries: MIXED, templates: [], year: YEAR, today: '2026-06-30', initialBalance: 0, ...FX,
    });
    const csv = expenseService.expensesToCsv(MIXED, { year: YEAR, labels: CSV_LABELS, ...FX });
    const header = csv.split('\n')[0].split(';');
    const iConv = header.findIndex((c) => /Importe convertido/i.test(c));
    const csvSum = csv.split('\n')
      .filter((l) => l.includes('Gasto'))
      .map((l) => Math.abs(Number(String(l.split(';')[iConv]).replace(',', '.'))))
      .reduce((a, b) => a + b, 0);
    expect([donut.total, flow.expenses, spent, proj.realizedExpenses, csvSum])
      .toEqual(Array(5).fill(EXPECTED_EXPENSES));
  });

  it('una sola fórmula en expenseService: los agregados no suman e.amount en crudo', () => {
    expect(typeof expenseService.convertExpenseAmount).toBe('function');
    const files = [
      'src/services/expenses/summaries.js',
      'src/services/expenses/goals.js',
      'src/services/expenses/entries.js',
    ].map((f) => ({ file: f, src: fs.readFileSync(path.join(ROOT, f), 'utf8') }));
    const raw = /plus\(\s*D\(\s*e\.amount\s*\)\)|plus\(\s*D\(\s*amount\s*\)\)/;
    const usesFormula = /convertExpenseAmount/;
    const offenders = files.filter(({ src, file }) => {
      if (file.endsWith('entries.js')) {
        // expensesToCsv vive aquí; computeDayGroups también suma amount — el
        // CSV es el agregado de este bloque.
        const csvStart = src.indexOf('export function expensesToCsv');
        const csv = csvStart >= 0 ? src.slice(csvStart, csvStart + 2500) : src;
        return raw.test(csv) && !usesFormula.test(csv);
      }
      if (file.endsWith('goals.js')) {
        const start = src.indexOf('export function computeMoneyFlow');
        const body = start >= 0 ? src.slice(start, start + 4500) : src;
        return raw.test(body) && !usesFormula.test(body);
      }
      // summaries: sumByType / breakdown / projection
      return raw.test(src) && !usesFormula.test(src);
    });
    expect(
      offenders.map((o) => o.file),
      'donut/Sankey/presupuestos/proyección/CSV deben usar convertExpenseAmount, no plus(D(e.amount))',
    ).toEqual([]);
  });

  it('los componentes de UI de Gastos no declaran fórmulas de suma cruda de amount', () => {
    // Acotado: solo la página y los widgets de gastos. No es un barrido del
    // repo. Se admite mostrar un importe unitario (formatMoney(row.amount),
    // el campo del formulario, una fila del import). Se prohíbe agregar
    // .amount de varias entradas (reduce/plus/+=).
    const dir = path.join(ROOT, 'src/components/expenses');
    const files = [
      path.join(ROOT, 'src/pages/ExpensesPage.jsx'),
      ...fs.readdirSync(dir).filter((f) => f.endsWith('.jsx')).map((f) => path.join(dir, f)),
    ];
    const forbidden = /reduce\s*\(\s*(?:\([^)]*\)|[A-Za-z_]\w*)\s*=>\s*[^;]{0,80}\.amount\b|\.plus\(\s*D\(\s*\w+\.amount|\w+\.amount\s*\+|acc\s*\+\s*\w+\.amount/;
    const hits = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        if (forbidden.test(line)) hits.push(`${path.relative(ROOT, file)}:${i + 1}`);
      });
    }
    expect(hits, 'suma cruda de amount en UI: ' + hits.join(', ')).toEqual([]);
  });
});

describe('P0-3 casos de borde', () => {
  it('misma divisa que la preferida: se incluye sin conversión y sin exigir rate', () => {
    const rows = [entry({ id: 'a', amount: 10, currency: 'EUR' }), entry({ id: 'b', amount: 5, currency: 'eur' })];
    const summary = expenseService.computeMonthlySummary(rows, {
      year: YEAR, month: MONTH, preferredCurrency: 'EUR', rates: {},
    });
    expect(summary.expenses).toBe(15);
    expect(excludedCount(summary)).toBe(0);
  });

  it('rate 0, negativo o NaN se tratan como no disponible', () => {
    expect(typeof expenseService.convertExpenseAmount).toBe('function');
    for (const rate of [0, -1, Number.NaN]) {
      const out = expenseService.convertExpenseAmount(10, 'USD', 'EUR', { USD: rate });
      const convertible = out && typeof out === 'object' ? out.convertible : out != null;
      const value = out && typeof out === 'object' ? out.value : out;
      expect(convertible, `rate=${rate} no es usable`).toBe(false);
      expect(value === null || value === undefined || Number.isNaN(value)).toBe(true);
    }
    const summary = expenseService.computeMonthlySummary(
      [entry({ id: 'z', amount: 10, currency: 'USD' })],
      { year: YEAR, month: MONTH, preferredCurrency: 'EUR', rates: { USD: 0 } },
    );
    expect(summary.expenses, 'rate 0 no puede colarse como 0 convertido silencioso mezclado con crudo; la fila se excluye').toBe(0);
    expect(marksNotConvertible(summary)).toBe(true);
  });

  it('entrada sin currency: se trata como preferredCurrency (criterio explícito, no se excluye)', () => {
    // Criterio: currency ausente, null o '' equivale a preferredCurrency. Igual
    // que detectForeignCurrencies no marca esas filas como extranjeras.
    const rows = [
      entry({ id: 'n1', amount: 7, currency: null, entry_date: '2026-06-10' }),
      entry({ id: 'n2', amount: 3, currency: '', entry_date: '2026-06-11' }),
    ];
    const summary = expenseService.computeMonthlySummary(rows, {
      year: YEAR, month: MONTH, preferredCurrency: 'EUR', rates: { USD: 0.9 },
    });
    expect(summary.expenses).toBe(10);
    expect(excludedCount(summary)).toBe(0);
  });

  it('redondeo a 2 decimales y totales consistentes entre vistas', () => {
    // 10 USD * 0.333 = 3.33; 10 GBP * 1.111 = 11.11; total 14.44 (no 14.43/14.45)
    const rows = [
      entry({ id: 'u', amount: 10, currency: 'USD', category: 'groceries' }),
      entry({ id: 'g', amount: 10, currency: 'GBP', category: 'housing' }),
    ];
    const fx = { preferredCurrency: 'EUR', rates: { USD: 0.333, GBP: 1.111 } };
    const expected = 14.44;
    const summary = expenseService.computeMonthlySummary(rows, { year: YEAR, month: MONTH, ...fx });
    const donut = expenseService.computeCategoryBreakdownRange(rows, {
      from: '2026-06-01', to: '2026-06-30', type: 'expense', ...fx,
    });
    const flow = expenseService.computeMoneyFlow(rows, { year: YEAR, month: MONTH, ...fx });
    expect(summary.expenses).toBe(expected);
    expect(donut.total).toBe(expected);
    expect(flow.expenses).toBe(expected);
  });

  it('modo privacidad: porcentajes sí, importes no', () => {
    expect(typeof expenseService.presentBreakdown, 'falta presentBreakdown en expenseService').toBe('function');
    const rows = [{ category: 'groceries', value: 9 }, { category: 'housing', value: 10 }];
    const hidden = expenseService.presentBreakdown(rows, { privacyMode: true });
    expect(hidden.amountsHidden, 'amountsHidden debe ser true en modo privacidad').toBe(true);
    expect(hidden.rows).toHaveLength(2);
    const pcts = hidden.rows.map((r) => r.pct);
    expect(pcts.reduce((a, b) => a + b, 0)).toBeGreaterThan(99);
    expect(hidden.rows.every((r) => r.value === undefined && r.amount === undefined)).toBe(true);
    const open = expenseService.presentBreakdown(rows, { privacyMode: false });
    expect(open.amountsHidden).toBe(false);
    expect(open.rows.some((r) => r.value === 9 || r.value === 10)).toBe(true);
  });

  it('cambiar preferredCurrency cambia los totales', () => {
    const asEur = expenseService.computeMonthlySummary(MIXED, {
      year: YEAR, month: MONTH, preferredCurrency: 'EUR', rates: { USD: 0.9 },
    });
    const asUsd = expenseService.computeMonthlySummary(MIXED, {
      year: YEAR, month: MONTH, preferredCurrency: 'USD', rates: { EUR: 1.2 },
    });
    // EUR: 9 + 10 = 19; USD: 10 + 12 = 22
    expect(asEur.expenses).toBe(19);
    expect(asUsd.expenses).toBe(22);
    expect(asEur.expenses).not.toBe(asUsd.expenses);
  });
});

describe('P0-3 CSV no convertible', () => {
  it('una fila sin rate se marca «no convertible» y conserva original', () => {
    const rows = [
      entry({ id: 'ok', amount: 10, currency: 'EUR', type: 'expense', category: 'housing' }),
      entry({ id: 'fx', amount: 10, currency: 'USD', type: 'expense', category: 'groceries' }),
    ];
    const csv = expenseService.expensesToCsv(rows, {
      year: YEAR,
      labels: CSV_LABELS,
      preferredCurrency: 'EUR',
      rates: {},
    });
    expect(csv).toMatch(/no convertible/i);
    expect(csv).toMatch(/USD/);
    const header = csv.split('\n')[0].split(';');
    const iConv = header.findIndex((c) => /Importe convertido/i.test(c));
    expect(iConv).toBeGreaterThanOrEqual(0);
    const fxLine = csv.split('\n').find((l) => l.includes('USD'));
    expect(fxLine, 'la fila USD debe aparecer').toBeTruthy();
    expect(fxLine.split(';')[iConv].toLowerCase()).toMatch(/no convertible/);
  });
});

describe('P0-3 sin provider nuevo', () => {
  it('los módulos de gastos no importan un proveedor FX distinto de currencyService', () => {
    const dir = path.join(ROOT, 'src/services/expenses');
    const files = [
      path.join(ROOT, 'src/services/expenseService.js'),
      ...fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')).map((f) => path.join(dir, f)),
    ];
    const banned = /openexchangerates|exchangerate-api|fixer\.io|currencyapi|exchangeratesapi|frankfurter|yahooFinance/i;
    const hits = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      if (banned.test(src)) hits.push(path.relative(ROOT, file));
    }
    expect(hits, 'no se acepta un provider FX nuevo; rates inyectados / currencyService').toEqual([]);
  });
});
