// Gastos: resúmenes, series, presupuestos, insights y saldo acumulado.
// Partido desde services/expenseService.js (2026-10-04), que reexporta la API.

import Decimal from 'decimal.js';
import { D, monthKeyToParts } from './internal.js';
import { monthKeyOf, isTemplate } from './entries.js';
import { templateNetForMonth } from './recurring.js';
import {
  convertExpenseAmount,
  convertEntryForAggregate,
  excludedShape,
  attachExclusions,
} from './fx.js';

const fxSlice = (opts = {}) => (opts.preferredCurrency
  ? { preferredCurrency: opts.preferredCurrency, rates: opts.rates || {} }
  : null);

const sumByType = (entries, fxOpts) => {
  let income = new Decimal(0);
  let expenses = new Decimal(0);
  const excluded = [];
  for (const e of entries) {
    if (isTemplate(e)) continue;
    const conv = convertEntryForAggregate(e, fxOpts);
    if (!conv.convertible) {
      excluded.push(excludedShape(e));
      continue;
    }
    const v = new Decimal(conv.value);
    if (e.type === 'income') income = income.plus(v);
    else if (e.type === 'expense') expenses = expenses.plus(v);
  }
  return { income, expenses, excluded };
};

const toSummary = ({ income, expenses, excluded = [] }) => {
  const net = income.minus(expenses);
  const result = {
    income: income.toNumber(),
    expenses: expenses.toNumber(),
    net: net.toNumber(),
    savingsRate: income.gt(0) ? net.div(income).toNumber() : null,
  };
  return attachExclusions(result, excluded);
};

/** { income, expenses, net, savingsRate|null } for one month. Excludes templates. */
export function computeMonthlySummary(entries = [], opts = {}) {
  const { year, month } = opts;
  const mk = `${year}-${String(month).padStart(2, '0')}`;
  return toSummary(sumByType(entries.filter((e) => monthKeyOf(e.entry_date) === mk), fxSlice(opts)));
}

/** Same shape as computeMonthlySummary over a full calendar year. */
export function computeAnnualSummary(entries = [], opts = {}) {
  const { year } = opts;
  const prefix = `${year}-`;
  return toSummary(sumByType(
    entries.filter((e) => (monthKeyOf(e.entry_date) || '').startsWith(prefix)),
    fxSlice(opts),
  ));
}

/** Always 12 buckets: [{ month: 1..12, monthKey, income, expenses, net }]. */
export function computeAnnualSeries(entries = [], opts = {}) {
  const { year } = opts;
  const fxOpts = fxSlice(opts);
  const buckets = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    monthKey: `${year}-${String(i + 1).padStart(2, '0')}`,
    income: new Decimal(0),
    expenses: new Decimal(0),
  }));
  const excluded = [];
  for (const e of entries) {
    if (isTemplate(e)) continue;
    const mk = monthKeyOf(e.entry_date);
    if (!mk || !mk.startsWith(`${year}-`)) continue;
    const b = buckets[monthKeyToParts(mk).month - 1];
    if (!b) continue;
    const conv = convertEntryForAggregate(e, fxOpts);
    if (!conv.convertible) {
      excluded.push(excludedShape(e));
      continue;
    }
    const v = new Decimal(conv.value);
    if (e.type === 'income') b.income = b.income.plus(v);
    else if (e.type === 'expense') b.expenses = b.expenses.plus(v);
  }
  const series = buckets.map((b) => ({
    month: b.month,
    monthKey: b.monthKey,
    income: b.income.toNumber(),
    expenses: b.expenses.toNumber(),
    net: b.income.minus(b.expenses).toNumber(),
  }));
  return attachExclusions(series, excluded);
}

/**
 * Per-category totals for one type, month (if given) or whole year, sorted desc.
 * → [{ category, value }]
 */
