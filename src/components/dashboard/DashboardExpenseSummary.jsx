import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { PiggyBank, Plus, ArrowRight, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatNumber, getCurrencySymbol } from '@/lib/formatters';
import { computeMonthlySummary } from '@/services/expenseService';
import { useExpenseRates } from '@/hooks/useExpenseRates';

/**
 * Compact monthly expenses/savings summary for the Dashboard. Presentational:
 * `entries` (non-template rows) come from the Dashboard's single fetch, so this
 * can sit stacked next to another widget without a second query.
 */
/**
 * `onAdd` opens the quick-add dialog RIGHT HERE on the Dashboard; `onOpen`
 * navigates to the full expenses screen. Adding a movement is the one action
 * frequent enough to not deserve a page change.
 */
const DashboardExpenseSummary = ({ entries = [], currency = 'EUR', privacyMode, onAdd, onOpen }) => {
  const { t } = useTranslation();
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const { fxOpts } = useExpenseRates(entries, [], currency);

  const summary = useMemo(
    () => computeMonthlySummary(entries, { year, month, ...fxOpts }),
    [entries, year, month, fxOpts],
  );
  const sym = getCurrencySymbol(currency);
  const money = (v, dec = 0) => (privacyMode ? '••••' : `${sym}${formatNumber(v, dec, dec)}`);
  const monthNames = t('expenses.month_names', { returnObjects: true });
  const rateText = summary.savingsRate === null ? '—' : (privacyMode ? '••••' : `${formatNumber(summary.savingsRate * 100, 1, 1)}%`);

  const Stat = ({ label, value, dot }) => (
    <div className="rounded-xl border border-slate-200/80 dark:border-slate-700/40 p-3 flex flex-col justify-center">
      <p className="font-ledger text-[9px] uppercase tracking-[0.2em] text-slate-400 flex items-center gap-1.5">
        {dot && <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />}{label}
      </p>
      <p className="font-ledger text-lg font-bold tabular-nums tracking-tight mt-1 text-slate-900 dark:text-white">{value}</p>
    </div>
  );

  return (
    <div className="bg-white dark:bg-slate-800/80 rounded-2xl border border-slate-200/80 dark:border-slate-700/40 shadow-xs p-5 flex flex-col">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <PiggyBank className="w-4 h-4 text-blue-600" />
          {t('dashboard.widget_exp_summary')}
        </p>
        <span className="font-ledger text-[10px] uppercase tracking-[0.2em] text-slate-400">{monthNames[month - 1]} {year}</span>
      </div>
      {summary.notConvertible && summary.excludedCount > 0 && (
        <p className="mt-3 text-[11px] text-amber-800 dark:text-amber-200 flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
          {t('expenses.not_convertible_desc', { count: summary.excludedCount })}
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 mt-4 flex-1 min-h-0 auto-rows-fr">
        <Stat label={t('expenses.tile_income')} value={money(summary.income)} dot="bg-emerald-500" />
        <Stat label={t('expenses.tile_expenses')} value={money(summary.expenses)} dot="bg-rose-500" />
        <Stat label={t('expenses.tile_net')} value={money(summary.net)} />
        <Stat label={t('expenses.tile_savings_rate')} value={rateText} />
      </div>
      <div className="shrink-0 mt-auto pt-4 flex items-center gap-2">
        <Button onClick={onAdd || onOpen} className="gap-1.5 h-8 text-xs flex-1">
          <Plus className="w-3.5 h-3.5" />
          {t('expenses.add_entry')}
        </Button>
        <Button variant="outline" onClick={onOpen} className="gap-1 h-8 text-xs">
          {t('dashboard.exp_view_all')}
          <ArrowRight className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
};

export default DashboardExpenseSummary;
