import React from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, DollarSign } from 'lucide-react';
import { usePrivateFormatters } from '@/hooks/usePrivateFormatters';
import { isCashPosition } from '@/lib/positionKind';
import {
  computePositionRowMetrics, computeTargetMetrics, resolveCashTarget,
} from '@/services/positionRowMetrics';
import { assetDisplayName } from '@/services/assetDisplayName';

/**
 * Mobile card list of positions (visible below md), incl. total-target row,
 * per-position target editor (general view), expandable transaction list and
 * the liquidity card. Pure presentation over the shared row-metrics service —
 * all I/O (expand fetch, inline target persistence) happens via callbacks.
 */
const PositionsMobileList = ({
  positions,
  isGeneralView,
  preferredCurrency,
  exchangeRates,
  assetHistoricalCost,
  stats,
  expandedAssetTicker,
  onToggleExpand,
  onOpenAsset,
  assetTransactions,
  maskMoney,
}) => {
  const { t } = useTranslation();
  // Enmascarados en modo privacidad (ver hooks/usePrivateFormatters).
  const { formatNumber, formatMoney, formatPercent } = usePrivateFormatters();
  const isCashPos = isCashPosition;

  return (
    <div className="md:hidden flex flex-col gap-2 p-2 bg-slate-50 dark:bg-slate-900/50">
      {isGeneralView && (() => {
        const { cashTarget } = resolveCashTarget(positions, preferredCurrency);
        const totalTarget = positions.filter(p => !isCashPos(p))
          .reduce((sum, p) => sum + (parseFloat(p.target_percentage) || 0), 0) + cashTarget;
        const targetColor = totalTarget === 100 ? 'text-emerald-500' : totalTarget > 100 ? 'text-rose-500' : 'text-amber-500';
        return (
          <div className="px-4 py-2.5 bg-white dark:bg-slate-800 rounded-xl border border-slate-200/60 dark:border-slate-700 shadow-xs flex justify-between items-center mx-1">
            <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">{t('cartera.total_target')}</span>
            <span className={`text-sm font-extrabold ${targetColor}`}>{formatNumber(totalTarget, 1, 1)}%</span>
          </div>
        );
      })()}

      {positions?.filter(pos => !isCashPos(pos)).map((pos) => {
        // Shared row math with the desktop table — services/positionRowMetrics
        const {
          currentPrice, valConverted, gainPct, profitConverted: profit,
        } = computePositionRowMetrics(pos, { preferredCurrency, exchangeRates, assetHistoricalCost });
        const isExpanded = expandedAssetTicker === pos.assets?.ticker;
        return (
          <div
            key={isGeneralView ? `mob-gen-${pos.asset_id}` : `mob-${pos.id}`}
            className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200/60 dark:border-slate-700 shadow-xs px-4 py-3 cursor-pointer mx-1 transition-all active:scale-[0.99] active:shadow-none"
            onClick={() => onToggleExpand(pos)}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-start gap-2 min-w-0">
                <div className="mt-1">
                  {isExpanded ? <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />}
                </div>
                <div className="min-w-0">
                  <button
                    className="font-bold text-[13px] leading-tight text-slate-900 dark:text-white truncate text-left w-full hover:text-blue-500"
                    onClick={(e) => { e.stopPropagation(); onOpenAsset(pos.assets?.ticker); }}
                  >
                    {assetDisplayName(pos.assets) || pos.assets?.isin || '—'}
                  </button>
                  <div className="text-[10px] text-slate-400 font-mono flex items-center gap-1.5 mt-0.5">
                    {pos.assets?.ticker}
                    {pos.assets?.currency && (
                      <span className="px-1 bg-slate-100 dark:bg-slate-700/50 rounded font-medium text-slate-500">{pos.assets.currency}</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-sm font-extrabold text-slate-900 dark:text-white tabular-nums">
                  {maskMoney(formatMoney(valConverted, preferredCurrency, { decimals: 2 }))}
                </div>
                <div className={`text-[11px] font-bold tabular-nums flex items-center justify-end gap-1 ${gainPct >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                  {gainPct >= 0 ? '▲' : '▼'} {formatNumber(Math.abs(gainPct), 1, 1)}%
                  <span className="font-normal text-[9px] opacity-70">
                    ({maskMoney(formatMoney(profit, preferredCurrency, { sign: true, decimals: 0 }))})
                  </span>
                </div>
                {stats.current > 0 && (
                  <div className="text-[10px] font-bold text-blue-500 dark:text-blue-400 tabular-nums mt-0.5">
                    {formatNumber((valConverted / stats.current) * 100, 1, 1)}%
                  </div>
                )}
              </div>
            </div>

            {/* Mobile Target UI */}
            {isGeneralView && (() => {
              const { currentWeight, target, fillPct, isOver, isUnder, drift, moneyDelta } =
                computeTargetMetrics(valConverted, pos.target_percentage, stats.current);
              return (
                <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-700/50" onClick={e => e.stopPropagation()}>
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-1.5 bg-slate-50 dark:bg-slate-900/40 px-2 py-1 rounded-lg border border-slate-100 dark:border-slate-800">
                      <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">{t('cartera.target')}</span>
                      <span className="text-[11px] font-black tabular-nums text-slate-700 dark:text-slate-300">{formatNumber(pos.target_percentage || 0, 1, 1)}</span>
                      <span className="text-[9px] text-slate-400 font-bold -ml-0.5">%</span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] tabular-nums">
                      <span className={`font-bold ${isOver ? 'text-amber-500' : isUnder ? 'text-blue-500 dark:text-blue-400' : 'text-emerald-500'}`}>
                        {t('cartera.weight_now', { pct: formatPercent(currentWeight, 1) })}
                      </span>
                      {target > 0 && (
                        <span className={`font-semibold ${isOver ? 'text-amber-500' : isUnder ? 'text-blue-500 dark:text-blue-400' : 'text-slate-400'}`}>
                          ({formatPercent(drift, 1, { sign: true })})
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="relative h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden mb-1">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${isOver ? 'bg-amber-400 dark:bg-amber-500' : isUnder ? 'bg-blue-400 dark:bg-blue-500' : 'bg-emerald-400 dark:bg-emerald-500'}`}
                      style={{ width: `${Math.min(fillPct, 100)}%` }}
                    />
                  </div>
                  {moneyDelta != null && Math.abs(moneyDelta) > 1 && (
                    <div className="flex justify-end">
                      <span className={`text-[9px] font-bold tabular-nums px-1.5 py-0.5 rounded ${moneyDelta > 0 ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400' : 'bg-amber-50 text-amber-600 dark:bg-amber-900/20 dark:text-amber-400'}`}>
                        {moneyDelta > 0 ? t('cartera.buy') : t('cartera.sell_action')} {formatMoney(Math.abs(moneyDelta), preferredCurrency, { decimals: 0 })}
                      </span>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Expanded transactions */}
            {isExpanded && (
              <div className="mt-3 ml-5 border-l-2 border-purple-200 dark:border-purple-800 pl-3 space-y-2 animate-in fade-in duration-200"
                onClick={(e) => e.stopPropagation()}>
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">{t('cartera.transactions')}</p>
                {(!assetTransactions[pos.asset_id] || assetTransactions[pos.asset_id].length === 0) ? (
                  <p className="text-xs text-slate-400 italic py-2">{t('cartera.no_transactions')}</p>
                ) : (
                  assetTransactions[pos.asset_id].filter(tx => {
                    if (!pos.assets?.isin || !tx.notes) return true;
                    const isinInNotes = tx.notes.match(/\(([A-Z]{2}[A-Z0-9]{9}[0-9])\)/);
                    return !isinInNotes || isinInNotes[1] === pos.assets.isin;
                  }).map((tx, ti) => (
                    <div key={ti} className="flex items-center justify-between text-[11px]">
                      <div className="flex items-center gap-2">
                        <span className={`px-1.5 py-0.5 rounded font-bold uppercase ${
                          tx.transaction_type === 'BUY' ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400' :
                          tx.transaction_type === 'SELL' ? 'bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-400' :
                          tx.transaction_type === 'DIVIDEND' ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400' :
                          'bg-slate-100 dark:bg-slate-800 text-slate-500'
                        }`}>{t(`transaction_types.${tx.transaction_type}`, { defaultValue: tx.transaction_type })}</span>
                        <span className="text-slate-500">{(tx.transaction_date || '').split('T')[0]}</span>
                      </div>
                      <div className="text-right text-slate-600 dark:text-slate-300 tabular-nums">
                        {parseFloat(tx.quantity) > 0 ? (
                          <span>{formatNumber(tx.quantity, 2, 4)} × {formatMoney(tx.price, pos.assets?.currency, { decimals: 2 })}</span>
                        ) : tx.total_amount != null ? (
                          <span>{formatMoney(Math.abs(tx.total_amount), pos.assets?.currency, { decimals: 2 })}</span>
                        ) : null}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Mobile Cash Target Row */}
      {isGeneralView && (() => {
        const { cashTarget } = resolveCashTarget(positions, preferredCurrency);
        const { currentWeight: cashWeight, fillPct, isOver, isUnder, drift, moneyDelta: cashDelta } =
          computeTargetMetrics(stats.totalCash, cashTarget, stats.current);

        return (
          <div className="bg-blue-50/50 dark:bg-blue-900/10 rounded-xl border border-blue-100 dark:border-blue-900/30 shadow-xs px-4 py-3 mx-1 mb-2">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400">
                  <DollarSign className="w-4 h-4" />
                </div>
                <div className="font-bold text-[13px] text-blue-700 dark:text-blue-400">{t('cartera.liquidity')}</div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-sm font-extrabold text-blue-700 dark:text-blue-400 tabular-nums">
                  {formatMoney(stats.totalCash, preferredCurrency, { decimals: 2 })}
                </div>
              </div>
            </div>

            <div className="mt-3 pt-3 border-t border-blue-100 dark:border-blue-900/30">
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-1.5 bg-white dark:bg-slate-900/40 px-2 py-1 rounded-lg border border-blue-100 dark:border-blue-800">
                  <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">{t('cartera.target')}</span>
                  <span className="text-[11px] font-black tabular-nums text-slate-700 dark:text-slate-300">{formatNumber(cashTarget, 1, 1)}</span>
                  <span className="text-[9px] text-slate-400 font-bold -ml-0.5">%</span>
                </div>
                <div className="flex items-center gap-2 text-[10px] tabular-nums">
                  <span className={`font-bold ${isOver ? 'text-amber-500' : isUnder ? 'text-blue-500 dark:text-blue-400' : 'text-emerald-500'}`}>
                    {t('cartera.weight_now', { pct: formatPercent(cashWeight, 1) })}
                  </span>
                  {cashTarget > 0 && (
                    <span className={`font-semibold ${isOver ? 'text-amber-500' : isUnder ? 'text-blue-500 dark:text-blue-400' : 'text-slate-400'}`}>
                      ({formatPercent(drift, 1, { sign: true })})
                    </span>
                  )}
                </div>
              </div>
              <div className="relative h-1.5 bg-blue-100/50 dark:bg-slate-800 rounded-full overflow-hidden mb-1">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${isOver ? 'bg-amber-400 dark:bg-amber-500' : isUnder ? 'bg-blue-400 dark:bg-blue-500' : 'bg-emerald-400 dark:bg-emerald-500'}`}
                  style={{ width: `${Math.min(fillPct, 100)}%` }}
                />
              </div>
              {cashDelta != null && Math.abs(cashDelta) > 1 && (
                <div className="flex justify-end">
                  <span className={`text-[9px] font-bold tabular-nums px-1.5 py-0.5 rounded ${cashDelta > 0 ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' : 'bg-amber-50 text-amber-600 dark:bg-amber-900/20 dark:text-amber-400'}`}>
                    {cashDelta > 0 ? t('cartera.add_funds') : t('cartera.invest')} {formatMoney(Math.abs(cashDelta), preferredCurrency, { decimals: 0 })}
                  </span>
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
};

export default PositionsMobileList;
