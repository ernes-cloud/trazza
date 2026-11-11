import { describe, it, expect } from 'vitest';
import {
  monthKeyOf,
  occurrenceDateFor,
  endOfMonthIso,
  isTemplate,
  computeMissingOccurrences,
  computeMonthlySummary,
  computeAnnualSummary,
  computeAnnualSeries,
  computeCategoryBreakdown,
  computeCategoryBreakdownRange,
  projectAnnualSavings,
  computeProjectedOccurrences,
  computeAnnualSeriesWithProjection,
  computeDailyTotals,
  computeGoalProgress,
  computeProjectSummary,
  computeGoalSpendingByGoal,
  computeAllocatedTotal,
  isGoalClosed,
  computeTotalSavedBalance,
  computeBudgetStatus,
  computeMonthlyInsights,
  computeBalanceSeries,
  expensesToCsv,
  parseAmountInput,
  localTodayIso,
  detectForeignCurrencies,
  computeDayGroups,
  computeMoneyFlow,
} from './expenseService';

const entry = (over = {}) => ({
  id: over.id || 'e1',
  type: 'expense',
  category: 'groceries',
  amount: 100,
  currency: 'EUR',
  entry_date: '2026-07-05',
  recurrence: 'none',
  recurring_source_id: null,
  source_month: null,
  ...over,
});

const template = (over = {}) => entry({
  id: 'tpl1',
  recurrence: 'monthly',
  recurrence_day: 1,
  recurrence_active: true,
  ...over,
});

describe('monthKeyOf', () => {
  it('extracts YYYY-MM from a date string', () => {
    expect(monthKeyOf('2026-07-05')).toBe('2026-07');
  });

  it('handles ISO timestamps with T separator', () => {
    expect(monthKeyOf('2026-07-05T10:30:00')).toBe('2026-07');
  });

  it('returns null for undefined, empty or malformed input', () => {
    expect(monthKeyOf(undefined)).toBeNull();
    expect(monthKeyOf('')).toBeNull();
    expect(monthKeyOf('05-07-2026')).toBeNull();
  });
});

describe('occurrenceDateFor', () => {
  it('builds a padded ISO date', () => {
    expect(occurrenceDateFor(2026, 3, 5)).toBe('2026-03-05');
  });

  it('clamps day 31 to the end of shorter months', () => {
    expect(occurrenceDateFor(2026, 2, 31)).toBe('2026-02-28');
    expect(occurrenceDateFor(2026, 4, 31)).toBe('2026-04-30');
  });

  it('clamps to 29 in leap-year February', () => {
    expect(occurrenceDateFor(2028, 2, 31)).toBe('2028-02-29');
  });
});

describe('endOfMonthIso', () => {
  it('returns the last day of the given date\'s month', () => {
    expect(endOfMonthIso(new Date(2026, 1, 10))).toBe('2026-02-28'); // Feb (non-leap)
    expect(endOfMonthIso(new Date(2028, 1, 10))).toBe('2028-02-29'); // Feb (leap)
    expect(endOfMonthIso(new Date(2026, 3, 5))).toBe('2026-04-30');  // Apr (30 days)
    expect(endOfMonthIso(new Date(2026, 6, 1))).toBe('2026-07-31');  // Jul (31 days)
  });
});

describe('isTemplate', () => {
  it('detects monthly templates and nothing else', () => {
    expect(isTemplate(template())).toBe(true);
    expect(isTemplate(entry())).toBe(false);
    expect(isTemplate(undefined)).toBe(false);
  });
});

