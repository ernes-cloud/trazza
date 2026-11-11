import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Pencil, Trash2, Repeat, X } from 'lucide-react';
import { categoryLabel, computeDayGroups } from '@/services/expenseService';

/**
 * Movement list grouped by day with search + type/category filters.
 * Pure presentation: rows arrive pre-filtered to the period (projected
 * pseudo-rows included); deletion/edit policy stays with the page.
 * `formatMoney` is the page's privacy-aware formatter.
 */
const ExpenseList = ({ rows = [], formatMoney, onEdit, onDelete, emptyTitle, emptyHint, fxOpts }) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');

  const categories = useMemo(() => (
    [...new Set(rows.map((r) => r.category || 'other'))].sort()
  ), [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (typeFilter !== 'all' && row.type !== typeFilter) return false;
      if (categoryFilter !== 'all' && (row.category || 'other') !== categoryFilter) return false;
      if (!q) return true;
      const haystack = `${row.notes || ''} ${categoryLabel(t, row.category || 'other')}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [rows, query, typeFilter, categoryFilter, t]);

  // Grouping + day subtotals live in expenseService (decimal.js): the inline
  // float version produced -0.30000000000000004 subtotals.
  const groups = useMemo(() => computeDayGroups(filtered, fxOpts || {}), [filtered, fxOpts]);

  const hasActiveFilter = query.trim() !== '' || typeFilter !== 'all' || categoryFilter !== 'all';
  // flex-1 + min-w-0 en móvil: los dos selects se reparten su fila sin empujarse
  // (un <select> nativo crece con la opción más larga y desbordaba la card).
  const selectClass = 'flex-1 min-w-0 sm:flex-none px-2 py-2 sm:py-1.5 border rounded-lg text-xs dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500';

  return (
    <>
      {/* Filtros. En móvil el buscador se queda la fila entera (basis-full) y los
          dos selects se reparten la siguiente al 50%: apretados en una sola fila
          truncaban "Todas las categorías" hasta volverse indistinguibles. */}
      <div className="px-4 sm:px-5 py-3 border-b border-slate-200/80 dark:border-slate-700/40 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 basis-full sm:basis-auto sm:flex-1 sm:min-w-[150px]">
          <Search className="absolute left-2.5 top-2.5 sm:top-2 w-3.5 h-3.5 text-slate-400" />
          {/* size=1 + min-w-0: sin ellos el input impone su ancho intrínseco de
              ~20 caracteres (212px) como mínimo indeformable y estira el widget. */}
          <input
            type="text"
            size={1}
            placeholder={t('expenses.search_placeholder')}
            className="w-full min-w-0 pl-8 pr-3 py-2 sm:py-1.5 border rounded-lg text-xs dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500 transition-all"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select className={selectClass} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="all">{t('expenses.filter_all_types')}</option>
          <option value="expense">{t('expenses.form_type_expense')}</option>
          <option value="income">{t('expenses.form_type_income')}</option>
        </select>
        <select className={selectClass} value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
          <option value="all">{t('expenses.filter_all_categories')}</option>
          {categories.map((cat) => (
            <option key={cat} value={cat}>{categoryLabel(t, cat)}</option>
          ))}
        </select>
        {hasActiveFilter && (
          <button
            onClick={() => { setQuery(''); setTypeFilter('all'); setCategoryFilter('all'); }}
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:underline"
          >
            <X className="w-3 h-3" />
            {t('expenses.filter_clear')}
          </button>
        )}
      </div>

      {groups.length === 0 ? (
        <div className="text-center py-12 px-6">
          <p className="text-sm font-semibold text-slate-500 dark:text-slate-400">
            {hasActiveFilter ? t('expenses.filter_no_results') : emptyTitle}
          </p>
          {!hasActiveFilter && <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">{emptyHint}</p>}
        </div>
      ) : (
        /* Internal scroll instead of an unbounded page: a year view can hold
           hundreds of rows (same policy as the Dashboard's long lists). */
        <div className="max-h-[620px] overflow-y-auto custom-scrollbar">
        {groups.map((group) => (
          <div key={group.day}>
            <div className="sticky top-0 z-10 flex items-center justify-between gap-2 px-4 sm:px-5 py-1.5 bg-slate-50 dark:bg-slate-900/95 backdrop-blur-xs border-y border-slate-100 dark:border-slate-700/30">
              <span className="font-ledger text-[10px] uppercase tracking-[0.2em] text-slate-400">{group.day}</span>
              <span className={`font-ledger text-[10px] font-bold tabular-nums ${group.net >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                {group.net >= 0 ? '+' : '-'}{formatMoney(Math.abs(group.net))}
              </span>
            </div>
            <ul className="divide-y divide-slate-100 dark:divide-slate-700/40">
              {group.rows.map((row) => (
                <li key={row.id} className={`flex items-center gap-2 sm:gap-3 px-4 sm:px-5 py-3 ${row.projected ? 'opacity-70' : ''}`}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                        {categoryLabel(t, row.category || 'other')}
                      </p>
                      {row.projected ? (
                        <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 rounded-full px-2 py-0.5">
                          <Repeat className="w-2.5 h-2.5" />
                          {t('expenses.projected_badge')}
                        </span>
                      ) : row.recurring_source_id && (
                        <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 rounded-full px-2 py-0.5">
                          <Repeat className="w-2.5 h-2.5" />
                          {t('expenses.recurring_badge')}
                        </span>
                      )}
                    </div>
                    {row.notes && <p className="text-xs text-slate-400 truncate">{row.notes}</p>}
                  </div>
                  <span className={`font-ledger text-sm font-bold tabular-nums shrink-0 ${row.type === 'income' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                    {row.type === 'income' ? '+' : '-'}{formatMoney(row.amount)}
                  </span>
                  {!row.projected && (
                    <div className="flex items-center gap-0.5 sm:gap-1 shrink-0">
                      <button
                        onClick={() => onEdit(row)}
                        className="inline-flex items-center justify-center min-w-[40px] min-h-[40px] lg:min-w-0 lg:min-h-0 p-2.5 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                        aria-label={t('expenses.edit_entry')}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => onDelete(row)}
                        className="inline-flex items-center justify-center min-w-[40px] min-h-[40px] lg:min-w-0 lg:min-h-0 p-2.5 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                        aria-label={t('expenses.delete_confirm_title')}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
        </div>
      )}
    </>
  );
};

export default ExpenseList;
