import React from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays } from 'lucide-react';
import { localTodayIso } from '@/services/expenseService';

/**
 * Monthly calendar card marking days that have expense/income entries.
 * Pure presentation: `dailyTotals` comes pre-aggregated from
 * expenseService.computeDailyTotals ({ [day]: { income, expenses, net, projected } });
 * `formatMoney(value, decimals)` is the page's privacy-aware formatter.
 * Monday-first grid (Spanish convention).
 * `onDayClick(day, iso, hasData)` — day with data toggles the list filter,
 * empty day opens the add dialog with that date; `selectedDay` highlights the filter.
 * OPTIONAL `dayDetail`: node rendered inside the card, under the legend. The
 * Dashboard uses it to show the clicked day's movements IN PLACE (it has no
 * movement list of its own); the Gastos screen filters its list instead.
 *
 * The "Flujo del dinero" button (+ its Sankey dialog) used to live here; since
 * 2026-07-31 it hangs off the breakdown donut (ExpenseCategoryDonut) on BOTH
 * surfaces — same single wiring point, just a different header.
 */
const ExpenseCalendar = ({ year, month, dailyTotals = {}, formatMoney, onDayClick, selectedDay, dayDetail }) => {
  const { t } = useTranslation();
  const weekdays = t('expenses.weekdays_short', { returnObjects: true });

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mondayOffset = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const todayIso = localTodayIso(); // local, not UTC: before 02:00 in Madrid the UTC date is still yesterday

  const cells = [
    ...Array.from({ length: mondayOffset }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  return (
    /* p-4 en móvil: son 8px más de ancho para el grid de 7 columnas, que es lo
       que separa una celda de 40px (roza el mínimo táctil) de una de 43px. */
    <div className="bg-white dark:bg-slate-800/80 rounded-2xl border border-slate-200/80 dark:border-slate-700/40 shadow-xs p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3 mb-4">
        <p className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <CalendarDays className="w-4 h-4 text-blue-600" />
          {t('expenses.calendar_title')}
        </p>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center">
        {weekdays.map((label, i) => (
          <div key={`wd-${i}`} className="text-[9px] font-black text-slate-400 uppercase tracking-widest py-1">
            {label}
          </div>
        ))}
        {cells.map((day, i) => {
          if (day === null) return <div key={`empty-${i}`} />;
          const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const totals = dailyTotals[day];
          const isToday = iso === todayIso;
          const title = totals
            ? `${t('expenses.tile_income')}: +${formatMoney(totals.income)} · ${t('expenses.tile_expenses')}: -${formatMoney(totals.expenses)}`
            : undefined;
          const isSelected = selectedDay === day;
          return (
            <button
              type="button"
              key={iso}
              title={title}
              onClick={() => onDayClick?.(day, iso, !!totals)}
              className={`min-h-13 md:min-h-15 rounded-lg border p-1 flex flex-col items-center gap-0.5 transition-colors hover:border-blue-400 dark:hover:border-blue-500/60 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500 ${
                isSelected
                  ? 'border-blue-600 ring-2 ring-blue-500/50 bg-blue-50 dark:bg-blue-900/30'
                  : isToday
                    ? 'border-blue-500 ring-1 ring-blue-500/40 bg-blue-50/50 dark:bg-blue-900/20'
                    : 'border-slate-100 dark:border-slate-700/40'
              } ${totals && !isSelected ? 'bg-slate-50/80 dark:bg-slate-900/40' : ''} ${totals?.projected ? 'opacity-60' : ''}`}
            >
              <span className={`font-ledger text-[10px] font-bold tabular-nums ${isToday || isSelected ? 'text-blue-600 dark:text-blue-400' : 'text-slate-500 dark:text-slate-400'}`}>
                {day}
              </span>
              {totals && (
                <>
                  <span className="flex gap-1">
                    {totals.income > 0 && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />}
                    {totals.expenses > 0 && <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />}
                  </span>
                  <span className={`hidden md:block font-ledger text-[9px] font-bold tabular-nums leading-none ${totals.net >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                    {totals.net >= 0 ? '+' : '-'}{formatMoney(Math.abs(totals.net), 0)}
                  </span>
                </>
              )}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-4 mt-3">
        <span className="flex items-center gap-1.5 text-[10px] text-slate-400 font-semibold">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          {t('expenses.tile_income')}
        </span>
        <span className="flex items-center gap-1.5 text-[10px] text-slate-400 font-semibold">
          <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
          {t('expenses.tile_expenses')}
        </span>
      </div>

      {dayDetail}
    </div>
  );
};

export default ExpenseCalendar;
