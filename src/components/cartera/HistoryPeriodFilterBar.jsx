import React from 'react';
import { useTranslation } from 'react-i18next';
import { Filter } from 'lucide-react';

/**
 * Period filter bar for the transaction-history analytics section
 * (6M / 1Y / YTD / ALL / CUSTOM with date inputs + "filter active" badge).
 * Pure presentation: the filtering itself happens in CarteraPage over
 * already-computed arrays; onRangeChange also resets the visible-row counters.
 */
const HistoryPeriodFilterBar = ({
  histRange,
  onRangeChange,
  histRangeFrom,
  onRangeFromChange,
  histRangeTo,
  onRangeToChange,
}) => {
  const { t } = useTranslation();
  return (
    <div className="bg-linear-to-r from-white to-slate-50 dark:from-slate-900 dark:to-slate-800/80 border border-slate-200/60 dark:border-slate-700/60 rounded-3xl p-4 md:p-5 shadow-lg shadow-slate-200/20 dark:shadow-none relative overflow-hidden backdrop-blur-xl">
      <div className="absolute top-0 right-0 w-64 h-64 bg-blue-500/5 dark:bg-blue-400/5 blur-3xl rounded-full -translate-y-1/2 translate-x-1/3 pointer-events-none" />
      <div className="flex flex-col md:flex-row md:items-center gap-4 relative z-10">
        <div className="flex items-center gap-2 shrink-0">
          <div className="p-2 bg-blue-50 dark:bg-blue-900/30 rounded-xl border border-blue-100 dark:border-blue-800/50">
            <Filter className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          </div>
          <span className="text-[11px] font-black text-slate-500 dark:text-slate-400 uppercase tracking-widest">{t('cartera.analysis_period')}</span>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap bg-slate-100/50 dark:bg-slate-900/50 p-1.5 rounded-2xl border border-slate-200/50 dark:border-slate-800/50 shadow-inner">
          {[
            { id: '6M',  label: t('cartera.period_6m') },
            { id: '1Y',  label: t('cartera.period_1y') },
            { id: 'YTD', label: t('cartera.period_ytd', { year: new Date().getFullYear() }) },
            { id: 'ALL', label: t('cartera.period_all') },
            { id: 'CUSTOM', label: t('cartera.period_custom') },
          ].map(({ id, label }) => (
            <button
              key={id}
              onClick={() => onRangeChange(id)}
              className={`px-4 py-2 rounded-xl text-[11px] font-black transition-all whitespace-nowrap ${
                histRange === id
                  ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 shadow-xs ring-1 ring-slate-200/50 dark:ring-slate-600/50 scale-105'
                  : 'text-slate-500 dark:text-slate-400 hover:bg-white/60 dark:hover:bg-slate-800 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {histRange === 'CUSTOM' && (
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="date"
              value={histRangeFrom}
              onChange={e => onRangeFromChange(e.target.value)}
              className="text-[11px] font-bold border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2 bg-white dark:bg-slate-800 text-slate-900 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500/50 transition shadow-xs"
            />
            <span className="text-slate-400 text-xs font-black">—</span>
            <input
              type="date"
              value={histRangeTo}
              onChange={e => onRangeToChange(e.target.value)}
              className="text-[11px] font-bold border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2 bg-white dark:bg-slate-800 text-slate-900 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500/50 transition shadow-xs"
            />
          </div>
        )}

        {histRange !== 'ALL' && (
          <div className="md:ml-auto flex items-center gap-2 text-[10px] text-blue-700 dark:text-blue-400 font-black bg-blue-50 dark:bg-blue-900/30 px-3 py-1.5 rounded-xl border border-blue-100 dark:border-blue-800/40 shadow-xs">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
            {t('cartera.filter_active')}
          </div>
        )}
      </div>
    </div>
  );
};

export default HistoryPeriodFilterBar;
