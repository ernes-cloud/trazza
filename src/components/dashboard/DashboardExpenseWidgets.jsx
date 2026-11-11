import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber, getCurrencySymbol } from '@/lib/formatters';
import { computeDailyTotals, computeCategoryBreakdownRange, computeDayGroups, categoryLabel, endOfMonthIso, presentBreakdown } from '@/services/expenseService';
import { useExpenseRates } from '@/hooks/useExpenseRates';
import ExpenseCategoryDonut from '@/components/expenses/ExpenseCategoryDonut';
import ExpenseCalendar from '@/components/expenses/ExpenseCalendar';

/**
 * The chart-like expenses widgets on the Dashboard (donut + calendar). The
 * monthly summary lives in DashboardExpenseSummary so it can be stacked next to
 * the watchlist. `entries` (non-template rows) come from the Dashboard's single
 * fetch; order/visibility from `layout`. `onAddEntry(iso)` opens the Dashboard's
 * own quick-add dialog with that date.
 *
 * Clicking a calendar day NEVER leaves the Dashboard (it used to navigate to
 * /app/gastos, which threw away the rest of the screen for a peek at one day):
 * a day with movements expands them inside the card, an empty day opens
 * quick-add prefilled with it — the same semantics as the Gastos screen.
 */
const DashboardExpenseWidgets = ({ layout = [], entries = [], currency = 'EUR', privacyMode, onAddEntry }) => {
  const { t } = useTranslation();
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const [selectedDay, setSelectedDay] = useState(null);
  const { fxOpts } = useExpenseRates(entries, [], currency);

  const dailyTotals = useMemo(
    () => computeDailyTotals(entries, { year, month, ...fxOpts }),
    [entries, year, month, fxOpts],
  );

  const [dFrom, setDFrom] = useState(`${year}-01-01`);
  const [dTo, setDTo] = useState(endOfMonthIso(now));
  const [dType, setDType] = useState('expense');
  const donut = useMemo(
    () => computeCategoryBreakdownRange(entries, { from: dFrom, to: dTo, type: dType, ...fxOpts }),
    [entries, dFrom, dTo, dType, fxOpts],
  );
  const donutPresentation = useMemo(
    () => presentBreakdown(donut.rows, { privacyMode }),
    [donut.rows, privacyMode],
  );

  const sym = getCurrencySymbol(currency);
  const money = (v, dec = 2) => (privacyMode ? '••••' : `${sym}${formatNumber(v, dec, dec)}`);
  const pctText = (v, dec = 0) => `${formatNumber(v, dec, dec)}%`;

  const ord = (id) => { const i = layout.findIndex((w) => w.id === id); return i === -1 ? 99 : i; };
  const vis = (id) => layout.find((w) => w.id === id)?.visible !== false;

  const isoOf = (day) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  const handleDayClick = (day, iso, hasData) => {
    if (hasData) {
      setSelectedDay((current) => (current === day ? null : day));
    } else {
      onAddEntry?.(iso);
    }
  };

  // Movements of the expanded day. Grouping/subtotal via computeDayGroups
  // (decimal.js) instead of an inline sum — a float net printed
  // -0.30000000000000004 in the list before that service existed.
  const dayGroup = useMemo(() => {
    if (selectedDay === null) return null;
    const iso = isoOf(selectedDay);
    const rows = entries.filter((e) => (e.entry_date || '').split('T')[0] === iso);
    return computeDayGroups(rows, fxOpts)[0] || null;
  }, [entries, selectedDay, year, month, fxOpts]);

  const dayDetail = dayGroup && (
    <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-700/50">
      <div className="flex items-center justify-between gap-3 mb-2">
        <p className="font-ledger text-[10px] uppercase tracking-[0.2em] text-slate-400">
          {t('expenses.day_filter_chip', { day: selectedDay })}
          <span className={`ml-2 font-bold tabular-nums ${dayGroup.net >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
            {dayGroup.net >= 0 ? '+' : '-'}{money(Math.abs(dayGroup.net))}
          </span>
        </p>
        <button
          type="button"
          onClick={() => setSelectedDay(null)}
          className="text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:underline"
        >
          {t('expenses.donut_detail_close')}
        </button>
      </div>
      <ul className="space-y-1 max-h-48 overflow-y-auto overflow-x-hidden custom-scrollbar pr-1">
        {dayGroup.rows.map((row) => (
          <li key={row.id} className="flex items-center justify-between gap-3 text-xs px-1 py-1">
            <span className="text-slate-600 dark:text-slate-300 truncate">
              {row.notes || categoryLabel(t, row.category || 'other')}
            </span>
            <span className={`font-ledger tabular-nums shrink-0 ${row.type === 'income' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
              {row.type === 'income' ? '+' : '-'}{money(row.amount)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <>
      {/* Reparto de gastos/ingresos (rango + toggle) */}
      {vis('exp_donut') && (
        <div style={{ order: ord('exp_donut') }} className="[&>div]:h-full">
          <ExpenseCategoryDonut
            rows={donut.rows}
            total={donut.total}
            displayRows={donutPresentation.rows}
            amountsHidden={donutPresentation.amountsHidden}
            entries={entries}
            from={dFrom}
            to={dTo}
            type={dType}
            onTypeChange={setDType}
            onFromChange={setDFrom}
            onToChange={setDTo}
            formatMoney={money}
            formatPercent={pctText}
            fxOpts={fxOpts}
            flowEntries={entries}
            flowYear={year}
            flowMonth={month}
          />
        </div>
      )}

      {/* Calendario del mes */}
      {vis('exp_calendar') && (
        <div style={{ order: ord('exp_calendar') }} className="lg:col-span-2 [&>div]:h-full">
          <ExpenseCalendar
            year={year}
            month={month}
            dailyTotals={dailyTotals}
            formatMoney={money}
            onDayClick={handleDayClick}
            selectedDay={selectedDay}
            dayDetail={dayDetail}
          />
        </div>
      )}
    </>
  );
};

export default DashboardExpenseWidgets;
