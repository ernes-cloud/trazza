import React from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Coins, TrendingDown, Receipt, DollarSign, Download, Plus, Scale, FileText } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';

/**
 * Floating action bar (top-right): refresh prices, rebalance, tax report and a
 * single "add transactions" menu grouping every manual entry (dividend, sale,
 * commission, cash, position) plus the import/sync shortcut. Pure presentation —
 * every action is a callback composed in CarteraPage. The manual-entry menu and
 * import only render on a specific broker (not the general view).
 */
const PositionActionBar = ({
  refreshing,
  onRefresh,
  isGeneralView,
  isBrokerSaved,
  onOpenDividend,
  onOpenSale,
  onOpenCommission,
  onOpenCash,
  onOpenSync,
  onOpenImport,
  onOpenAddPosition,
  onOpenRebalance,
  onOpenTaxReport,
}) => {
  const { t } = useTranslation();
  const pill = 'flex items-center gap-1.5 bg-white/95 dark:bg-slate-800/95 backdrop-blur-md border rounded-full px-3 py-2 shadow-lg text-xs font-bold transition-colors';
  const menuItem = 'gap-2 cursor-pointer text-sm';

  return (
    <div className="fixed top-16 right-6 z-40 flex items-center gap-2 flex-wrap justify-end max-w-[calc(100vw-1.5rem)]">
      <button
        onClick={onRefresh}
        disabled={refreshing}
        className={`${pill} border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50`}
      >
        <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        <span className="hidden sm:inline">{t('cartera.refresh')}</span>
      </button>

      <button
        onClick={onOpenRebalance}
        className={`${pill} border-purple-200 dark:border-purple-800/40 text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20`}
      >
        <Scale className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">{t('cartera.rebalance_button')}</span>
      </button>

      <button
        onClick={onOpenTaxReport}
        className={`${pill} border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700`}
      >
        <FileText className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">{t('tax_report.open_button')}</span>
      </button>

      {/* In the general view these still show: the page asks which broker the
          action applies to before running it. */}
      {(isGeneralView || isBrokerSaved) ? (
        <button
          onClick={onOpenSync}
          className={`${pill} border-indigo-200 dark:border-indigo-700/50 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20`}
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">{t('cartera.sync_button')}</span>
        </button>
      ) : (
        <button
          onClick={onOpenImport}
          className={`${pill} border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700`}
        >
          <Download className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">{t('cartera.import')}</span>
        </button>
      )}

      {/* One entry point for every manual movement */}
      <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 rounded-full px-3 py-2 shadow-lg shadow-blue-500/25 text-xs font-bold text-white transition-colors">
                <Plus className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{t('cartera.add_transactions')}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onClick={onOpenDividend} className={menuItem}>
                <Coins className="w-4 h-4 text-emerald-500" />
                {t('cartera.dividend')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onOpenSale} className={menuItem}>
                <TrendingDown className="w-4 h-4 text-blue-500" />
                {t('cartera.sell')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onOpenCommission} className={menuItem}>
                <Receipt className="w-4 h-4 text-orange-500" />
                {t('cartera.commission')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onOpenCash} className={menuItem}>
                <DollarSign className="w-4 h-4 text-green-500" />
                {t('cartera.cash')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onOpenAddPosition} className={menuItem}>
                <Plus className="w-4 h-4 text-blue-600" />
                {t('cartera.position')}
              </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

export default PositionActionBar;
