import React from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X, Plus } from 'lucide-react';

/**
 * Reusable analytics list card (Dividends / Commissions / Liquidity) extracted
 * from CarteraPage. Owns the shared chrome — card, header (icon/title/add/total),
 * search, table head, empty state, "see more" and total footer. The per-row
 * markup (which differs per table: amount formatting, edit action) is supplied
 * by the caller via `renderRow`. Pure presentation.
 *
 * Note: the original three tables had a few inconsistent `dark:` class variants
 * (e.g. the dividends header lacked dark:text-*); this component normalizes them
 * to the accent's full light+dark pair.
 *
 * Props:
 *   accent           – 'emerald' | 'rose' | 'blue' (theming)
 *   Icon             – lucide icon component for the header
 *   title            – header title (translated)
 *   titleClassName   – optional h3 color override (defaults to inheriting accent)
 *   onAdd            – add-button handler, or null/undefined to hide it
 *   addTitle         – add-button tooltip (translated)
 *   headerTotalText  – pre-formatted header total (incl. sign + symbol)
 *   recordsCount     – number of filtered records (for the count chip)
 *   showRecords      – whether to show the count chip (e.g. histRange !== 'ALL')
 *   searchValue, onSearchChange, searchPlaceholder – controlled search
 *   labelHeader      – middle column header (Product/Concept/Description)
 *   footerLabel      – footer total row label (translated)
 *   footerTotalText  – pre-formatted footer total
 *   data             – filtered rows
 *   visibleCount     – how many rows to show
 *   onSeeMore        – reveal more rows
 *   renderRow        – (item, index) => <tr> for each visible row
 */

const ACCENTS = {
  emerald: {
    headerText: 'text-emerald-600 dark:text-emerald-400',
    iconBox: 'bg-emerald-50 dark:bg-emerald-900/30 border-emerald-100 dark:border-emerald-800/50',
    searchRing: 'focus:ring-emerald-500/50',
    searchIconFocus: 'group-focus-within/search:text-emerald-500',
    addBtn: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 hover:bg-emerald-200 dark:hover:bg-emerald-900/60',
    hoverShadow: 'hover:shadow-emerald-500/10',
  },
  rose: {
    headerText: 'text-rose-500 dark:text-rose-400',
    iconBox: 'bg-rose-50 dark:bg-rose-900/30 border-rose-100 dark:border-rose-800/50',
    searchRing: 'focus:ring-rose-400/50',
    searchIconFocus: 'group-focus-within/search:text-rose-400',
    addBtn: 'bg-rose-100 dark:bg-rose-900/40 text-rose-500 hover:bg-rose-200 dark:hover:bg-rose-900/60',
    hoverShadow: 'hover:shadow-rose-500/10',
  },
  blue: {
    headerText: 'text-blue-600 dark:text-blue-400',
    iconBox: 'bg-blue-50 dark:bg-blue-900/30 border-blue-100 dark:border-blue-800/50',
    searchRing: 'focus:ring-blue-500/50',
    searchIconFocus: 'group-focus-within/search:text-blue-500',
    addBtn: 'bg-blue-100 dark:bg-blue-900/40 text-blue-600 hover:bg-blue-200 dark:hover:bg-blue-900/60',
    hoverShadow: 'hover:shadow-blue-500/10',
  },
};

const TransactionListCard = ({
  accent = 'emerald',
  Icon,
  title,
  titleClassName,
  onAdd,
  addTitle,
  headerTotalText,
  recordsCount,
  showRecords,
  searchValue,
  onSearchChange,
  searchPlaceholder,
  labelHeader,
  footerLabel,
  footerTotalText,
  data,
  visibleCount,
  onSeeMore,
  renderRow,
}) => {
  const { t } = useTranslation();
  const a = ACCENTS[accent] ?? ACCENTS.emerald;

  return (
    // Estilo de tarjeta común (Dashboard): antes rounded-4xl, degradado y sombra grande.
    <div className="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-2xl overflow-hidden shadow-xs relative group">
      <div className="p-4 border-b border-slate-100 dark:border-slate-800 space-y-3">
        <div className="flex items-center justify-between">
          <div className={`flex items-center gap-2 ${a.headerText}`}>
            <div className={`p-1.5 rounded-lg border ${a.iconBox}`}>
              {Icon && <Icon className="w-4 h-4" />}
            </div>
            <h3 className={`text-sm font-bold text-slate-900 dark:text-white ${titleClassName || ''}`}>{title}</h3>
          </div>
          <div className="flex items-center gap-3">
            {onAdd && (
              <button onClick={onAdd} className={`p-1.5 rounded-lg transition-colors ${a.addBtn}`} title={addTitle}>
                <Plus className="w-3.5 h-3.5" />
              </button>
            )}
            <div className={`text-sm font-black ${a.headerText} tabular-nums`}>
              {headerTotalText}
              {showRecords && <span className="text-[10px] text-slate-400 ml-1.5 font-bold tracking-wide">({t('cartera.records_abbr', { n: recordsCount })})</span>}
            </div>
          </div>
        </div>
        <div className="relative group/search">
          <Search className={`absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 ${a.searchIconFocus} transition-colors`} />
          <input
            value={searchValue}
            onChange={e => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            className={`w-full pl-9 pr-9 py-2 text-xs font-medium border border-slate-200/80 dark:border-slate-700/80 rounded-xl bg-white/80 dark:bg-slate-800/80 text-slate-900 dark:text-white outline-hidden focus:ring-2 ${a.searchRing} transition-all shadow-xs placeholder-slate-400`}
          />
          {searchValue && (
            <button onClick={() => onSearchChange('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50/80 dark:bg-slate-800/50 text-[10px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 border-b border-slate-200/50 dark:border-slate-700/50">
              <th className="px-4 py-3.5 text-left">{t('cartera.date')}</th>
              <th className="px-4 py-3.5 text-left">{labelHeader}</th>
              <th className="px-4 py-3.5 text-right">{t('cartera.amount')}</th>
              <th className="px-4 py-3.5 text-center w-14"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
            {data.length === 0 && (
              <tr><td colSpan="4" className="px-3 py-8 text-center text-slate-400 italic text-xs">{t('cartera.no_results')}</td></tr>
            )}
            {data.slice(0, visibleCount).map((item, i) => renderRow(item, i))}
            {data.length > visibleCount && (
              <tr>
                <td colSpan="3" className="p-0">
                  <button
                    onClick={onSeeMore}
                    className="w-full py-3 text-[10px] font-bold text-blue-600 hover:bg-blue-50/50 transition-colors uppercase flex items-center justify-center gap-1"
                  >
                    <Plus className="w-3 h-3" /> {t('cartera.see_more', { n: data.length - visibleCount })}
                  </button>
                </td>
              </tr>
            )}
            {data.length > 0 && (
              <tr className="bg-slate-50/50 dark:bg-slate-800/30 font-bold border-t border-slate-200 dark:border-slate-700">
                <td colSpan="2" className="px-3 py-3 text-right text-[10px] uppercase text-slate-500">{footerLabel}:</td>
                <td className={`px-3 py-3 text-right ${a.headerText} text-xs`}>{footerTotalText}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default TransactionListCard;