export function computeCategoryBreakdown(entries = [], opts = {}) {
  const { year, month, type } = opts;
  const fxOpts = fxSlice(opts);
  const scope = month ? `${year}-${String(month).padStart(2, '0')}` : `${year}-`;
  const byCategory = {};
  const excluded = [];
  for (const e of entries) {
    if (isTemplate(e) || e.type !== type) continue;
    const mk = monthKeyOf(e.entry_date) || '';
    if (month ? mk !== scope : !mk.startsWith(scope)) continue;
    const conv = convertEntryForAggregate(e, fxOpts);
    if (!conv.convertible) {
      excluded.push(excludedShape(e));
      continue;
    }
    const cat = e.category || 'other';
    byCategory[cat] = (byCategory[cat] || new Decimal(0)).plus(new Decimal(conv.value));
  }
  const rows = Object.entries(byCategory)
    .map(([category, value]) => ({ category, value: value.toNumber() }))
    .sort((a, b) => b.value - a.value);
  return attachExclusions(rows, excluded);
}

/**
 * Per-category totals of a type over an arbitrary [from, to] date range
 * (inclusive, 'YYYY-MM-DD'). → { rows: [{ category, value }] desc, total }.
 */
export function computeCategoryBreakdownRange(entries = [], opts = {}) {
  const { from, to, type = 'expense' } = opts;
  const fxOpts = fxSlice(opts);
  const byCategory = {};
  let total = new Decimal(0);
  const excluded = [];
  for (const e of entries) {
    if (isTemplate(e) || e.type !== type) continue;
    const day = (e.entry_date || '').split('T')[0];
    if (!day || (from && day < from) || (to && day > to)) continue;
    const conv = convertEntryForAggregate(e, fxOpts);
    if (!conv.convertible) {
      excluded.push(excludedShape(e));
      continue;
    }
    const cat = e.category || 'other';
    const v = new Decimal(conv.value);
    byCategory[cat] = (byCategory[cat] || new Decimal(0)).plus(v);
    total = total.plus(v);
  }
  return attachExclusions({
    rows: Object.entries(byCategory)
      .map(([category, value]) => ({ category, value: value.toNumber() }))
      .sort((a, b) => b.value - a.value),
    total: total.toNumber(),
  }, excluded);
}

/**
 * Per-day totals of a month for the calendar widget.
 * → { [day:number]: { income, expenses, net, projected } }
 * `projected` is true only when EVERY entry of that day is a projected pseudo-row.
 */
export function computeDailyTotals(entries = [], opts = {}) {
  const { year, month } = opts;
  const fxOpts = fxSlice(opts);
  const mk = `${year}-${String(month).padStart(2, '0')}`;
  const days = {};
  const excluded = [];
  for (const e of entries) {
    if (isTemplate(e) || monthKeyOf(e.entry_date) !== mk) continue;
    const day = Number((e.entry_date || '').split('T')[0].slice(8, 10));
    if (!Number.isFinite(day) || day < 1) continue;
    const conv = convertEntryForAggregate(e, fxOpts);
    if (!conv.convertible) {
      excluded.push(excludedShape(e));
      continue;
    }
    const bucket = days[day] || { income: new Decimal(0), expenses: new Decimal(0), allProjected: true };
    const v = new Decimal(conv.value);
    if (e.type === 'income') bucket.income = bucket.income.plus(v);
    else if (e.type === 'expense') bucket.expenses = bucket.expenses.plus(v);
    else continue;
    bucket.allProjected = bucket.allProjected && !!e.projected;
    days[day] = bucket;
  }
  const out = Object.fromEntries(Object.entries(days).map(([day, b]) => [day, {
    income: b.income.toNumber(),
    expenses: b.expenses.toNumber(),
    net: b.income.minus(b.expenses).toNumber(),
    projected: b.allProjected,
  }]));
  return attachExclusions(out, excluded);
}

const convertTemplateNet = (tpl, net, fxOpts) => {
  if (!net || !fxOpts?.preferredCurrency) return net;
  const conv = convertExpenseAmount(
    net.abs().toNumber(),
    tpl.currency,
    fxOpts.preferredCurrency,
    fxOpts.rates || {},
  );
  if (!conv.convertible) return null;
  const signed = net.lt(0) ? new Decimal(conv.value).neg() : new Decimal(conv.value);
  return signed;
};

