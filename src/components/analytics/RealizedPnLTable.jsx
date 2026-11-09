import React from 'react';
import { localTodayIso } from '@/lib/dates';
import { useTranslation } from 'react-i18next';
import { TrendingDown, Edit, Trash2, AlertTriangle, ArrowUpRight, ArrowDownRight, Plus, Search, X } from 'lucide-react';
// Los formateadores comunes (idioma de la app, separador de miles siempre):
// esta tabla tenía los suyos y enseñaba "+1200,56€" y "$5550,00".
import { getCurrencySymbol } from '@/lib/formatters';
import { usePrivateFormatters } from '@/hooks/usePrivateFormatters';

const RealizedPnLTable = ({
  salesWithPL,
  exchangeRates,
  visibleSales,
  setVisibleSales,
  setIsAddSaleOpen,
  setManualSale,
  handleDeleteTransaction,
  selectedBrokerId,
  totals,
  preferredCurrency,
  filteredTotal,
  search = '',
  setSearch,
  totalCount = 0,
}) => {
  const { t } = useTranslation();
  // Enmascarados en modo privacidad (ver hooks/usePrivateFormatters).
  const { formatNumber, formatMoney } = usePrivateFormatters();
  const hasSales = salesWithPL && salesWithPL.length > 0;
  const displayTotal = filteredTotal !== undefined ? filteredTotal : totals.salesTotal;
  const isFiltered = salesWithPL?.length !== totalCount && totalCount > 0;

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-2xl overflow-hidden shadow-xs relative group">
      <div className="p-4 border-b border-slate-100 dark:border-slate-800 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-orange-600 dark:text-orange-500">
            <div className="p-1.5 bg-orange-50 dark:bg-orange-900/30 rounded-lg border border-orange-100 dark:border-orange-800/50">
              <TrendingDown className="w-4 h-4" />
            </div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">{t('analytics.realized_pnl.title')}</h3>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-xs font-bold flex gap-3 items-center">
              <span className="text-slate-500 uppercase tracking-tight hidden sm:inline">{t('analytics.realized_pnl.fifo_label')}</span>
              <span className={`text-sm font-black tabular-nums ${displayTotal >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                {formatMoney(displayTotal, preferredCurrency, { sign: true })}
              </span>
              {isFiltered && (
                <span className="text-[10px] text-slate-400 font-bold tracking-wide">({t('analytics.realized_pnl.remaining', { n: salesWithPL.length })})</span>
              )}
            </div>
            {selectedBrokerId !== 'general' && (
              <button
                onClick={() => {
                  setManualSale({
                    id: null,
                    positionId: '',
                    quantity: 0,
                    price: 0,
                    date: localTodayIso(),
                    notes: '',
                    commission: 0
                  });
                  setIsAddSaleOpen(true);
                }}
                className="p-1.5 rounded-lg bg-orange-100 dark:bg-orange-900/40 text-orange-600 hover:bg-orange-200 dark:hover:bg-orange-900/60 transition-colors"
                title={t('analytics.realized_pnl.manual_sale')}
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
        <div className="relative group/search">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 group-focus-within/search:text-orange-500 transition-colors" />
          <input
            value={search}
            onChange={e => setSearch && setSearch(e.target.value)}
            placeholder={t('analytics.realized_pnl.search_placeholder')}
            className="w-full pl-9 pr-9 py-2 text-xs font-medium border border-slate-200/80 dark:border-slate-700/80 rounded-xl bg-white/80 dark:bg-slate-800/80 text-slate-900 dark:text-white outline-hidden focus:ring-2 focus:ring-orange-500/50 transition-all shadow-xs placeholder-slate-400"
          />
          {search && (
            <button onClick={() => setSearch && setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50/80 dark:bg-slate-800/50 text-[10px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 border-b border-slate-200/50 dark:border-slate-700/50">
              <th className="px-5 py-3.5 text-left">{t('analytics.realized_pnl.date_time')}</th>
              <th className="px-5 py-3.5 text-left">{t('analytics.realized_pnl.asset')}</th>
              <th className="px-5 py-3.5 text-right">{t('analytics.realized_pnl.quantity')}</th>
              <th className="px-5 py-3.5 text-right">{t('analytics.realized_pnl.buy_price')}</th>
              <th className="px-5 py-3.5 text-right">{t('analytics.realized_pnl.sell_price')}</th>
              <th className="px-5 py-3.5 text-right">{t('analytics.realized_pnl.total_sell')}</th>
              <th className="px-5 py-3.5 text-right">{t('analytics.realized_pnl.result')} ({getCurrencySymbol(preferredCurrency)})</th>
              <th className="px-5 py-3.5 text-right">{t('analytics.realized_pnl.yield')}</th>
              <th className="px-5 py-3.5 text-center w-20">{t('analytics.realized_pnl.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
            {!hasSales && (
              <tr>
                <td colSpan="9" className="px-5 py-10 text-center text-slate-400 italic">
                  {search ? t('analytics.realized_pnl.no_sales_search') : t('analytics.realized_pnl.no_sales')}
                </td>
              </tr>
            )}
            {hasSales && salesWithPL.slice(0, visibleSales).map((row, i) => {
              const profitConverted = row.profit * (exchangeRates[row.moneda || 'EUR'] || 1);
              const isProfit = row.profit >= 0;
              const colorClass = isProfit ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400';

              return (
                <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors group">
                  <td className="px-5 py-3 text-slate-500">
                    <div>{row.fecha}</div>
                    <div className="text-[10px]">{row.hora}</div>
                  </td>
                  <td className="px-5 py-3">
                    <div className="font-bold flex items-center gap-2">
                      {row.nombre || row.producto}
                      {row.isMissingBuyData && (
                        <span title={t('analytics.realized_pnl.missing_buy_tooltip')} className="text-amber-500 cursor-help">
                          <AlertTriangle className="w-3.5 h-3.5" />
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-slate-400 font-mono">{row.isin || row.producto}</div>
                    {row.classification && (
                      <div className="mt-1">
                        <span className="text-[9px] px-1 py-0.5 bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 rounded border border-orange-100 dark:border-orange-800 font-bold uppercase tracking-tighter">
                          {row.classification}
                        </span>
                      </div>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right">{formatNumber(row.cantidad, 2, 4)}</td>
                  <td className="px-5 py-3 text-right text-slate-400">
                    {formatMoney(row.avgBuyPrice, row.moneda || 'EUR')}
                    {row.sharesMissingHistory > 0 && (
                      <div className="text-[9px] text-amber-500 mt-0.5 leading-tight">
                        {t('analytics.realized_pnl.missing_cost', { n: formatNumber(row.sharesMissingHistory, 0, 4) })}
                      </div>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right font-medium">{formatMoney(row.precio, row.moneda || 'EUR')}</td>
                  <td className="px-5 py-3 text-right font-bold text-slate-600 dark:text-slate-300">
                    {formatMoney(row.total, row.moneda || 'EUR')}
                  </td>
                  <td className={`px-5 py-3 text-right font-bold ${colorClass}`}>
                    {formatMoney(profitConverted, preferredCurrency, { sign: true })}
                    {(row.moneda || 'EUR') !== preferredCurrency && (
                      <div className="text-[9px] opacity-70 mt-0.5 font-normal tracking-wide">
                        ({formatMoney(row.profit, row.moneda || 'EUR', { sign: true })})
                      </div>
                    )}
                  </td>
                  <td className={`px-5 py-3 text-right font-black ${isProfit ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                    <div className="flex items-center justify-end gap-1">
                      {isProfit ? <ArrowUpRight className="w-3.5 h-3.5" /> : <ArrowDownRight className="w-3.5 h-3.5" />}
                      <span>{row.profitPercent == null ? '—' : `${formatNumber(Math.abs(row.profitPercent), 2, 2)}%`}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-center">
                    {row.isFromDB && (
                      <div className="flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => {
                            setManualSale({
                              id: row.id,
                              positionId: row.position_id,
                              quantity: row.cantidad,
                              price: row.precio,
                              date: row.fecha.split('-').reverse().join('-'),
                              notes: row.notes || row.descripcion,
                              commission: 0
                            });
                            setIsAddSaleOpen(true);
                          }}
                          className="p-1 text-slate-400 hover:text-blue-500 transition-colors"
                          title={t('analytics.realized_pnl.edit')}
                        >
                          <Edit className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDeleteTransaction(t)}
                          className="p-1 text-slate-400 hover:text-red-500 transition-colors"
                          title={t('analytics.realized_pnl.delete')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {hasSales && salesWithPL.length > visibleSales && (
              <tr>
                <td colSpan="9" className="p-0">
                  <button
                    onClick={() => setVisibleSales(prev => prev + 20)}
                    className="w-full py-4 text-xs font-bold text-blue-600 hover:bg-blue-50/50 dark:hover:bg-blue-900/10 transition-colors uppercase tracking-widest flex items-center justify-center gap-2"
                  >
                    <span>{t('analytics.realized_pnl.load_more')}</span>
                    <span className="bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-400 px-2 py-0.5 rounded-full text-[10px]">
                      {t('analytics.realized_pnl.remaining', { n: salesWithPL.length - visibleSales })}
                    </span>
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default RealizedPnLTable;
