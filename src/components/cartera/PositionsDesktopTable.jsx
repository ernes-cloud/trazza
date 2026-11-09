import React from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, DollarSign, Edit, Trash2, History as HistoryIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { appLocale, formatMoney as formatPublicMoney } from '@/lib/formatters';
import { usePrivateFormatters } from '@/hooks/usePrivateFormatters';
import { parseIsoDateLocal } from '@/lib/dates';
import { isCashPosition } from '@/lib/positionKind';
import {
  computePositionRowMetrics, computeTargetMetrics, resolveCashTarget,
} from '@/services/positionRowMetrics';
import { assetDisplayName } from '@/services/assetDisplayName';

/**
 * Desktop positions table (hidden below md): total-target row, position rows
 * with G/P breakdown + allocation bullet chart, expandable per-row detail
 * (G/P panel + transaction history) and the consolidated liquidity row.
 * Pure presentation over the shared row-metrics service — edit (which fetches
 * the last BUY date) and delete are parent callbacks.
 */
const PositionsDesktopTable = ({
  positions,
  isGeneralView,
  preferredCurrency,
  exchangeRates,
  assetHistoricalCost,
  stats,
  expandedAssetTicker,
  onToggleExpand,
  onOpenAsset,
  onEditPosition,
  onDeletePosition,
  assetTransactions,
}) => {
  const { t } = useTranslation();
  // Enmascarados en modo privacidad (ver hooks/usePrivateFormatters).
  const { formatNumber, formatMoney, formatPercent } = usePrivateFormatters();
  const isCashPos = isCashPosition;

  return (
    <div className="hidden md:block overflow-x-auto text-slate-900 dark:text-slate-100">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-50/80 dark:bg-slate-800/50 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
            <th className="px-4 py-3 text-left font-semibold uppercase tracking-wider text-[10px]">{t('cartera.asset')}</th>
            <th className="px-3 py-3 text-left font-semibold uppercase tracking-wider text-[10px]">{t('cartera.gain_breakdown')}</th>
            <th className="px-4 py-3 text-right font-semibold uppercase tracking-wider text-[10px]">{t('cartera.qty')}</th>
            <th className="px-4 py-3 text-right font-semibold uppercase tracking-wider text-[10px] cursor-help" title={t('cartera.bep_hint')}>{t('cartera.bep')}</th>
            <th className="px-4 py-3 text-right font-semibold uppercase tracking-wider text-[10px]">{t('cartera.current_price')}</th>
            <th className="px-4 py-3 text-right font-semibold uppercase tracking-wider text-[10px]">{t('cartera.total_value')}</th>
            <th className="px-4 py-3 text-right font-semibold uppercase tracking-wider text-[10px]">{t('cartera.return')}</th>
            {isGeneralView && <th className="px-4 py-3 text-right font-semibold uppercase tracking-wider text-[10px]">{t('cartera.allocation')}</th>}
            {!isGeneralView && <th className="px-4 py-3 w-10"></th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {isGeneralView && (() => {
            const { cashTarget } = resolveCashTarget(positions, preferredCurrency);
            const totalTarget = positions.filter(p => !isCashPos(p))
              .reduce((sum, p) => sum + (parseFloat(p.target_percentage) || 0), 0) + cashTarget;
            const targetColor = totalTarget === 100 ? 'text-emerald-500' : totalTarget > 100 ? 'text-rose-500' : 'text-amber-500';
            return (
              <tr className="bg-slate-50 dark:bg-slate-800/40 font-bold border-b-2 border-slate-200 dark:border-slate-800">
                <td colSpan={7} className="px-4 py-3 text-right text-slate-400 dark:text-slate-500 uppercase text-[10px] tracking-wider">{t('cartera.total_target')}:</td>
                <td className={`px-4 py-3 text-right text-sm font-extrabold ${targetColor}`}>{formatNumber(totalTarget, 1, 1)}%</td>
              </tr>
            );
          })()}

          {positions?.filter(pos => !isCashPos(pos)).map((pos) => {
            const isExpanded = expandedAssetTicker === pos.assets?.ticker;
            // Shared row math with the mobile list — services/positionRowMetrics
            // (FIFO → AVCO → entry-price cost basis + DeGiro-style G/P split).
            const {
              currentPrice, fxRate, valConverted, valNative: val, showNativeCurrency,
              prefCostTotal, gainPct, profitConverted, gpProducto, gpMoneda, gpObtenida,
              priceUp, priceDown, isPositive,
            } = computePositionRowMetrics(pos, { preferredCurrency, exchangeRates, assetHistoricalCost });

            return (
              <React.Fragment key={isGeneralView ? `gen-${pos.asset_id}` : pos.id}>
                <tr
                  className="group hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors cursor-pointer"
                  onClick={() => onToggleExpand(pos)}
                >
                  {/* Asset cell — absorbs date as tertiary */}
                  <td className="px-4 py-3">
                    <div className="flex items-start gap-2">
                      <div className="mt-1 shrink-0 text-slate-300 dark:text-slate-600 group-hover:text-slate-400 transition-colors">
                        {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); onOpenAsset(pos.assets?.ticker); }}
                        className="text-left min-w-0"
                      >
                        <div className="font-bold text-sm text-slate-900 dark:text-white hover:underline decoration-dotted underline-offset-2 leading-snug">
                          {assetDisplayName(pos.assets) || pos.assets?.isin || '—'}
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                          <span className="text-[10px] text-slate-400 font-mono">{pos.assets?.ticker}</span>
                          {pos.assets?.currency && (
                            <span className="text-[9px] px-1 py-px bg-slate-100 dark:bg-slate-800 rounded font-medium text-slate-500 dark:text-slate-400">
                              {pos.assets.currency}
                            </span>
                          )}
                        </div>
                      </button>
                    </div>
                  </td>

                  {/* G/P Breakdown — always-visible decomposition replacing Clasif. */}
                  <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                    <div className="flex flex-col gap-0.5">
                      {/* G/P Produto — always computable from entry_price */}
                      {gpProducto !== null && (
                        <div className="flex items-center gap-1 text-[10px] tabular-nums">
                          <span className="text-slate-400 dark:text-slate-500 w-14 shrink-0 cursor-help" title={t('cartera.breakdown_price_hint')}>{t('cartera.breakdown_price')}</span>
                          <span className={gpProducto >= 0 ? 'text-emerald-600 dark:text-emerald-400 font-semibold' : 'text-rose-500 dark:text-rose-400 font-semibold'}>
                            {formatMoney(gpProducto, preferredCurrency, { sign: true, decimals: 0 })}
                          </span>
                        </div>
                      )}
                      {/* G/P Moneda — only when historical cost available */}
                      {gpMoneda !== null ? (
                        <div className="flex items-center gap-1 text-[10px] tabular-nums">
                          <span className="text-slate-400 dark:text-slate-500 w-14 shrink-0 cursor-help" title={t('cartera.breakdown_fx_hint')}>{t('cartera.breakdown_fx')}</span>
                          <span className={gpMoneda >= 0 ? 'text-emerald-600 dark:text-emerald-400 font-semibold' : 'text-rose-500 dark:text-rose-400 font-semibold'}>
                            {formatMoney(gpMoneda, preferredCurrency, { sign: true, decimals: 0 })}
                          </span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 text-[10px]">
                          <span className="text-slate-400 dark:text-slate-500 w-14 shrink-0 cursor-help" title={t('cartera.breakdown_fx_hint')}>{t('cartera.breakdown_fx')}</span>
                          <span className="text-slate-300 dark:text-slate-600">—</span>
                        </div>
                      )}
                      {/* G/P Obtenida — realized gain from FIFO */}
                      {gpObtenida !== null && gpObtenida !== 0 && (
                        <div className="flex items-center gap-1 text-[10px] tabular-nums">
                          <span className="text-slate-400 dark:text-slate-500 w-14 shrink-0 cursor-help" title={t('cartera.breakdown_realized_hint')}>{t('cartera.breakdown_realized')}</span>
                          <span className={gpObtenida >= 0 ? 'text-sky-600 dark:text-sky-400 font-semibold' : 'text-rose-500 dark:text-rose-400 font-semibold'}>
                            {formatMoney(gpObtenida, preferredCurrency, { sign: true, decimals: 0 })}
                          </span>
                        </div>
                      )}
                    </div>
                  </td>

                  {/* Quantity */}
                  <td className="px-4 py-3 text-right tabular-nums text-sm text-slate-600 dark:text-slate-300 font-medium">
                    {formatNumber(parseFloat(pos.quantity), 0, 8)}
                  </td>

                  {/* Avg Price — muted, native currency */}
                  <td className="px-4 py-3 text-right tabular-nums">
                    <span className="text-sm text-slate-400 dark:text-slate-500">
                      {formatMoney(pos.entry_price, pos.assets?.currency, { decimals: 2 })}
                    </span>
                  </td>

                  {/* Current Price — colored directionally vs avg */}
                  <td className="px-4 py-3 text-right tabular-nums">
                    <div className="flex flex-col items-end gap-px">
                      <span className={`text-sm font-bold ${priceUp ? 'text-emerald-600 dark:text-emerald-400' : priceDown ? 'text-rose-500 dark:text-rose-400' : 'text-slate-700 dark:text-slate-200'}`}>
                        {/* Precio de mercado: público, se ve también en privacidad */}{formatPublicMoney(currentPrice, pos.assets?.currency, { decimals: 2 })}
                      </span>
                      {/* Fondo con NAV de otro día: se dice de cuál (si no, no cuadra con el broker y nada lo explica) */}
                      {pos._priceDate && (() => {
                        const date = parseIsoDateLocal(pos._priceDate)?.toLocaleDateString(appLocale(), { day: 'numeric', month: 'short' });
                        return (
                          <span className="text-[10px] font-medium text-slate-400 dark:text-slate-500" title={t('cartera.price_as_of_hint', { date })}>
                            {t('cartera.price_as_of', { date })}
                          </span>
                        );
                      })()}
                    </div>
                  </td>

                  {/* Total Value — preferred currency primary, native secondary, weight tertiary */}
                  <td className="px-4 py-3 text-right tabular-nums">
                    <div className="font-extrabold text-sm text-slate-900 dark:text-white">
                      {formatMoney(valConverted, preferredCurrency, { decimals: 2 })}
                    </div>
                    {showNativeCurrency && (
                      <div className="text-[10px] text-slate-400 dark:text-slate-500 mt-px">
                        {formatMoney(val, pos.assets?.currency, { decimals: 2 })}
                      </div>
                    )}
                    {stats.current > 0 && !isGeneralView && (
                      <div className="text-[10px] font-bold text-blue-500 dark:text-blue-400 mt-0.5 tabular-nums">
                        {formatNumber((valConverted / stats.current) * 100, 1, 1)}%
                      </div>
                    )}
                  </td>

                  {/* Rentabilidad — merged badge (% + profit) */}
                  <td className="px-4 py-3 text-right">
                    <div className={`inline-flex flex-col items-end gap-0.5 px-2.5 py-1.5 rounded-lg ${isPositive ? 'bg-emerald-50 dark:bg-emerald-900/20' : 'bg-rose-50 dark:bg-rose-900/15'}`}>
                      <span className={`text-sm font-extrabold tabular-nums ${isPositive ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                        {formatPercent(gainPct, 2, { sign: true })}
                      </span>
                      <span className={`text-[10px] font-semibold tabular-nums ${isPositive ? 'text-emerald-500 dark:text-emerald-500/80' : 'text-rose-400 dark:text-rose-500/80'}`}>
                        {formatMoney(profitConverted, preferredCurrency, { sign: true, decimals: 2 })}
                      </span>
                    </div>
                  </td>

                  {/* Asignación — bullet chart (general view) */}
                  {isGeneralView && (() => {
                    const { currentWeight, target, fillPct, isOver, isUnder, drift, moneyDelta } =
                      computeTargetMetrics(val * fxRate, pos.target_percentage, stats.current);
                    return (
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <div className="flex flex-col gap-1.5 min-w-[130px]">
                          {/* Target (read-only — edit it from the Rebalancing screen) */}
                          <div className="flex items-center justify-end gap-1">
                            <span className="text-[9px] text-slate-400 uppercase tracking-wide shrink-0">{t('cartera.target')}</span>
                            <span className="text-[11px] font-bold tabular-nums text-slate-700 dark:text-slate-300">{formatNumber(pos.target_percentage || 0, 1, 1)}</span>
                            <span className="text-[10px] text-slate-400">%</span>
                          </div>
                          {/* Bullet bar */}
                          <div className="relative h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all duration-500 ${isOver ? 'bg-amber-400 dark:bg-amber-500' : isUnder ? 'bg-blue-400 dark:bg-blue-500' : 'bg-emerald-400 dark:bg-emerald-500'}`}
                              style={{ width: `${Math.min(fillPct, 100)}%` }}
                            />
                          </div>
                          {/* Actual % + drift + money delta */}
                          <div className="flex items-center justify-between text-[9px] tabular-nums">
                            <span className={`font-semibold ${isOver ? 'text-amber-500' : isUnder ? 'text-blue-500 dark:text-blue-400' : 'text-emerald-500'}`}>
                              {t('cartera.weight_now', { pct: formatPercent(currentWeight, 1) })}
                            </span>
                            {target > 0 && (
                              <span className={`font-bold ${isOver ? 'text-amber-500' : isUnder ? 'text-blue-500 dark:text-blue-400' : 'text-slate-400'}`}>
                                {formatPercent(drift, 1, { sign: true })}
                              </span>
                            )}
                          </div>
                          {moneyDelta != null && Math.abs(moneyDelta) > 1 && (
                            <div className={`text-[9px] font-bold tabular-nums text-right ${moneyDelta > 0 ? 'text-blue-500 dark:text-blue-400' : 'text-amber-500'}`}>
                              {/* Igual que en móvil: "Comprar 1.556 €" en vez de un "+€1.556" sin explicar */}
                              {moneyDelta > 0 ? t('cartera.buy') : t('cartera.sell_action')} {formatMoney(Math.abs(moneyDelta), preferredCurrency, { decimals: 0 })}
                            </div>
                          )}
                        </div>
                      </td>
                    );
                  })()}
                  {!isGeneralView && (
                    <td className="px-5 py-4 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon" onClick={(e) => {
                          e.stopPropagation();
                          onEditPosition(pos);
                        }} className="text-slate-300 hover:text-blue-500 h-7 w-7"><Edit className="w-3.5 h-3.5" /></Button>
                        <Button variant="ghost" size="icon" onClick={(e) => {
                          e.stopPropagation();
                          onDeletePosition(pos);
                        }} className="text-slate-300 hover:text-red-500 h-7 w-7"><Trash2 className="w-3.5 h-3.5" /></Button>
                      </div>
                    </td>
                  )}
                </tr>
                {isExpanded && (
                  <tr className="bg-slate-50/50 dark:bg-slate-800/20">
                    <td colSpan={8} className="px-5 py-5">
                      <div className="animate-in fade-in slide-in-from-top-2 duration-300">
                        {/* G/P Breakdown — computed directly from loaded BUY transactions.
                            Uses eur_total (historical EUR paid) for FX split when available. */}
                        {pos.entry_price != null && (() => {
                          const heldQty = parseFloat(pos.quantity || 0);

                          // Prefer FIFO _prefCostTotal (computed upfront from all transactions).
                          // Fall back to pipeline _histCost, then lazily-loaded assetHistoricalCost.
                          const histCostData = pos._histCost || assetHistoricalCost[pos.asset_id];
                          const lazyHistCost = histCostData && histCostData.totalBoughtQty > 0
                            ? histCostData.totalHistCost * (heldQty / histCostData.totalBoughtQty)
                            : 0;
                          const historicalPrefCost = prefCostTotal > 0 ? prefCostTotal : lazyHistCost;

                          const panelGpPotencial = historicalPrefCost > 0
                            ? valConverted - historicalPrefCost
                            : profitConverted;
                          const panelGpProducto = heldQty * (currentPrice - pos.entry_price) * fxRate;
                          const panelGpMoneda = historicalPrefCost > 0
                            ? panelGpPotencial - panelGpProducto
                            : null;
                          const panelGpObtenida = gpObtenida;

                          return (
                            <div className="mb-5">
                              <div className="flex items-center gap-2 mb-2">
                                <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">{t('cartera.gain_breakdown')}</span>
                                {panelGpMoneda === null && (
                                  <span className="text-[9px] text-amber-500 font-semibold">· {t('cartera.no_fifo_note')}</span>
                                )}
                              </div>
                              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                                {[
                                  { label: t('cartera.gp_potencial'), value: panelGpPotencial, show: true },
                                  { label: t('cartera.gp_producto'), value: panelGpProducto, show: true },
                                  { label: t('cartera.gp_moneda'), value: panelGpMoneda, show: panelGpMoneda !== null },
                                  { label: t('cartera.gp_obtenida'), value: panelGpObtenida, show: panelGpObtenida !== null },
                                ].filter(item => item.show).map(({ label, value }) => {
                                  const isPos = value >= 0;
                                  return (
                                    <div key={label} className="bg-white dark:bg-slate-800 rounded-xl border border-slate-100 dark:border-slate-700 px-3 py-2.5 flex flex-col gap-0.5">
                                      <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400">{label}</span>
                                      <span className={`text-sm font-extrabold tabular-nums ${isPos ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                                        {formatMoney(value, preferredCurrency, { sign: true, decimals: 2 })}
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })()}
                        <div className="flex items-center gap-2 mb-4 text-slate-500 text-[10px] font-black uppercase tracking-wider">
                          <HistoryIcon className="w-3 h-3" /> {t('cartera.tx_history')}: {pos.assets?.ticker}
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                          {(assetTransactions[pos.asset_id] || [])
                            .filter(tx => {
                              if (!pos.assets?.isin || !tx.notes) return true;
                              // If notes contain an ISIN "(XX000000000Y)", only keep if it matches this asset
                              const isinInNotes = tx.notes.match(/\(([A-Z]{2}[A-Z0-9]{9}[0-9])\)/);
                              return !isinInNotes || isinInNotes[1] === pos.assets.isin;
                            })
                            .map((tx) => (
                            <div key={tx.id} className="bg-white dark:bg-slate-800 p-3 rounded-xl border border-slate-100 dark:border-slate-700 shadow-xs flex flex-col gap-1">
                              <div className="flex justify-between items-center">
                                <span className="text-[10px] text-slate-400 font-bold">{tx.transaction_date.split('T')[0].split('-').reverse().join('-')}</span>
                                <span className={`text-[10px] font-black px-2 py-0.5 rounded-md ${tx.transaction_type === 'BUY' ? 'bg-green-100 text-green-600 dark:bg-green-900/30' : tx.transaction_type === 'SELL' ? 'bg-red-100 text-red-600 dark:bg-red-900/30' : 'bg-blue-100 text-blue-600 dark:bg-blue-900/30'}`}>
                                  {t(`transaction_types.${tx.transaction_type}`, { defaultValue: tx.transaction_type })}
                                </span>
                              </div>
                              <div className="flex justify-between items-baseline">
                                <span className="text-xs font-medium text-slate-500">
                                  {parseFloat(tx.quantity) > 0 ? `${tx.quantity} x ${formatMoney(tx.price, pos.assets?.currency, { decimals: 2 })}` : null}
                                </span>
                                <span className="font-bold text-slate-900 dark:text-white">{formatMoney(tx.total_amount, pos.assets?.currency, { decimals: 2 })}</span>
                              </div>
                              {tx.notes && <div className="text-[10px] text-slate-400 italic truncate mt-1">"{tx.notes}"</div>}
                            </div>
                          ))}
                          {(!assetTransactions[pos.asset_id] || assetTransactions[pos.asset_id].length === 0) && (
                            <div className="col-span-full py-4 text-center text-xs text-slate-400 italic">{t('cartera.no_transactions')}</div>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}

          {isGeneralView && (
          <tr className="bg-blue-50/20 dark:bg-blue-900/5 font-bold border-t-2 border-slate-100 dark:border-slate-800">
            <td className="px-4 py-3">
              <div className="flex items-center gap-2.5">
                <div className="p-1.5 rounded-lg bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 shrink-0">
                  <DollarSign className="w-3.5 h-3.5" />
                </div>
                <div className="flex flex-col text-left">
                  <span className="font-bold text-xs text-blue-600 dark:text-blue-400 uppercase tracking-tight">{t('cartera.liquidity_label')}</span>
                  <span className="text-[9px] text-slate-400 font-normal">{t('cartera.consolidated')}</span>
                </div>
              </div>
            </td>
            <td className="px-3 py-3 text-slate-400">—</td>
            <td className="px-4 py-3 text-right text-slate-400">—</td>
            <td className="px-4 py-3 text-right text-slate-400">—</td>
            <td className="px-4 py-3 text-right text-slate-400">—</td>
            <td className="px-4 py-3 text-right">
              <span className="font-extrabold text-base text-blue-600 dark:text-blue-400 tabular-nums">
                {formatMoney(stats.totalCash, preferredCurrency, { decimals: 2 })}
              </span>
            </td>
            <td className="px-4 py-3 text-right text-slate-400">—</td>
            {isGeneralView ? (
              (() => {
                const { cashTarget } = resolveCashTarget(positions, preferredCurrency);
                const { currentWeight: cashWeight, fillPct, isOver, isUnder, drift, moneyDelta: cashDelta } =
                  computeTargetMetrics(stats.totalCash, cashTarget, stats.current);
                return (
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <div className="flex flex-col gap-1.5 min-w-[120px]">
                      <div className="flex items-center justify-end gap-1">
                        <span className="text-[9px] text-slate-400 uppercase tracking-wide shrink-0">{t('cartera.target')}</span>
                        <span className="text-[11px] font-bold tabular-nums text-slate-700 dark:text-slate-300">{formatNumber(cashTarget, 1, 1)}</span>
                        <span className="text-[10px] text-slate-400">%</span>
                      </div>
                      <div className="relative h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${isOver ? 'bg-amber-400 dark:bg-amber-500' : isUnder ? 'bg-blue-400 dark:bg-blue-500' : 'bg-emerald-400 dark:bg-emerald-500'}`}
                          style={{ width: `${Math.min(fillPct, 100)}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-[9px] tabular-nums">
                        <span className={`font-semibold ${isOver ? 'text-amber-500' : isUnder ? 'text-blue-500 dark:text-blue-400' : 'text-emerald-500'}`}>
                          {formatNumber(cashWeight, 1, 1)}%
                        </span>
                        {cashTarget > 0 && (
                          <span className={`font-bold ${isOver ? 'text-amber-500' : isUnder ? 'text-blue-500 dark:text-blue-400' : 'text-slate-400'}`}>
                            {formatPercent(drift, 1, { sign: true })}
                          </span>
                        )}
                      </div>
                      {cashDelta != null && Math.abs(cashDelta) > 1 && (
                        <div className={`text-[9px] font-bold tabular-nums text-right mt-0.5 ${cashDelta > 0 ? 'text-blue-500 dark:text-blue-400' : 'text-amber-500'}`}>
                          {formatMoney(cashDelta, preferredCurrency, { sign: true, decimals: 0 })}
                        </div>
                      )}
                    </div>
                  </td>
                );
              })()
            ) : (
              <td className="px-4 py-3 text-right text-slate-400">—</td>
            )}
          </tr>
          )}
        </tbody>
      </table>
    </div>
  );
};

export default PositionsDesktopTable;