/**
 * computeAnnualSeries plus a recurring-only projection for months the
 * materializer hasn't reached: months after today's month in the current year,
 * every month of a future year, none for past years. Each bucket gains
 * { projectedIncome, projectedExpenses, projectedNet, projected } where
 * `projected` marks buckets whose displayed value includes projection.
 */
export function computeAnnualSeriesWithProjection({ entries = [], templates = [], year, today, preferredCurrency, rates } = {}) {
  const fxOpts = preferredCurrency ? { preferredCurrency, rates: rates || {} } : null;
  const series = computeAnnualSeries(entries, { year, preferredCurrency, rates });
  const todayDay = (today || '').split('T')[0];
  const todayYear = Number(todayDay.slice(0, 4));
  const todayMonth = Number(todayDay.slice(5, 7));

  return series.map((bucket) => {
    const isFuture = Number.isFinite(todayYear) && Number.isFinite(todayMonth) && (
      year > todayYear || (year === todayYear && bucket.month > todayMonth)
    );
    let projectedIncome = new Decimal(0);
    let projectedExpenses = new Decimal(0);
    if (isFuture) {
      for (const tpl of templates) {
        const net = templateNetForMonth(tpl, year, bucket.month);
        if (!net) continue;
        const converted = convertTemplateNet(tpl, net, fxOpts);
        if (converted === null && fxOpts) continue;
        const use = converted ?? net;
        if (use.gt(0)) projectedIncome = projectedIncome.plus(use);
        else projectedExpenses = projectedExpenses.plus(use.neg());
      }
    }
    const projectedNet = projectedIncome.minus(projectedExpenses);
    return {
      ...bucket,
      projectedIncome: projectedIncome.toNumber(),
      projectedExpenses: projectedExpenses.toNumber(),
      projectedNet: projectedNet.toNumber(),
      projected: isFuture && (projectedIncome.gt(0) || projectedExpenses.gt(0)),
    };
  });
}

/**
 * Budget status per expense category for one month.
 * `budgets` = { [categorySlug]: monthlyLimit } (from user_preferences.expense_budgets).
 * → [{ category, limit, spent, pct }] sorted by consumption desc; categories
 * without a positive limit are skipped.
 */
export function computeBudgetStatus(entries = [], budgets = {}, opts = {}) {
  const spentByCat = computeCategoryBreakdown(entries, { ...opts, type: 'expense' });
  const statuses = Object.entries(budgets)
    .filter(([, limit]) => D(limit).gt(0))
    .map(([category, limit]) => {
      const spent = spentByCat.find((c) => c.category === category)?.value || 0;
      const lim = D(limit).toNumber();
      return { category, limit: lim, spent, pct: D(spent).div(lim).times(100).toNumber() };
    })
    .sort((a, b) => b.pct - a.pct);
  return attachExclusions(statuses, spentByCat.excluded || []);
}

const prevMonthOf = (year, month) => (month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 });

/**
 * Data-driven one-liners for the month. → [{ key, category?, pct? }] where
 * `key` maps to i18n `expenses.insight_<key>` (category slug translated by the caller).
 */
export function computeMonthlyInsights(entries = [], opts = {}) {
  const { year, month } = opts;
  const insights = [];
  const current = computeMonthlySummary(entries, opts);
  const breakdown = computeCategoryBreakdown(entries, { ...opts, type: 'expense' });
  if (breakdown.length > 0 && current.expenses > 0) {
    const top = breakdown[0];
    insights.push({
      key: 'top_category',
      category: top.category,
      pct: Math.round((top.value / current.expenses) * 100),
    });
  }
  const prev = prevMonthOf(year, month);
  const prevSummary = computeMonthlySummary(entries, { ...opts, year: prev.year, month: prev.month });
  if (prevSummary.expenses > 0 && current.expenses > 0) {
    const change = ((current.expenses - prevSummary.expenses) / prevSummary.expenses) * 100;
    if (Math.abs(change) >= 5) {
      insights.push({ key: change > 0 ? 'expenses_up' : 'expenses_down', pct: Math.abs(Math.round(change)) });
    }
  }
  if (current.savingsRate !== null && current.savingsRate >= 0.2) {
    insights.push({ key: 'good_rate', pct: Math.round(current.savingsRate * 100) });
  }
  return insights;
}