describe('computeMissingOccurrences', () => {
  it('generates one occurrence per month from the template month through today', () => {
    const rows = computeMissingOccurrences({
      templates: [template({ entry_date: '2026-01-15', recurrence_day: 15 })],
      existingEntries: [],
      today: '2026-04-10',
    });
    expect(rows.map((r) => r.source_month)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
    expect(rows.map((r) => r.entry_date)).toEqual(['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15']);
    expect(rows.every((r) => r.recurrence === 'none' && r.recurring_source_id === 'tpl1')).toBe(true);
  });

  it('is idempotent: feeding the generated rows back yields []', () => {
    const args = {
      templates: [template({ entry_date: '2026-01-15' })],
      existingEntries: [],
      today: '2026-04-10',
    };
    const first = computeMissingOccurrences(args);
    const second = computeMissingOccurrences({ ...args, existingEntries: first });
    expect(second).toEqual([]);
  });

  it('only fills the gaps when some months already exist', () => {
    const rows = computeMissingOccurrences({
      templates: [template({ entry_date: '2026-01-15' })],
      existingEntries: [
        entry({ id: 'o1', recurring_source_id: 'tpl1', source_month: '2026-01' }),
        entry({ id: 'o3', recurring_source_id: 'tpl1', source_month: '2026-03' }),
      ],
      today: '2026-04-10',
    });
    expect(rows.map((r) => r.source_month)).toEqual(['2026-02', '2026-04']);
  });

  it('clamps recurrence_day 31 in February (leap year)', () => {
    const rows = computeMissingOccurrences({
      templates: [template({ entry_date: '2028-01-31', recurrence_day: 31 })],
      existingEntries: [],
      today: '2028-02-15',
    });
    expect(rows.map((r) => r.entry_date)).toEqual(['2028-01-31', '2028-02-29']);
  });

  it('falls back to the entry_date day when recurrence_day is missing', () => {
    const rows = computeMissingOccurrences({
      templates: [template({ entry_date: '2026-03-22', recurrence_day: null })],
      existingEntries: [],
      today: '2026-04-01',
    });
    expect(rows.map((r) => r.entry_date)).toEqual(['2026-03-22', '2026-04-22']);
  });

  it('skips inactive templates', () => {
    const rows = computeMissingOccurrences({
      templates: [template({ entry_date: '2026-01-15', recurrence_active: false })],
      existingEntries: [],
      today: '2026-04-10',
    });
    expect(rows).toEqual([]);
  });

  it('skips templates starting in a future month', () => {
    const rows = computeMissingOccurrences({
      templates: [template({ entry_date: '2026-09-01' })],
      existingEntries: [],
      today: '2026-07-19',
    });
    expect(rows).toEqual([]);
  });

  it('spans year boundaries', () => {
    const rows = computeMissingOccurrences({
      templates: [template({ entry_date: '2025-11-05', recurrence_day: 5 })],
      existingEntries: [],
      today: '2026-01-20',
    });
    expect(rows.map((r) => r.source_month)).toEqual(['2025-11', '2025-12', '2026-01']);
  });

  it('returns [] when today is missing or malformed', () => {
    expect(computeMissingOccurrences({ templates: [template()], existingEntries: [] })).toEqual([]);
  });

  it('stops at recurrence_until (no occurrence past the end date)', () => {
    const rows = computeMissingOccurrences({
      templates: [template({ entry_date: '2026-01-15', recurrence_day: 15, recurrence_until: '2026-03-31' })],
      existingEntries: [],
      today: '2026-07-19',
    });
    expect(rows.map((r) => r.source_month)).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('excludes the until month itself when the occurrence day falls after the limit', () => {
    const rows = computeMissingOccurrences({
      templates: [template({ entry_date: '2026-01-15', recurrence_day: 15, recurrence_until: '2026-03-10' })],
      existingEntries: [],
      today: '2026-07-19',
    });
    expect(rows.map((r) => r.source_month)).toEqual(['2026-01', '2026-02']);
  });
});

describe('projectAnnualSavings', () => {
  const salaryTpl = template({ id: 'tpl-salary', type: 'income', category: 'salary', amount: 2000, entry_date: '2026-01-01', recurrence_day: 1 });
  const rentTpl = template({ id: 'tpl-rent', type: 'expense', category: 'housing', amount: 800, entry_date: '2026-01-01', recurrence_day: 1 });

  it('projects current year: realized + future recurring + non-recurring average (≥3 months)', () => {
    // Three elapsed months (today = Mar): occurrences materialized + one-off expenses
    const entries = [
      entry({ id: 'o1', type: 'income', amount: 2000, entry_date: '2026-01-01', recurring_source_id: 'tpl-salary', source_month: '2026-01' }),
      entry({ id: 'o2', type: 'income', amount: 2000, entry_date: '2026-02-01', recurring_source_id: 'tpl-salary', source_month: '2026-02' }),
      entry({ id: 'o3', type: 'income', amount: 2000, entry_date: '2026-03-01', recurring_source_id: 'tpl-salary', source_month: '2026-03' }),
      entry({ id: 'g1', amount: 300, entry_date: '2026-01-10' }),
      entry({ id: 'g2', amount: 500, entry_date: '2026-02-10' }),
      entry({ id: 'g3', amount: 100, entry_date: '2026-03-10' }),
    ];
    const p = projectAnnualSavings({ entries, templates: [salaryTpl], year: 2026, today: '2026-03-20' });
    // realized = 6000 - 900 = 5100; future recurring = 2000 × 9; avg non-recurring = -900/3 = -300 × 9
    expect(p.actualNet).toBe(5100);
    expect(p.realizedIncome).toBe(6000);
    expect(p.realizedExpenses).toBe(900);
    expect(p.projectedNet).toBe(5100 + 18000 - 2700);
    expect(p.monthsElapsed).toBe(3);
    expect(p.monthsRemaining).toBe(9);
    expect(p.isCurrentYear).toBe(true);
  });

  it('with fewer than 3 months of history the average is NOT extrapolated', () => {
    const entries = [
      entry({ id: 'g1', amount: 100, entry_date: '2026-06-10' }),
      entry({ id: 'g2', amount: 300, entry_date: '2026-07-10' }),
    ];
    const p = projectAnnualSavings({ entries, templates: [], year: 2026, today: '2026-07-19' });
    expect(p.monthsElapsed).toBe(2);
    expect(p.avgNonRecurringPerMonth).toBe(0);
    expect(p.nonRecurringEstimate).toBe(0);
    expect(p.projectedNet).toBe(-400);
  });

  it('future-dated entries count verbatim as futureKnownNet, never in realized nor in the average', () => {
    // The user's real bug: planned expenses dated Aug-Dec were inflating "Real"
    // AND being extrapolated as monthly habit
    const entries = [
      entry({ id: 'j1', type: 'income', amount: 830, entry_date: '2026-07-01' }),
      entry({ id: 'j2', amount: 100, entry_date: '2026-07-15' }),
      entry({ id: 'f1', amount: 4899, entry_date: '2026-09-20' }),
    ];
    const p = projectAnnualSavings({ entries, templates: [], year: 2026, today: '2026-07-19' });
    expect(p.actualNet).toBe(730);
    expect(p.realizedExpenses).toBe(100);
    expect(p.futureKnownNet).toBe(-4899);
    expect(p.nonRecurringEstimate).toBe(0); // only 1 month of history
    expect(p.projectedNet).toBe(730 - 4899);
  });

  it('respects recurrence_until in the future recurring part', () => {
    const rentUntilJune = { ...rentTpl, recurrence_until: '2026-06-30' };
    const p = projectAnnualSavings({ entries: [], templates: [salaryTpl, rentUntilJune], year: 2026, today: '2026-02-20' });
    // future months Mar..Dec: salary 2000×10; rent only Mar..Jun = -800×4
    expect(p.projectedNet).toBe(20000 - 3200);
  });

  it('ignores inactive templates in the projection', () => {
    const p = projectAnnualSavings({
      entries: [],
      templates: [{ ...salaryTpl, recurrence_active: false }],
      year: 2026,
      today: '2026-02-20',
    });
    expect(p.projectedNet).toBe(0);
  });

  it('past year: projection equals the actual net', () => {
    const entries = [entry({ id: 'a', type: 'income', amount: 1000, entry_date: '2025-06-01' })];
    const p = projectAnnualSavings({ entries, templates: [salaryTpl], year: 2025, today: '2026-02-20' });
    expect(p.projectedNet).toBe(1000);
    expect(p.isPastYear).toBe(true);
    expect(p.monthsRemaining).toBe(0);
  });

  it('future year: recurring net of its 12 months only', () => {
    const p = projectAnnualSavings({ entries: [], templates: [salaryTpl, rentTpl], year: 2027, today: '2026-02-20' });
    expect(p.projectedNet).toBe((2000 - 800) * 12);
    expect(p.monthsElapsed).toBe(0);
  });

  it('averages non-recurring over months since the FIRST entry, not since January', () => {
    // Tracking started in May; today is July → 3 months of data, not 7
    const entries = [
      entry({ id: 'g1', amount: 100, entry_date: '2026-05-10' }),
      entry({ id: 'g2', amount: 300, entry_date: '2026-06-10' }),
      entry({ id: 'g3', amount: 200, entry_date: '2026-07-10' }),
    ];
    const p = projectAnnualSavings({ entries, templates: [], year: 2026, today: '2026-07-19' });
    expect(p.monthsElapsed).toBe(3);
    expect(p.avgNonRecurringPerMonth).toBe(-200);
    expect(p.projectedNet).toBe(-600 + -200 * 5);
  });

  it('no entries this year → no non-recurring estimate (avg 0)', () => {
    const p = projectAnnualSavings({ entries: [], templates: [salaryTpl], year: 2026, today: '2026-07-19' });
    expect(p.monthsElapsed).toBe(0);
    expect(p.nonRecurringEstimate).toBe(0);
    expect(p.projectedNet).toBe(2000 * 5);
  });

  it('counts the starting bank balance in achieved and projection, never in the average', () => {
    const entries = [
      entry({ id: 'g1', amount: 100, entry_date: '2026-05-10' }),
      entry({ id: 'g2', amount: 100, entry_date: '2026-06-10' }),
      entry({ id: 'g3', amount: 100, entry_date: '2026-07-10' }),
    ];
    const p = projectAnnualSavings({ entries, templates: [], year: 2026, today: '2026-07-19', initialBalance: 3000 });
    expect(p.actualNet).toBe(3000 - 300);
    expect(p.startingBalance).toBe(3000);
    expect(p.realizedNet).toBe(-300);
    // avg from year flows only: -300/3 = -100 × 5 → starting balance not extrapolated
    expect(p.avgNonRecurringPerMonth).toBe(-100);
    expect(p.projectedNet).toBe(3000 - 300 - 500);
  });

  it('exposes a breakdown that sums exactly to projectedNet', () => {
    const entries = [
      entry({ id: 'o1', type: 'income', amount: 2000, entry_date: '2026-01-01', recurring_source_id: 'tpl-salary', source_month: '2026-01' }),
      entry({ id: 'g1', amount: 300, entry_date: '2026-02-10' }),
      entry({ id: 'f1', amount: 450, entry_date: '2026-10-05' }),
    ];
    const p = projectAnnualSavings({ entries, templates: [salaryTpl, rentTpl], year: 2026, today: '2026-02-20' });
    expect(p.actualNet + p.futureKnownNet + p.futureRecurringNet + p.nonRecurringEstimate).toBeCloseTo(p.projectedNet, 10);
  });
});

describe('computeProjectedOccurrences', () => {
  const salaryTpl = template({ id: 'tpl-salary', type: 'income', category: 'salary', amount: 1400, entry_date: '2026-01-01', recurrence_day: 1 });
  const rentTpl = template({ id: 'tpl-rent', type: 'expense', category: 'housing', amount: 800, entry_date: '2026-01-01', recurrence_day: 31 });

  it('builds display-only pseudo-entries for a future month', () => {
    const rows = computeProjectedOccurrences({ templates: [salaryTpl, rentTpl], existingEntries: [], year: 2026, month: 9 });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 'projected-tpl-salary-2026-09',
      type: 'income',
      amount: 1400,
      entry_date: '2026-09-01',
      projected: true,
      recurring_source_id: 'tpl-salary',
    });
    expect(rows[1].entry_date).toBe('2026-09-30');
  });

  it('skips occurrences already materialized (current month)', () => {
    const rows = computeProjectedOccurrences({
      templates: [salaryTpl],
      existingEntries: [entry({ id: 'o', recurring_source_id: 'tpl-salary', source_month: '2026-07' })],
      year: 2026,
      month: 7,
    });
    expect(rows).toEqual([]);
  });

  it('respects recurrence_until, inactivity and future start', () => {
    const limited = { ...rentTpl, recurrence_until: '2026-08-31' };
    const inactive = { ...salaryTpl, id: 'tpl-off', recurrence_active: false };
    const notStarted = template({ id: 'tpl-late', type: 'income', amount: 99, entry_date: '2026-11-01' });
    const rows = computeProjectedOccurrences({ templates: [limited, inactive, notStarted], existingEntries: [], year: 2026, month: 9 });
    expect(rows).toEqual([]);
  });
});

describe('computeAnnualSeriesWithProjection', () => {
  const salaryTpl = template({ id: 'tpl-salary', type: 'income', category: 'salary', amount: 2000, entry_date: '2026-01-01', recurrence_day: 1 });
  const rentTpl = template({ id: 'tpl-rent', type: 'expense', category: 'housing', amount: 500, entry_date: '2026-01-01', recurrence_day: 1 });

  it('projects only months after the current one, real months untouched', () => {
    const entries = [
      entry({ id: 'i', type: 'income', amount: 2000, entry_date: '2026-07-01', recurring_source_id: 'tpl-salary', source_month: '2026-07' }),
    ];
    const series = computeAnnualSeriesWithProjection({ entries, templates: [salaryTpl, rentTpl], year: 2026, today: '2026-07-19' });
    expect(series).toHaveLength(12);
    expect(series[6]).toMatchObject({ month: 7, income: 2000, projected: false, projectedNet: 0 });
    expect(series[7]).toMatchObject({ month: 8, income: 0, projected: true, projectedIncome: 2000, projectedExpenses: 500, projectedNet: 1500 });
    expect(series[11].projectedNet).toBe(1500);
  });

  it('past year: no projection at all', () => {
    const series = computeAnnualSeriesWithProjection({ entries: [], templates: [salaryTpl], year: 2025, today: '2026-07-19' });
    expect(series.every((b) => !b.projected && b.projectedNet === 0)).toBe(true);
  });

  it('future year: all 12 months projected', () => {
    const series = computeAnnualSeriesWithProjection({ entries: [], templates: [salaryTpl], year: 2027, today: '2026-07-19' });
    expect(series.every((b) => b.projected && b.projectedIncome === 2000)).toBe(true);
  });

  it('respects recurrence_until in projected months', () => {
    const limited = { ...rentTpl, recurrence_until: '2026-09-30' };
    const series = computeAnnualSeriesWithProjection({ entries: [], templates: [limited], year: 2026, today: '2026-07-19' });
    expect(series[8]).toMatchObject({ month: 9, projectedExpenses: 500 });
    expect(series[9]).toMatchObject({ month: 10, projectedExpenses: 0, projected: false });
  });
});

describe('computeGoalProgress (allocation model)', () => {
  const goal = (over = {}) => ({ name: 'Moto', target_amount: 5000, target_date: '2026-12-15', allocated_amount: 0, ...over });

  it('progress is allocated / target, with the pace still to assign', () => {
    const p = computeGoalProgress({ goal: goal({ allocated_amount: 800 }), today: '2026-07-19' });
    expect(p.allocated).toBe(800);
    expect(p.saved).toBe(800);
    expect(p.remaining).toBe(4200);
    expect(p.pct).toBe(16);
    // Jul..Dec: el mes EN CURSO cuenta — todavía puedes apartar en julio.
    // (Antes eran 5, Aug..Dec, y el ritmo salía un 20% más alto.)
    expect(p.monthsLeft).toBe(6);
    expect(p.neededPerMonth).toBe(700);
    expect(p.reached).toBe(false);
  });

  it('marks reached when allocated ≥ target and drops the pace', () => {
    const p = computeGoalProgress({ goal: goal({ allocated_amount: 5000 }), today: '2026-07-19' });
    expect(p.reached).toBe(true);
    expect(p.pct).toBe(100);
    expect(p.remaining).toBe(0);
    expect(p.neededPerMonth).toBeNull();
  });

  it('caps pct at 100 even if over-allocated', () => {
    const p = computeGoalProgress({ goal: goal({ allocated_amount: 6000 }), today: '2026-07-19' });
    expect(p.pct).toBe(100);
    expect(p.reached).toBe(true);
  });

  it('past deadline: no months left, no pace', () => {
    const p = computeGoalProgress({ goal: goal({ allocated_amount: 1000 }), today: '2027-02-10' });
    expect(p.monthsLeft).toBe(0);
    expect(p.neededPerMonth).toBeNull();
    expect(p.remaining).toBe(4000);
  });

  it('defaults allocated to 0 when unset', () => {
    const p = computeGoalProgress({ goal: goal(), today: '2026-07-19' });
    expect(p.allocated).toBe(0);
    expect(p.pct).toBe(0);
    expect(p.isOpen).toBe(false);
  });

  // Sobres libres: "gasolina", "restaurante" — dinero apartado sin objetivo.
  describe('sobre libre (sin importe objetivo)', () => {
    const envelope = (over = {}) => ({ name: 'Gasolina', target_amount: null, target_date: null, allocated_amount: 240, ...over });

    it('se marca como abierto y conserva el saldo asignado', () => {
      const p = computeGoalProgress({ goal: envelope(), today: '2026-07-19' });
      expect(p.isOpen).toBe(true);
      expect(p.hasTarget).toBe(false);
      expect(p.allocated).toBe(240);
      expect(p.saved).toBe(240);
    });

    it('no inventa porcentaje, objetivo ni restante', () => {
      const p = computeGoalProgress({ goal: envelope(), today: '2026-07-19' });
      // null, NO 0: un 0% pintaría una barra vacía en algo que va perfecto
      expect(p.pct).toBeNull();
      expect(p.target).toBeNull();
      expect(p.remaining).toBe(0);
      expect(p.reached).toBe(false);
    });

    it('no calcula ritmo mensual aunque tenga fecha', () => {
      // Con fecha pero sin objetivo, "0 €/mes" se leería como "ya no hace falta"
      const p = computeGoalProgress({ goal: envelope({ target_date: '2026-12-15' }), today: '2026-07-19' });
      expect(p.hasDeadline).toBe(true);
      expect(p.monthsLeft).toBe(6); // Jul..Dec, incluido el mes en curso
      expect(p.neededPerMonth).toBeNull();
    });

    it('un objetivo sin fecha sigue siendo una meta con barra de progreso', () => {
      const p = computeGoalProgress({ goal: envelope({ target_amount: 1500, target_date: null, allocated_amount: 900 }), today: '2026-07-19' });
      expect(p.isOpen).toBe(false);
      expect(p.hasDeadline).toBe(false);
      expect(p.pct).toBe(60);
      expect(p.remaining).toBe(600);
      expect(p.neededPerMonth).toBeNull(); // sin fecha no hay meses entre los que repartir
    });

    it('target_amount 0 o negativo cuenta como sobre libre, no como meta cumplida', () => {
      expect(computeGoalProgress({ goal: envelope({ target_amount: 0 }), today: '2026-07-19' }).isOpen).toBe(true);
      expect(computeGoalProgress({ goal: envelope({ target_amount: -50 }), today: '2026-07-19' }).reached).toBe(false);
    });
  });
});

describe('computeProjectSummary', () => {
  const P = 'proj-1';
  const rows = [
    { id: 1, type: 'expense', category: 'housing',     amount: 520, entry_date: '2026-08-12', project_id: P },
    { id: 2, type: 'expense', category: 'restaurants', amount: 310, entry_date: '2026-08-14', project_id: P },
    { id: 3, type: 'expense', category: 'transport',   amount: 180, entry_date: '2026-08-13', project_id: P },
    { id: 4, type: 'expense', category: 'restaurants', amount: 40,  entry_date: '2026-08-18', project_id: P },
    // Ruido que NO debe entrar: otro proyecto, sin proyecto, y una plantilla
    { id: 5, type: 'expense', category: 'housing',     amount: 999, entry_date: '2026-08-15', project_id: 'otro' },
    { id: 6, type: 'expense', category: 'housing',     amount: 888, entry_date: '2026-08-15' },
    { id: 7, type: 'expense', category: 'housing',     amount: 777, entry_date: '2026-08-15', project_id: P, recurrence: 'monthly' },
  ];

  it('agrupa por categoría solo los movimientos del proyecto', () => {
    const s = computeProjectSummary(rows, { projectId: P });
    expect(s.count).toBe(4);
    expect(s.total).toBe(1050); // 520 + 310 + 180 + 40
    expect(s.rows.map((r) => r.category)).toEqual(['housing', 'restaurants', 'transport']);
    expect(s.rows[1].value).toBe(350); // las dos de restaurantes sumadas
  });

  it('ordena de mayor a menor y reparte porcentajes que suman 100', () => {
    const s = computeProjectSummary(rows, { projectId: P });
    expect(s.rows[0].pct).toBeCloseTo((520 / 1050) * 100, 6);
    expect(s.rows.reduce((a, r) => a + r.pct, 0)).toBeCloseTo(100, 6);
  });

  it('reporta el primer y el último día del proyecto', () => {
    const s = computeProjectSummary(rows, { projectId: P });
    expect(s.firstDate).toBe('2026-08-12');
    expect(s.lastDate).toBe('2026-08-18');
  });

  it('un ingreso etiquetado resta del total pero no ensucia el desglose', () => {
    const conDevolucion = [...rows, { id: 8, type: 'income', category: 'other', amount: 50, entry_date: '2026-08-20', project_id: P }];
    const s = computeProjectSummary(conDevolucion, { projectId: P });
    expect(s.spent).toBe(1050);
    expect(s.refunded).toBe(50);
    expect(s.total).toBe(1000);          // coste neto
    expect(s.rows).toHaveLength(3);       // sigue sin categoría 'other'
    expect(s.rows.reduce((a, r) => a + r.pct, 0)).toBeCloseTo(100, 6); // % sobre el bruto
  });

  it('compara con el sobre enlazado cuando lo hay', () => {
    const s = computeProjectSummary(rows, { projectId: P, goal: { allocated_amount: 1500 } });
    expect(s.allocated).toBe(1500);
    expect(s.pct).toBeCloseTo(70, 6);
    expect(s.overGoal).toBe(false);
  });

  it('marca cuando el gasto supera lo apartado', () => {
    const s = computeProjectSummary(rows, { projectId: P, goal: { allocated_amount: 900 } });
    expect(s.overGoal).toBe(true);
    expect(s.pct).toBeGreaterThan(100);
  });

  it('sin sobre no inventa porcentaje', () => {
    const s = computeProjectSummary(rows, { projectId: P });
    expect(s.allocated).toBeNull();
    expect(s.pct).toBeNull();   // null, NO 0
    expect(s.overGoal).toBe(false);
  });

  it('sobre a 0 tampoco genera porcentaje (evita dividir por cero)', () => {
    const s = computeProjectSummary(rows, { projectId: P, goal: { allocated_amount: 0 } });
    expect(s.pct).toBeNull();
    expect(s.overGoal).toBe(false);
  });

  it('proyecto sin movimientos: todo a cero, sin fechas', () => {
    const s = computeProjectSummary(rows, { projectId: 'vacio' });
    expect(s).toMatchObject({ total: 0, spent: 0, count: 0, firstDate: null, lastDate: null });
    expect(s.rows).toEqual([]);
  });

  it('sin projectId no agrega nada (no confunde con "los que no tienen proyecto")', () => {
    expect(computeProjectSummary(rows, {}).count).toBe(0);
  });
});

describe('el gasto de un proyecto consume su sobre (no el ahorro libre)', () => {
  // Escenario real: apartas 700 € para el viaje, el viaje cuesta 691 €.
  // Antes, ese dinero se descontaba DOS veces: bajaba del ahorro acumulado por
  // ser un gasto Y el sobre seguía reservando los 700 € íntegros.
  const goal = { id: 'g1', name: 'Viaje Pirineos', target_amount: null, allocated_amount: 700 };
  const project = { id: 'p1', name: 'Viaje Pirineos', goal_id: 'g1' };
  const entries = [
    { id: 1, type: 'expense', category: 'travel',      amount: 380, entry_date: '2026-07-12', project_id: 'p1' },
    { id: 2, type: 'expense', category: 'restaurants', amount: 145, entry_date: '2026-07-13', project_id: 'p1' },
    { id: 3, type: 'expense', category: 'transport',   amount: 226, entry_date: '2026-07-14', project_id: 'p1' },
    { id: 4, type: 'income',  category: 'gift',        amount: 60,  entry_date: '2026-07-16', project_id: 'p1' },
    { id: 5, type: 'expense', category: 'groceries',   amount: 500, entry_date: '2026-07-20' }, // sin proyecto
  ];

  it('mapea el gasto neto de cada proyecto a su sobre', () => {
    expect(computeGoalSpendingByGoal([project], entries)).toEqual({ g1: 691 }); // 751 − 60
  });

  it('ignora los proyectos sin sobre enlazado', () => {
    expect(computeGoalSpendingByGoal([{ id: 'p2', goal_id: null }], entries)).toEqual({});
  });

  it('suma varios proyectos que apuntan al mismo sobre', () => {
    const dos = [project, { id: 'p9', goal_id: 'g1' }];
    const conOtro = [...entries, { id: 6, type: 'expense', category: 'leisure', amount: 9, entry_date: '2026-07-22', project_id: 'p9' }];
    expect(computeGoalSpendingByGoal(dos, conOtro)).toEqual({ g1: 700 });
  });

  it('el saldo reservado baja por lo ya gastado: es lo que libera el ahorro', () => {
    const spending = computeGoalSpendingByGoal([project], entries);
    expect(computeAllocatedTotal([goal])).toBe(700);            // sin proyectos, como antes
    expect(computeAllocatedTotal([goal], spending)).toBe(9);    // 700 − 691 ya gastados
  });

  it('el disponible para asignar deja de penalizar dos veces el mismo gasto', () => {
    const ahorro = 16756;
    const spending = computeGoalSpendingByGoal([project], entries);
    const antes = ahorro - computeAllocatedTotal([goal]);
    const ahora = ahorro - computeAllocatedTotal([goal], spending);
    expect(ahora - antes).toBe(691); // exactamente el viaje ya pagado
  });

  it('pasarse del sobre no genera reserva negativa (el exceso ya bajó del ahorro)', () => {
    const caro = { ...goal, allocated_amount: 500 };
    const spending = computeGoalSpendingByGoal([project], entries); // 691 > 500
    expect(computeAllocatedTotal([caro], spending)).toBe(0);
  });

  it('computeGoalProgress trata el sobre como saldo: apartado − gastado', () => {
    const p = computeGoalProgress({ goal, today: '2026-08-01', spent: 691 });
    expect(p.assigned).toBe(700);
    expect(p.spent).toBe(691);
    expect(p.allocated).toBe(9);   // saldo que queda
  });

  it('una meta a medias SÍ retrocede si se gasta de su sobre', () => {
    const meta = { id: 'g2', target_amount: 1000, target_date: '2026-12-15', allocated_amount: 800 };
    const sinGastar = computeGoalProgress({ goal: meta, today: '2026-07-19' });
    const gastando = computeGoalProgress({ goal: meta, today: '2026-07-19', spent: 300 });
    expect(sinGastar.pct).toBe(80);
    expect(gastando.pct).toBe(50);        // 800 − 300 = 500 de 1000
    expect(gastando.remaining).toBe(500);
    expect(gastando.reached).toBe(false);
  });

  it('gastar más que el saldo lo deja a cero, nunca en negativo', () => {
    const p = computeGoalProgress({ goal, today: '2026-08-01', spent: 5000 });
    expect(p.allocated).toBe(0);
  });

  it('sin gasto se comporta exactamente como antes', () => {
    const p = computeGoalProgress({ goal, today: '2026-08-01' });
    expect(p.allocated).toBe(700);
    expect(p.spent).toBe(0);
  });

  // Una meta cumplida es un LOGRO: gastarse después el dinero para el que
  // ahorrabas es el final feliz, no un retroceso.
  describe('una meta CONSEGUIDA queda congelada', () => {
    const cumplida = { id: 'g3', name: 'Viaje a Japón', target_amount: 5000, target_date: '2026-12-15', allocated_amount: 5000 };

    it('sigue al 100% y conseguida por mucho que se gaste del proyecto', () => {
      const p = computeGoalProgress({ goal: cumplida, today: '2026-07-19', spent: 3000 });
      expect(p.reached).toBe(true);
      expect(p.pct).toBe(100);
      expect(p.remaining).toBe(0);
      expect(p.allocated).toBe(5000);   // congelado en lo asignado
    });

    it('gastarla ENTERA tampoco la descompleta', () => {
      const p = computeGoalProgress({ goal: cumplida, today: '2026-07-19', spent: 5000 });
      expect(p.reached).toBe(true);
      expect(p.pct).toBe(100);
      expect(p.allocated).toBe(5000);
    });

    it('el saldo real sigue disponible aparte, para la contabilidad', () => {
      const p = computeGoalProgress({ goal: cumplida, today: '2026-07-19', spent: 3000 });
      expect(p.balance).toBe(2000);   // 5000 − 3000: lo que queda de verdad
      expect(p.assigned).toBe(5000);
      expect(p.spent).toBe(3000);
    });

    it('el dinero gastado se libera igual del pool de reserva', () => {
      // Congelar la META no puede volver a congelar el DINERO: si no, el gasto
      // del viaje volvería a penalizar dos veces el disponible.
      const spending = { g3: 3000 };
      expect(computeAllocatedTotal([cumplida], spending)).toBe(2000);
    });

    it('nunca marca conseguida una meta sin objetivo (un sobre libre)', () => {
      const p = computeGoalProgress({ goal, today: '2026-08-01', spent: 691 });
      expect(p.reached).toBe(false);
      expect(p.isOpen).toBe(true);
    });

    it('si el usuario reasigna a mano por debajo del objetivo, deja de estar cumplida', () => {
      const bajada = { ...cumplida, allocated_amount: 200 };
      expect(computeGoalProgress({ goal: bajada, today: '2026-07-19' }).reached).toBe(false);
    });
  });
});

// El usuario cierra una meta (o la fecha la cierra por él): el dinero apartado
// deja de estar reservado y vuelve a "Disponible para asignar". Sin esto, la
// única forma de recuperarlo era BORRAR la meta y perder el registro.
describe('cierre de una meta: vencida y completada', () => {
  const meta = (over = {}) => ({
    id: 'g9', name: 'Curso de fotografía',
    target_amount: 900, allocated_amount: 340,
    target_date: '2026-06-10', ...over,
  });

  describe('isGoalClosed', () => {
    it('una meta con la fecha pasada y sin alcanzar está cerrada', () => {
      expect(isGoalClosed(meta(), '2026-08-22')).toBe(true);
    });

    it('el mismo día del vencimiento AÚN cuenta (se cierra al día siguiente)', () => {
      expect(isGoalClosed(meta(), '2026-06-10')).toBe(false);
      expect(isGoalClosed(meta(), '2026-06-11')).toBe(true);
    });

    it('una meta CONSEGUIDA no vence: el dinero sigue esperando a gastarse', () => {
      expect(isGoalClosed(meta({ allocated_amount: 900 }), '2026-08-22')).toBe(false);
    });

    it('un sobre libre (sin fecha) nunca vence', () => {
      expect(isGoalClosed({ allocated_amount: 500 }, '2026-08-22')).toBe(false);
    });

    it('completed_at cierra la meta pase lo que pase con las fechas', () => {
      const abierta = meta({ target_date: '2027-12-01', allocated_amount: 900 });
      expect(isGoalClosed(abierta, '2026-08-22')).toBe(false);
      expect(isGoalClosed({ ...abierta, completed_at: '2026-08-22T10:00:00Z' }, '2026-08-22')).toBe(true);
    });

    it('sin fecha de hoy no se evalúa el vencimiento, pero sí lo completado', () => {
      expect(isGoalClosed(meta(), null)).toBe(false);
      expect(isGoalClosed(meta({ completed_at: '2026-08-22T10:00:00Z' }), null)).toBe(true);
    });
  });

  describe('el dinero vuelve al ahorro disponible', () => {
    it('una meta vencida sin alcanzar deja de retener', () => {
      // Arrange: 340 € apartados en una meta cuya fecha ya pasó
      const goals = [meta()];
      // Act / Assert
      expect(computeAllocatedTotal(goals, {}, { today: '2026-05-01' })).toBe(340); // aún viva
      expect(computeAllocatedTotal(goals, {}, { today: '2026-08-22' })).toBe(0);   // vencida
    });

    it('una meta completada deja de retener aunque la fecha sea futura', () => {
      const cerrada = meta({ target_date: '2027-01-01', completed_at: '2026-08-22T10:00:00Z' });
      expect(computeAllocatedTotal([cerrada], {}, { today: '2026-08-22' })).toBe(0);
    });

    it('sin today no se liquida por vencimiento (compatibilidad)', () => {
      expect(computeAllocatedTotal([meta()], {})).toBe(340);
    });

    it('libera solo el SALDO: lo ya gastado no vuelve dos veces', () => {
      // 340 apartados, 100 gastados por el proyecto enlazado → solo quedan 240
      // retenidos, y al vencer se liberan esos 240 (los 100 ya bajaron del ahorro).
      const p = computeGoalProgress({ goal: meta(), today: '2026-08-22', spent: 100 });
      expect(p.released).toBe(240);
      expect(computeAllocatedTotal([meta()], { g9: 100 }, { today: '2026-08-22' })).toBe(0);
    });
  });

  describe('computeGoalProgress publica el estado', () => {
    it('vencida: expired y closed, sin completar', () => {
      const p = computeGoalProgress({ goal: meta(), today: '2026-08-22' });
      expect(p.expired).toBe(true);
      expect(p.closed).toBe(true);
      expect(p.completed).toBe(false);
      expect(p.released).toBe(340);
    });

    it('completada: completed y closed, pero NO vencida', () => {
      const p = computeGoalProgress({ goal: meta({ completed_at: '2026-08-22T10:00:00Z' }), today: '2026-08-22' });
      expect(p.completed).toBe(true);
      expect(p.closed).toBe(true);
      expect(p.expired).toBe(false);
    });

    it('reabrir (completed_at a null) devuelve la meta a la vida', () => {
      const p = computeGoalProgress({ goal: meta({ target_date: '2027-01-01', completed_at: null }), today: '2026-08-22' });
      expect(p.closed).toBe(false);
      expect(p.released).toBe(0);
    });

    it('una meta cerrada no pide ritmo mensual', () => {
      const cerrada = meta({ target_date: '2027-01-01', completed_at: '2026-08-22T10:00:00Z' });
      expect(computeGoalProgress({ goal: cerrada, today: '2026-08-22' }).neededPerMonth).toBeNull();
      // la misma meta abierta sí lo calcula
      expect(computeGoalProgress({ goal: meta({ target_date: '2027-01-01' }), today: '2026-08-22' }).neededPerMonth).toBeGreaterThan(0);
    });
  });

  describe('pasarse del sobre se cuenta, no se traga', () => {
    it('publica el exceso sin ensuciar el saldo', () => {
      // Arrange: 340 apartados, 500 gastados del proyecto enlazado
      const p = computeGoalProgress({ goal: meta(), today: '2026-05-01', spent: 500 });
      // Assert
      expect(p.overspent).toBe(160);   // 500 − 340
      expect(p.balance).toBe(0);       // el sobre está vacío, no en negativo
      expect(p.spent).toBe(500);
    });

    it('sin pasarse, el exceso es 0', () => {
      expect(computeGoalProgress({ goal: meta(), today: '2026-05-01', spent: 100 }).overspent).toBe(0);
    });

    it('el exceso NO se resta otra vez del pool (ya bajó del ahorro por su gasto)', () => {
      expect(computeAllocatedTotal([meta()], { g9: 500 }, { today: '2026-05-01' })).toBe(0);
    });
  });
});

// Regresión de dos bugs REALES reportados por el owner (2026-09-01): "ingresos
// recurrentes que quité" seguían contando, y las metas "asignaban mal".
describe('borrar un recurrente no deja fantasmas', () => {
  const TODAY = '2026-09-01';
  const tpl = (id, start) => ({
    id, type: 'income', category: 'salary', amount: 1800, entry_date: start,
    recurrence: 'monthly', recurrence_day: 1, recurrence_active: true,
  });
  const occ = (id, sourceId, month) => ({
    id, type: 'income', category: 'salary', amount: 1800,
    entry_date: `${month}-01`, recurrence: 'none',
    recurring_source_id: sourceId, source_month: month,
  });
  const MESES = ['2026-06', '2026-07', '2026-08', '2026-09'];

  it('recrear una plantilla NO duplica las ocurrencias huérfanas', () => {
    // Arrange: la plantilla se borró (FK ON DELETE SET NULL → enlace a null)
    const huerfanas = MESES.map((m, i) => ({ ...occ(`o${i}`, null, m), source_month: m }));
    const nueva = tpl('T2', '2026-06-01');
    // Act
    const missing = computeMissingOccurrences({
      templates: [nueva], existingEntries: [nueva, ...huerfanas], today: TODAY,
    });
    // Assert: sin el guard salían 4 copias (10.800 € → 21.600 € en el caso real)
    expect(missing).toEqual([]);
  });

  it('la huella exige fecha, tipo, categoría e importe iguales', () => {
    const nueva = tpl('T2', '2026-06-01');
    const distinta = { ...occ('x', null, '2026-06'), amount: 1200 };
    const missing = computeMissingOccurrences({
      templates: [nueva], existingEntries: [nueva, distinta], today: '2026-06-15',
    });
    expect(missing).toHaveLength(1);
    expect(missing[0].source_month).toBe('2026-06');
  });

  it('una fila huérfana LAPIDADA no cuenta como resuelta por huella', () => {
    // La lápida ya se respeta por (source_id, month); si además perdió el
    // enlace, no puede bloquear la regeneración por parecerse.
    const nueva = tpl('T2', '2026-06-01');
    const lapidada = { ...occ('x', null, '2026-06'), skipped: true };
    const missing = computeMissingOccurrences({
      templates: [nueva], existingEntries: [nueva, lapidada], today: '2026-06-15',
    });
    expect(missing).toHaveLength(1);
  });

  it('sigue generando lo que falta de verdad', () => {
    const t1 = tpl('T1', '2026-06-01');
    const missing = computeMissingOccurrences({
      templates: [t1], existingEntries: [t1, occ('o0', 'T1', '2026-06')], today: TODAY,
    });
    expect(missing.map((r) => r.source_month)).toEqual(['2026-07', '2026-08', '2026-09']);
  });
});

describe('las metas suman lo mismo en la tarjeta y en la cabecera', () => {
  const TODAY = '2026-09-01';
  // Una de cada estado: viva, vencida, completada y con el sobre ya gastado.
  const goals = [
    { id: 'viva', target_amount: 5000, target_date: '2027-04-15', allocated_amount: 3800 },
    { id: 'vencida', target_amount: 900, target_date: '2026-06-10', allocated_amount: 340 },
    { id: 'completada', target_amount: 1400, target_date: '2026-07-20', allocated_amount: 1400, completed_at: '2026-07-22T10:00:00Z' },
    { id: 'gastada', target_amount: 700, target_date: '2026-07-12', allocated_amount: 700 },
  ];
  const spending = { gastada: 691 };

  it('Σ(lo que pinta cada tarjeta) === "Asignado a metas" del hero', () => {
    // Act: la tarjeta pinta `released` si está cerrada y `balance` si no
    const sumaTarjetas = goals.reduce((acc, g) => {
      const p = computeGoalProgress({ goal: g, today: TODAY, spent: spending[g.id] || 0 });
      return acc + (p.closed ? 0 : p.balance);
    }, 0);
    // Assert
    expect(sumaTarjetas).toBe(computeAllocatedTotal(goals, spending, { today: TODAY }));
    expect(sumaTarjetas).toBe(3800 + 9); // viva + lo que queda del sobre gastado
  });

  it('una meta cerrada publica lo liberado y deja de retener', () => {
    const p = computeGoalProgress({ goal: goals[1], today: TODAY });
    expect(p.closed).toBe(true);
    expect(p.released).toBe(340);
    expect(computeAllocatedTotal([goals[1]], {}, { today: TODAY })).toBe(0);
  });

  it('el sobre gastado retiene solo el saldo, aunque el progreso siga al 100%', () => {
    const p = computeGoalProgress({ goal: goals[3], today: TODAY, spent: 691 });
    expect(p.balance).toBe(9);      // lo que la tarjeta pinta y el hero suma
    expect(p.pct).toBe(100);        // el logro no se deshace
    expect(p.allocated).toBe(700);  // progreso congelado (magnitud distinta)
  });
});

// El caso real que lo destapó: "Moto", 4.755 € para el 2026-12-14, 2.051 €
// apartados. El 1 de septiembre la tarjeta pedía 901 €/mes (3 meses) ignorando
// septiembre entero, y en diciembre el ritmo desaparecía.
describe('el ritmo mensual cuenta el mes en curso', () => {
  const moto = { id: 'moto', target_amount: 4755, target_date: '2026-12-14', allocated_amount: 2051 };

  it('el primer día del mes, ese mes SÍ cuenta', () => {
    const p = computeGoalProgress({ goal: moto, today: '2026-09-01' });
    expect(p.monthsLeft).toBe(4);            // sep, oct, nov, dic
    expect(p.remaining).toBe(2704);
    expect(p.neededPerMonth).toBe(676);      // antes: 901,33 — un 33% de más
  });

  it('no cambia a mitad ni a final de mes (el mes sigue siendo asignable)', () => {
    expect(computeGoalProgress({ goal: moto, today: '2026-09-30' }).monthsLeft).toBe(4);
    expect(computeGoalProgress({ goal: moto, today: '2026-10-01' }).monthsLeft).toBe(3);
  });

  it('en el MES del vencimiento sigue habiendo ritmo (antes se ocultaba)', () => {
    const p = computeGoalProgress({ goal: moto, today: '2026-12-01' });
    expect(p.monthsLeft).toBe(1);
    expect(p.neededPerMonth).toBe(2704);     // antes: null → la línea desaparecía
  });

  it('pasada la fecha no hay ritmo: la meta está vencida', () => {
    const p = computeGoalProgress({ goal: moto, today: '2026-12-15' });
    expect(p.closed).toBe(true);
    expect(p.neededPerMonth).toBeNull();
  });

  it('una meta ya conseguida no pide ritmo aunque queden meses', () => {
    const p = computeGoalProgress({ goal: { ...moto, allocated_amount: 4755 }, today: '2026-09-01' });
    expect(p.reached).toBe(true);
    expect(p.neededPerMonth).toBeNull();
  });
});

describe('computeAllocatedTotal', () => {
  it('sums allocated across goals (missing/0 treated as 0)', () => {
    expect(computeAllocatedTotal([
      { allocated_amount: 800 },
      { allocated_amount: 1200 },
      { allocated_amount: null },
      {},
    ])).toBe(2000);
  });
});

describe('computeBudgetStatus', () => {
  const rows = [
    entry({ id: 'a', category: 'housing', amount: 640, entry_date: '2026-07-01' }),
    entry({ id: 'b', category: 'groceries', amount: 90, entry_date: '2026-07-10' }),
    entry({ id: 'c', category: 'housing', amount: 100, entry_date: '2026-06-01' }),
  ];

  it('computes spent vs limit per category, sorted by consumption', () => {
    const out = computeBudgetStatus(rows, { housing: 800, groceries: 300, transport: 100 }, { year: 2026, month: 7 });
    expect(out[0]).toEqual({ category: 'housing', limit: 800, spent: 640, pct: 80 });
    expect(out[1]).toEqual({ category: 'groceries', limit: 300, spent: 90, pct: 30 });
    expect(out[2]).toEqual({ category: 'transport', limit: 100, spent: 0, pct: 0 });
  });

  it('ignores categories without a positive limit', () => {
    const out = computeBudgetStatus(rows, { housing: 0, groceries: null }, { year: 2026, month: 7 });
    expect(out).toEqual([]);
  });
});

describe('computeMonthlyInsights', () => {
  it('reports the top expense category share', () => {
    const insights = computeMonthlyInsights([
      entry({ id: 'a', category: 'transport', amount: 300, entry_date: '2026-07-01' }),
      entry({ id: 'b', category: 'leisure', amount: 100, entry_date: '2026-07-05' }),
    ], { year: 2026, month: 7 });
    expect(insights[0]).toEqual({ key: 'top_category', category: 'transport', pct: 75 });
  });

  it('reports month-over-month expense change (≥5%) across a year boundary', () => {
    const insights = computeMonthlyInsights([
      entry({ id: 'dec', amount: 100, entry_date: '2025-12-10' }),
      entry({ id: 'jan', amount: 150, entry_date: '2026-01-10' }),
    ], { year: 2026, month: 1 });
    expect(insights.find((i) => i.key === 'expenses_up')).toEqual({ key: 'expenses_up', pct: 50 });
  });

  it('celebrates a savings rate ≥20%', () => {
    const insights = computeMonthlyInsights([
      entry({ id: 'i', type: 'income', amount: 1000, entry_date: '2026-07-01' }),
      entry({ id: 'g', amount: 500, entry_date: '2026-07-05' }),
    ], { year: 2026, month: 7 });
    expect(insights.find((i) => i.key === 'good_rate')).toEqual({ key: 'good_rate', pct: 50 });
  });
});

describe('computeBalanceSeries', () => {
  const salaryTpl = template({ id: 'tpl-salary', type: 'income', amount: 1000, entry_date: '2026-01-01', recurrence_day: 1 });

  it('accumulates initial + prior years + monthly nets, projecting future months', () => {
    const entries = [
      entry({ id: 'old', type: 'income', amount: 500, entry_date: '2025-11-05' }),
      entry({ id: 'jul', type: 'income', amount: 200, entry_date: '2026-07-05' }),
    ];
    const series = computeBalanceSeries({ entries, templates: [salaryTpl], year: 2026, today: '2026-07-19', initialBalance: 1000 });
    expect(series).toHaveLength(12);
    // months Jan-Jun: no data → balance stays 1500 (initial + 2025 income)
    expect(series[5]).toMatchObject({ month: 6, balance: 1500, projected: false });
    expect(series[6]).toMatchObject({ month: 7, balance: 1700, projected: false });
    // Aug onward: +1000/month projected
    expect(series[7]).toMatchObject({ month: 8, balance: 2700, projected: true });
    expect(series[11]).toMatchObject({ month: 12, balance: 6700, projected: true });
  });
});

describe('expensesToCsv', () => {
  const labels = {
    date: 'Fecha', type: 'Tipo', category: 'Categoría', amount: 'Importe',
    currency: 'Divisa', notes: 'Notas', income: 'Ingreso', expense: 'Gasto', total: 'Total',
    monthNames: ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'],
    categoryNames: { transport: 'Transporte', salary: 'Nómina' },
  };

  it('exports the movement list and the category×month matrix in Excel-ES dialect', () => {
    const csv = expensesToCsv([
      entry({ id: 'a', category: 'transport', amount: 82.09, entry_date: '2026-07-15', notes: 'Moto; cuota' }),
      entry({ id: 'b', type: 'income', category: 'salary', amount: 1400, entry_date: '2026-08-01' }),
      entry({ id: 'out', amount: 999, entry_date: '2025-12-31' }),
      template({ amount: 5 }),
    ], { year: 2026, labels });
    const lines = csv.split('\n');
    expect(lines[0]).toBe('Fecha;Tipo;Categoría;Importe;Divisa;Notas');
    expect(lines[1]).toBe('2026-07-15;Gasto;Transporte;-82,09;EUR;"Moto; cuota"');
    expect(lines[2]).toBe('2026-08-01;Ingreso;Nómina;1400,00;EUR;');
    expect(lines[3]).toBe('');
    expect(lines[4].startsWith('Categoría;Ene;')).toBe(true);
    expect(lines[5]).toContain('Transporte');
    expect(lines[5].split(';')[7]).toBe('82,09'); // July column
    expect(lines[5].split(';')[13]).toBe('82,09'); // total
  });
});

describe('computeTotalSavedBalance', () => {
  it('adds the initial balance to the all-time net of the entries', () => {
    const total = computeTotalSavedBalance([
      entry({ id: 'a', type: 'income', amount: 830, entry_date: '2026-07-01' }),
      entry({ id: 'b', amount: 100.09, entry_date: '2026-07-15' }),
      template({ amount: 999 }),
    ], 3000);
    expect(total).toBeCloseTo(3729.91, 10);
  });

  it('defaults to plain net without initial balance', () => {
    expect(computeTotalSavedBalance([entry({ id: 'a', amount: 50 })])).toBe(-50);
  });

  it('excludes future-dated movements when today is given', () => {
    const entries = [
      entry({ id: 'now', amount: 100, entry_date: '2026-07-10' }),        // realized
      entry({ id: 'future', amount: 4899, entry_date: '2026-09-20' }),    // planned, not yet spent
    ];
    // Without today: subtracts everything (the reported bug)
    expect(computeTotalSavedBalance(entries, 800)).toBe(800 - 100 - 4899);
    // With today: only the realized -100 counts
    expect(computeTotalSavedBalance(entries, 800, '2026-07-19')).toBe(800 - 100);
  });
});

describe('computeDailyTotals', () => {
  it('aggregates income and expenses per day of the month', () => {
    const days = computeDailyTotals([
      entry({ id: 'a', type: 'income', amount: 2000, entry_date: '2026-07-01' }),
      entry({ id: 'b', amount: 300, entry_date: '2026-07-01' }),
      entry({ id: 'c', amount: 50, entry_date: '2026-07-15' }),
      entry({ id: 'd', amount: 25.5, entry_date: '2026-07-15' }),
    ], { year: 2026, month: 7 });
    expect(days[1]).toEqual({ income: 2000, expenses: 300, net: 1700, projected: false });
    expect(days[15]).toEqual({ income: 0, expenses: 75.5, net: -75.5, projected: false });
    expect(days[2]).toBeUndefined();
  });

  it('excludes templates and other months', () => {
    const days = computeDailyTotals([
      template({ amount: 999, entry_date: '2026-07-05' }),
      entry({ id: 'x', amount: 10, entry_date: '2026-06-05' }),
    ], { year: 2026, month: 7 });
    expect(days).toEqual({});
  });

  it('marks a day projected only when all its entries are projected', () => {
    const days = computeDailyTotals([
      entry({ id: 'p1', type: 'income', amount: 1400, entry_date: '2026-08-01', projected: true }),
      entry({ id: 'p2', amount: 18, entry_date: '2026-08-17', projected: true }),
      entry({ id: 'real', amount: 5, entry_date: '2026-08-17' }),
    ], { year: 2026, month: 8 });
    expect(days[1].projected).toBe(true);
    expect(days[17].projected).toBe(false);
    expect(days[17].expenses).toBe(23);
  });
});

describe('computeMonthlySummary', () => {
  it('sums income and expenses of the month and derives the savings rate', () => {
    const s = computeMonthlySummary([
      entry({ id: 'i', type: 'income', category: 'salary', amount: 2000, entry_date: '2026-07-01' }),
      entry({ id: 'g1', amount: 400, entry_date: '2026-07-10' }),
      entry({ id: 'g2', amount: 100, entry_date: '2026-07-20' }),
    ], { year: 2026, month: 7 });
    expect(s.income).toBe(2000);
    expect(s.expenses).toBe(500);
    expect(s.net).toBe(1500);
    expect(s.savingsRate).toBe(0.75);
  });

  it('returns a null savings rate when there is no income (no division by zero)', () => {
    const s = computeMonthlySummary([entry({ amount: 300 })], { year: 2026, month: 7 });
    expect(s.savingsRate).toBeNull();
    expect(s.net).toBe(-300);
  });

  it('yields a negative rate when expenses exceed income', () => {
    const s = computeMonthlySummary([
      entry({ id: 'i', type: 'income', amount: 100, entry_date: '2026-07-01' }),
      entry({ id: 'g', amount: 150, entry_date: '2026-07-02' }),
    ], { year: 2026, month: 7 });
    expect(s.savingsRate).toBe(-0.5);
  });

  it('excludes templates and other months', () => {
    const s = computeMonthlySummary([
      template({ amount: 999, entry_date: '2026-07-01' }),
      entry({ id: 'x', amount: 50, entry_date: '2026-06-30' }),
      entry({ id: 'y', amount: 10, entry_date: '2026-07-15' }),
    ], { year: 2026, month: 7 });
    expect(s.expenses).toBe(10);
  });

  it('sums float amounts without binary noise', () => {
    const s = computeMonthlySummary([
      entry({ id: 'a', amount: 0.1 }),
      entry({ id: 'b', amount: 0.2 }),
    ], { year: 2026, month: 7 });
    expect(s.expenses).toBe(0.3);
  });
});

describe('computeAnnualSummary', () => {
  it('aggregates the whole calendar year only', () => {
    const s = computeAnnualSummary([
      entry({ id: 'a', type: 'income', amount: 1000, entry_date: '2026-01-05' }),
      entry({ id: 'b', amount: 200, entry_date: '2026-12-31' }),
      entry({ id: 'c', amount: 999, entry_date: '2025-12-31' }),
    ], { year: 2026 });
    expect(s.income).toBe(1000);
    expect(s.expenses).toBe(200);
  });
});

describe('computeAnnualSeries', () => {
  it('always returns 12 buckets, empty months included', () => {
    const series = computeAnnualSeries([
      entry({ id: 'i', type: 'income', amount: 2000, entry_date: '2026-03-01' }),
      entry({ id: 'g', amount: 500, entry_date: '2026-03-15' }),
    ], { year: 2026 });
    expect(series).toHaveLength(12);
    expect(series[2]).toMatchObject({ month: 3, monthKey: '2026-03', income: 2000, expenses: 500, net: 1500 });
    expect(series[0]).toMatchObject({ month: 1, income: 0, expenses: 0, net: 0 });
  });

  it('ignores templates and other years', () => {
    const series = computeAnnualSeries([
      template({ amount: 999, entry_date: '2026-05-01' }),
      entry({ id: 'z', amount: 100, entry_date: '2025-05-01' }),
    ], { year: 2026 });
    expect(series.every((b) => b.income === 0 && b.expenses === 0)).toBe(true);
  });
});

describe('computeCategoryBreakdown', () => {
  const rows = [
    entry({ id: 'a', category: 'housing', amount: 800, entry_date: '2026-07-01' }),
    entry({ id: 'b', category: 'groceries', amount: 300, entry_date: '2026-07-10' }),
    entry({ id: 'c', category: 'groceries', amount: 100, entry_date: '2026-07-20' }),
    entry({ id: 'd', type: 'income', category: 'salary', amount: 2000, entry_date: '2026-07-01' }),
    entry({ id: 'e', category: 'travel', amount: 999, entry_date: '2026-06-01' }),
  ];

  it('groups by category for the requested type and month, sorted desc', () => {
    const out = computeCategoryBreakdown(rows, { year: 2026, month: 7, type: 'expense' });
    expect(out).toEqual([
      { category: 'housing', value: 800 },
      { category: 'groceries', value: 400 },
    ]);
  });

  it('covers the whole year when month is omitted', () => {
    const out = computeCategoryBreakdown(rows, { year: 2026, type: 'expense' });
    expect(out.find((c) => c.category === 'travel')).toEqual({ category: 'travel', value: 999 });
  });

  it('excludes templates', () => {
    const out = computeCategoryBreakdown(
      [template({ category: 'housing', amount: 500, entry_date: '2026-07-01' })],
      { year: 2026, month: 7, type: 'expense' }
    );
    expect(out).toEqual([]);
  });
});

describe('computeCategoryBreakdownRange', () => {
  const rows = [
    entry({ id: 'a', category: 'housing', amount: 800, entry_date: '2026-07-01' }),
    entry({ id: 'b', category: 'groceries', amount: 300, entry_date: '2026-07-10' }),
    entry({ id: 'c', category: 'taxes', amount: 500, entry_date: '2026-08-15' }),
    entry({ id: 'd', type: 'income', category: 'salary', amount: 2000, entry_date: '2026-07-01' }),
    entry({ id: 'e', category: 'travel', amount: 999, entry_date: '2026-05-01' }), // out of range
    template({ category: 'housing', amount: 999, entry_date: '2026-07-05' }), // template excluded
  ];

  it('groups expenses within [from, to] inclusive, sorted desc, with total', () => {
    const out = computeCategoryBreakdownRange(rows, { from: '2026-07-01', to: '2026-08-31', type: 'expense' });
    expect(out.rows).toEqual([
      { category: 'housing', value: 800 },
      { category: 'taxes', value: 500 },
      { category: 'groceries', value: 300 },
    ]);
    expect(out.total).toBe(1600);
  });

  it('respects the range boundaries and type', () => {
    const out = computeCategoryBreakdownRange(rows, { from: '2026-07-01', to: '2026-07-31', type: 'expense' });
    expect(out.rows.map((r) => r.category)).toEqual(['housing', 'groceries']);
    expect(out.total).toBe(1100);
    const income = computeCategoryBreakdownRange(rows, { from: '2026-07-01', to: '2026-07-31', type: 'income' });
    expect(income.rows).toEqual([{ category: 'salary', value: 2000 }]);
  });
});

describe('parseAmountInput', () => {
  it('accepts the Spanish comma decimal separator (the type=number bug)', () => {
    expect(parseAmountInput('12,50')).toBe(12.5);
    expect(parseAmountInput('1.234,56')).toBe(1234.56);
  });

  it('accepts the English dot notation', () => {
    expect(parseAmountInput('12.50')).toBe(12.5);
    expect(parseAmountInput('1,234.56')).toBe(1234.56);
    expect(parseAmountInput('900')).toBe(900);
  });

  it('tolerates spaces and currency symbols', () => {
    expect(parseAmountInput(' 1 200,40 € ')).toBe(1200.4);
  });

  it('returns null for empty or non-numeric input', () => {
    expect(parseAmountInput('')).toBeNull();
    expect(parseAmountInput('   ')).toBeNull();
    expect(parseAmountInput('abc')).toBeNull();
    expect(parseAmountInput('12,3,4')).toBeNull();
    expect(parseAmountInput(null)).toBeNull();
  });

  it('passes numbers through', () => {
    expect(parseAmountInput(42)).toBe(42);
    expect(parseAmountInput(0)).toBe(0);
  });
});

describe('localTodayIso', () => {
  it('uses the LOCAL date, not the UTC one', () => {
    // 00:30 local on the 1st — toISOString() would report the previous day
    // for any timezone east of UTC, delaying recurring materialization.
    const madridMidnight = new Date(2026, 6, 1, 0, 30, 0);
    expect(localTodayIso(madridMidnight)).toBe('2026-07-01');
  });

  it('pads month and day', () => {
    expect(localTodayIso(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('detectForeignCurrencies', () => {
  it('is empty when every entry matches the display currency', () => {
    expect(detectForeignCurrencies([entry(), entry({ currency: 'EUR' })], 'EUR')).toEqual([]);
  });

  it('reports the distinct foreign currencies, sorted', () => {
    const rows = [entry({ currency: 'EUR' }), entry({ currency: 'USD' }), entry({ currency: 'GBP' }), entry({ currency: 'USD' })];
    expect(detectForeignCurrencies(rows, 'EUR')).toEqual(['GBP', 'USD']);
  });

  it('is case-insensitive and ignores empty codes', () => {
    expect(detectForeignCurrencies([entry({ currency: 'eur' }), entry({ currency: null })], 'EUR')).toEqual([]);
  });
});

describe('computeDayGroups', () => {
  it('groups by day, newest first', () => {
    const rows = [
      entry({ id: 'a', entry_date: '2026-07-05', amount: 100 }),
      entry({ id: 'b', entry_date: '2026-07-10', amount: 50 }),
      entry({ id: 'c', entry_date: '2026-07-05', type: 'income', amount: 300 }),
    ];
    const groups = computeDayGroups(rows);
    expect(groups.map((g) => g.day)).toEqual(['2026-07-10', '2026-07-05']);
    expect(groups[0].net).toBe(-50);
    expect(groups[1].net).toBe(200);
    expect(groups[1].rows).toHaveLength(2);
  });

  it('sums with decimal precision (the float subtotal bug)', () => {
    const rows = [
      entry({ id: 'a', entry_date: '2026-07-05', amount: 0.1 }),
      entry({ id: 'b', entry_date: '2026-07-05', amount: 0.2 }),
    ];
    expect(computeDayGroups(rows)[0].net).toBe(-0.3);
  });

  it('returns [] for no rows', () => {
    expect(computeDayGroups([])).toEqual([]);
  });
});

describe('computeMoneyFlow', () => {
  const rows = [
    entry({ id: 'i1', type: 'income', category: 'salary', amount: 2000, entry_date: '2026-07-01' }),
    entry({ id: 'i2', type: 'income', category: 'freelance', amount: 500, entry_date: '2026-07-10' }),
    entry({ id: 'e1', category: 'housing', amount: 900, entry_date: '2026-07-02' }),
    entry({ id: 'e2', category: 'groceries', amount: 400, entry_date: '2026-07-08' }),
  ];

  it('balances both sides: a surplus becomes a savings SINK', () => {
    const flow = computeMoneyFlow(rows, { year: 2026, month: 7 });
    expect(flow.income).toBe(2500);
    expect(flow.expenses).toBe(1300);
    expect(flow.net).toBe(1200);
    expect(flow.total).toBe(2500);
    const sourcesTotal = flow.sources.reduce((s, n) => s + n.value, 0);
    const sinksTotal = flow.sinks.reduce((s, n) => s + n.value, 0);
    expect(sourcesTotal).toBe(sinksTotal);
    expect(flow.sinks.at(-1)).toMatchObject({ category: '__saved__', value: 1200 });
  });

  it('balances both sides: a deficit becomes a savings SOURCE', () => {
    const flow = computeMoneyFlow([
      entry({ id: 'i1', type: 'income', category: 'salary', amount: 1000, entry_date: '2026-07-01' }),
      entry({ id: 'e1', category: 'housing', amount: 1500, entry_date: '2026-07-02' }),
    ], { year: 2026, month: 7 });
    expect(flow.net).toBe(-500);
    expect(flow.total).toBe(1500);
    expect(flow.sources.at(-1)).toMatchObject({ category: '__deficit__', value: 500 });
    expect(flow.sources.reduce((s, n) => s + n.value, 0))
      .toBe(flow.sinks.reduce((s, n) => s + n.value, 0));
  });

  it('sorts real categories by amount desc and keeps percentages over the total', () => {
    const flow = computeMoneyFlow(rows, { year: 2026, month: 7 });
    expect(flow.sources.map((n) => n.category)).toEqual(['salary', 'freelance']);
    expect(flow.sinks.map((n) => n.category)).toEqual(['housing', 'groceries', '__saved__']);
    expect(flow.sources[0].pct).toBe(80); // 2000 / 2500
  });

  it('ignores templates and other months', () => {
    const flow = computeMoneyFlow([
      ...rows,
      template({ id: 'tpl', type: 'income', amount: 9999, entry_date: '2026-07-01' }),
      entry({ id: 'other', amount: 700, entry_date: '2026-06-15' }),
    ], { year: 2026, month: 7 });
    expect(flow.income).toBe(2500);
    expect(flow.expenses).toBe(1300);
  });

  it('returns an empty balanced model for a month with no data', () => {
    const flow = computeMoneyFlow([], { year: 2026, month: 3 });
    expect(flow).toMatchObject({ sources: [], sinks: [], total: 0, income: 0, expenses: 0, net: 0 });
  });

  it('a month with only expenses draws the whole spend as coming from savings', () => {
    const flow = computeMoneyFlow([entry({ id: 'e1', amount: 300, entry_date: '2026-07-04' })], { year: 2026, month: 7 });
    expect(flow.sources).toHaveLength(1);
    expect(flow.sources[0]).toMatchObject({ category: '__deficit__', value: 300, pct: 100 });
    expect(flow.sinks).toHaveLength(1);
    expect(flow.sinks[0]).toMatchObject({ category: 'groceries', value: 300, pct: 100 });
  });
});

describe('computeMoneyFlow — colapso de cola', () => {
  it('collapses everything past 8 bands into __rest__ and still balances', () => {
    const many = Array.from({ length: 12 }, (_, i) => entry({
      id: `e${i}`, category: `cat${i}`, amount: 100 - i * 5, entry_date: '2026-07-05',
    }));
    const flow = computeMoneyFlow([
      entry({ id: 'inc', type: 'income', category: 'salary', amount: 5000, entry_date: '2026-07-01' }),
      ...many,
    ], { year: 2026, month: 7 });
    // 7 categorías reales + __rest__ + __saved__: el tope se aplica a las
    // categorías, y el ahorro NUNCA se colapsa dentro de "Otros" — es
    // justamente el dato que el diagrama existe para enseñar.
    expect(flow.sinks).toHaveLength(9);
    expect(flow.sinks.filter((n) => n.category === '__rest__')).toHaveLength(1);
    expect(flow.sinks.at(-1).category).toBe('__saved__');
    expect(flow.sources.reduce((s, n) => s + n.value, 0))
      .toBeCloseTo(flow.sinks.reduce((s, n) => s + n.value, 0), 6);
    expect(flow.expenses).toBe(many.reduce((s, e) => s + e.amount, 0));
  });
});

describe('computeMoneyFlow — datos del hover por canal', () => {
  const rows = [
    entry({ id: 'i1', type: 'income', category: 'salary', amount: 2000, entry_date: '2026-07-01', notes: 'Nómina' }),
    entry({ id: 'e1', category: 'groceries', amount: 120, entry_date: '2026-07-02' }),
    entry({ id: 'e2', category: 'groceries', amount: 380, entry_date: '2026-07-08', notes: 'Compra del mes' }),
    entry({ id: 'e3', category: 'groceries', amount: 45, entry_date: '2026-07-20' }),
    entry({ id: 'e4', category: 'housing', amount: 900, entry_date: '2026-07-01' }),
  ];

  it('counts the movements behind each channel and keeps the largest one', () => {
    const flow = computeMoneyFlow(rows, { year: 2026, month: 7 });
    const groceries = flow.sinks.find((n) => n.category === 'groceries');
    expect(groceries.count).toBe(3);
    expect(groceries.biggest).toEqual({ amount: 380, notes: 'Compra del mes', entry_date: '2026-07-08' });
  });

  it('sidePct is the weight INSIDE its own side, not over the total', () => {
    const flow = computeMoneyFlow(rows, { year: 2026, month: 7 });
    const housing = flow.sinks.find((n) => n.category === 'housing');
    expect(housing.value).toBe(900);
    expect(housing.pct).toBe(45);            // 900 / 2000 (total del mes)
    expect(housing.sidePct).toBeCloseTo((900 / 1445) * 100, 6); // 900 / 1445 (tus gastos)
    const salary = flow.sources.find((n) => n.category === 'salary');
    expect(salary.sidePct).toBe(100);        // único ingreso
  });

  it('the savings node is not a movement: count 0 and no biggest', () => {
    const saved = computeMoneyFlow(rows, { year: 2026, month: 7 }).sinks.at(-1);
    expect(saved.category).toBe('__saved__');
    expect(saved.count).toBe(0);
    expect(saved.biggest).toBeNull();
  });

  it('"Otros" inherits the aggregated count of the categories it absorbs', () => {
    const many = Array.from({ length: 12 }, (_, i) => entry({
      id: `x${i}`, category: `cat${i}`, amount: 100 - i * 5, entry_date: '2026-07-05',
    }));
    const flow = computeMoneyFlow([
      entry({ id: 'inc', type: 'income', category: 'salary', amount: 5000, entry_date: '2026-07-01' }),
      ...many,
    ], { year: 2026, month: 7 });
    const rest = flow.sinks.find((n) => n.category === '__rest__');
    expect(rest.collapsed).toBe(5);  // 12 categorías − 7 que se muestran enteras
    expect(rest.count).toBe(5);      // un movimiento por categoría absorbida
  });
});