/**
 * 12-point estimated-total-balance series for the goals sparkline:
 * initial balance + net carried from previous years + cumulative monthly net
 * (real months) + recurring projection (future months).
 * → [{ month, monthKey, balance, projected }]
 */
export function computeBalanceSeries({ entries = [], templates = [], year, today, initialBalance = 0, preferredCurrency, rates } = {}) {
  const fxOpts = preferredCurrency ? { preferredCurrency, rates: rates || {} } : null;
  const buckets = computeAnnualSeriesWithProjection({
    entries, templates, year, today, preferredCurrency, rates,
  });
  let running = D(initialBalance);
  const yearStart = `${year}-01`;
  const excluded = [];
  for (const e of entries) {
    if (isTemplate(e)) continue;
    const mk = monthKeyOf(e.entry_date);
    if (!mk || mk >= yearStart) continue;
    const conv = convertEntryForAggregate(e, fxOpts);
    if (!conv.convertible) {
      excluded.push(excludedShape(e));
      continue;
    }
    const delta = e.type === 'income' ? new Decimal(conv.value) : new Decimal(conv.value).neg();
    running = running.plus(delta);
  }
  const series = buckets.map((b) => {
    running = running.plus(b.net).plus(b.projectedNet);
    return { month: b.month, monthKey: b.monthKey, balance: running.toNumber(), projected: b.projected };
  });
  return attachExclusions(series, excluded);
}

/**
 * Estimated total money saved right now: starting balance + net of REALIZED
 * entries (up to `today`'s month). Future-dated movements (e.g. planned
 * expenses booked in coming months) are excluded — they haven't happened yet,
 * so counting them would wrongly drag the accumulated savings down. Without
 * `today` it sums every entry (all-time).
 */
export function computeTotalSavedBalance(entries = [], initialBalance = 0, today = null, fxOpts = null) {
  const todayKey = today ? monthKeyOf(today) : null;
  const rows = todayKey
    ? entries.filter((e) => { const mk = monthKeyOf(e.entry_date); return mk && mk <= todayKey; })
    : entries;
  const sums = sumByType(rows, fxOpts);
  return D(initialBalance).plus(sums.income).minus(sums.expenses).toNumber();
}

// Below this many months of real history the non-recurring average is noise
// (a single one-off would be extrapolated as a monthly habit) → estimate 0.
const MIN_MONTHS_FOR_ESTIMATE = 3;

/**
 * Year-end net-savings projection for the goal card.
 *
 * The year's entries are split into two buckets that are NEVER mixed:
 * - REALIZED: months up to the current one → shown as "Conseguido" and the only
 *   input to the non-recurring average.
 * - FUTURE KNOWN: real rows the user dated in future months (planned one-offs)
 *   → added to the projection VERBATIM; never averaged, never in "Conseguido".
 *
 * projected = starting balance + realized + futureKnown + remaining recurring
 *           (templates, exact) + avg non-recurring × months remaining.
 * `initialBalance` (money already in the bank) shifts actualNet/projectedNet and
 * is returned as `startingBalance`; it NEVER enters the monthly average.
 * The average divides by months since the FIRST realized entry of the year and
 * only applies with ≥ MIN_MONTHS_FOR_ESTIMATE months of history.
 * Past year: projection = the year's net (closed). Future year: known + 12
 * recurring months. Every component is returned so the UI can show the sum.
 */
export function projectAnnualSavings(opts = {}) {
  const {
    entries = [], templates = [], year, today, initialBalance = 0,
    preferredCurrency, rates,
  } = opts;
  const fxOpts = preferredCurrency ? { preferredCurrency, rates: rates || {} } : null;
  const todayDay = (today || '').split('T')[0];
  const todayYear = Number(todayDay.slice(0, 4));
  const todayMonth = Number(todayDay.slice(5, 7));
  const valid = Number.isFinite(todayYear) && Number.isFinite(todayMonth);

  const prefix = `${year}-`;
  const yearEntries = entries.filter((e) => !isTemplate(e) && (monthKeyOf(e.entry_date) || '').startsWith(prefix));
  const isRealized = (e) => {
    if (!valid || year < todayYear) return true;
    if (year > todayYear) return false;
    return Number((monthKeyOf(e.entry_date) || '').slice(5, 7)) <= todayMonth;
  };
  const realizedRows = yearEntries.filter(isRealized);
  const futureRows = yearEntries.filter((e) => !isRealized(e));

  const realized = sumByType(realizedRows, fxOpts);
  const realizedNet = realized.income.minus(realized.expenses);
  const futureKnown = sumByType(futureRows, fxOpts);
  const futureKnownNet = futureKnown.income.minus(futureKnown.expenses);
  const starting = D(initialBalance);
  const actualWithStarting = starting.plus(realizedNet);

  const mergedExcluded = [...(realized.excluded || []), ...(futureKnown.excluded || [])];

  const base = {
    actualNet: actualWithStarting.toNumber(),
    startingBalance: starting.toNumber(),
    realizedNet: realizedNet.toNumber(),
    realizedIncome: realized.income.toNumber(),
    realizedExpenses: realized.expenses.toNumber(),
    futureKnownNet: futureKnownNet.toNumber(),
    futureRecurringNet: 0,
    avgNonRecurringPerMonth: 0,
    nonRecurringEstimate: 0,
    isCurrentYear: valid && year === todayYear,
    isPastYear: valid && year < todayYear,
  };

  let result;
  if (!valid || year < todayYear) {
    result = { ...base, projectedNet: actualWithStarting.toNumber(), monthsElapsed: 12, monthsRemaining: 0 };
  } else {
    const firstFutureMonth = year > todayYear ? 1 : todayMonth + 1;
    let futureRecurring = new Decimal(0);
    for (let m = firstFutureMonth; m <= 12; m += 1) {
      for (const tpl of templates) {
        const net = templateNetForMonth(tpl, year, m);
        if (!net) continue;
        const converted = convertTemplateNet(tpl, net, fxOpts);
        if (converted === null && fxOpts) continue;
        futureRecurring = futureRecurring.plus(converted ?? net);
      }
    }

    if (year > todayYear) {
      result = {
        ...base,
        futureRecurringNet: futureRecurring.toNumber(),
        projectedNet: starting.plus(futureKnownNet).plus(futureRecurring).toNumber(),
        monthsElapsed: 0,
        monthsRemaining: 12,
      };
    } else {
      const monthsRemaining = 12 - todayMonth;

      let recurringActual = new Decimal(0);
      let firstDataMonth = null;
      for (const e of realizedRows) {
        const entryMonth = Number((monthKeyOf(e.entry_date) || '').slice(5, 7));
        if (firstDataMonth === null || entryMonth < firstDataMonth) firstDataMonth = entryMonth;
        if (!e.recurring_source_id) continue;
        const conv = convertEntryForAggregate(e, fxOpts);
        if (!conv.convertible) continue;
        const amount = new Decimal(conv.value);
        recurringActual = recurringActual.plus(e.type === 'income' ? amount : amount.neg());
      }
      const monthsElapsed = firstDataMonth === null ? 0 : todayMonth - firstDataMonth + 1;
      const avgNonRecurring = monthsElapsed >= MIN_MONTHS_FOR_ESTIMATE
        ? realizedNet.minus(recurringActual).div(monthsElapsed)
        : new Decimal(0);
      const nonRecurringEstimate = avgNonRecurring.times(monthsRemaining);

      const projectedNet = actualWithStarting.plus(futureKnownNet).plus(futureRecurring).plus(nonRecurringEstimate);

      result = {
        ...base,
        futureRecurringNet: futureRecurring.toNumber(),
        avgNonRecurringPerMonth: avgNonRecurring.toNumber(),
        nonRecurringEstimate: nonRecurringEstimate.toNumber(),
        projectedNet: projectedNet.toNumber(),
        monthsElapsed,
        monthsRemaining,
      };
    }
  }
  return attachExclusions(result, mergedExcluded);
}
