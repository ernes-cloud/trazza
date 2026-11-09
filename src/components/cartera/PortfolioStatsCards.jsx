import React from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { HelpCircle } from 'lucide-react';
import { getCurrencySymbol } from '@/lib/formatters';
import { usePrivateFormatters } from '@/hooks/usePrivateFormatters';

/**
 * Header stat cards for the brokers screen (Valor en Mercado, Ganancia Total,
 * Rentabilidad) plus the cash-available pill. Pure presentation — all values
 * come pre-computed from portfolioStats / usePositions in CarteraPage.
 *
 * First extraction of the CarteraPage component split.
 */
export default function PortfolioStatsCards({
  stats,
  preferredCurrency,
  maskMoney,
  onExplainMetric,
  latentRoiPct,
  portfolioCagr,
  twrAllTime,
}) {
  const { t } = useTranslation();
  // Enmascarados en modo privacidad (ver hooks/usePrivateFormatters).
  const { formatNumber, formatMoney, formatPercent } = usePrivateFormatters();
  const sym = getCurrencySymbol(preferredCurrency);

  const gainChips = [
    { id: 'Latente (hoy)',      label: t('cartera.latent_today'),      value: stats.latentGain    },
    { id: 'Realizado (hist.)',   label: t('cartera.realized_hist'),     value: stats.realizedGain  },
    { id: 'Dividendos (hist.)',  label: t('cartera.dividends_hist'),    value: stats.dividendsGain },
    { id: 'Comisiones (hist.)',  label: t('cartera.commissions_hist'),  value: -stats.feesTotal    },
  ];

  // El número grande de la tarjeta es el ROI de la cartera ACTUAL (2026-09-11,
  // decisión del owner). Antes presidía el ROI Simple histórico, que divide por
  // TODO el capital desplegado alguna vez —capital reciclado incluido—, así que
  // contestaba a una pregunta ("¿cuánto gané sobre todo lo que he invertido en mi
  // vida?") distinta de la que se hace quien mira la cartera hoy. Se retiró
  // entero: ya no es chip ni tiene entrada en el diálogo de métricas.
  const roiChips = [
    { id: 'Rentabilidad Anualizada',  label: t('cartera.annualized_return'),     value: portfolioCagr, show: portfolioCagr != null },
    { id: 'TWR (Tiempo)',              label: t('cartera.twr_adjusted'),          value: twrAllTime,    show: twrAllTime != null    },
  ].filter(c => c.show);

  const chipClass = (value) =>
    `flex flex-col items-start px-2.5 py-1.5 rounded-xl border transition-colors touch-manipulation ${
      value >= 0
        ? 'bg-emerald-50/80 dark:bg-emerald-900/20 border-emerald-200/60 dark:border-emerald-800/40 hover:bg-emerald-100 dark:hover:bg-emerald-900/30'
        : 'bg-rose-50/80 dark:bg-rose-900/20 border-rose-200/60 dark:border-rose-800/40 hover:bg-rose-100 dark:hover:bg-rose-900/30'
    }`;

  return (
    <div>
      <div>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
          {/* Card 1 — Valor en Mercado */}
          <motion.div
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0, ease: 'easeOut' }}
            className="relative overflow-hidden bg-white dark:bg-slate-800/80 border-l-[3px] border-l-blue-500 dark:border-l-blue-400 border border-slate-200/80 dark:border-slate-700/40 rounded-2xl p-4 flex flex-col justify-center min-w-0 shadow-xs hover:shadow-md transition-shadow duration-200 sm:col-span-2 md:col-span-1"
          >
            <div className="absolute inset-0 bg-linear-to-br from-blue-50/70 to-transparent dark:from-blue-500/10 pointer-events-none" />
            <div className="absolute -right-3 -bottom-2 text-[72px] font-black text-blue-500/4 dark:text-blue-400/[0.07] select-none pointer-events-none leading-none tabular-nums">
              {sym}
            </div>
            <div className="relative">
              <div className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1.5 flex items-center gap-1">
                {t('cartera.market_value')}
                <button onClick={() => onExplainMetric('Valor en Mercado')} className="p-1 -m-1 hover:text-blue-500 transition-colors flex items-center touch-manipulation">
                  <HelpCircle className="w-3.5 h-3.5 opacity-60 shrink-0" />
                </button>
              </div>
              <div className="font-ledger text-2xl font-bold tabular-nums text-blue-600 dark:text-blue-400 truncate">
                {maskMoney(formatMoney(stats.investedValue, preferredCurrency, { decimals: 2 }))}
              </div>
              <div className="mt-2 pt-2 border-t border-slate-100 dark:border-slate-700/60 flex flex-wrap gap-1.5">
                <div className={`flex flex-col px-2.5 py-1.5 rounded-xl border ${stats.current >= 0 ? 'bg-blue-50/80 dark:bg-blue-900/20 border-blue-200/60 dark:border-blue-800/40' : 'bg-rose-50/80 dark:bg-rose-900/20 border-rose-200/60 dark:border-rose-800/40'}`}>
                  <span className="text-[8px] font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500 whitespace-nowrap">
                    {stats.totalCash >= 0 ? t('cartera.net_assets') : t('cartera.net_assets_leveraged')}
                  </span>
                  <span className={`text-[11px] font-extrabold tabular-nums whitespace-nowrap ${stats.current >= 0 ? 'text-blue-600 dark:text-blue-400' : 'text-rose-500 dark:text-rose-400'}`}>
                    {maskMoney(formatMoney(stats.current, preferredCurrency, { decimals: 0 }))}
                  </span>
                </div>
              </div>
            </div>
          </motion.div>

          {/* Card 2 — Ganancia Total con chips por componente */}
          <motion.div
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.14, ease: 'easeOut' }}
            className={`relative overflow-hidden bg-white dark:bg-slate-800/80 border-l-[3px] ${stats.gain >= 0 ? 'border-l-emerald-400 dark:border-l-emerald-500' : 'border-l-rose-400 dark:border-l-rose-500'} border border-slate-200/80 dark:border-slate-700/40 rounded-2xl p-4 flex flex-col justify-center min-w-0 shadow-xs hover:shadow-md transition-shadow duration-200`}
          >
            <div className={`absolute inset-0 bg-linear-to-br ${stats.gain >= 0 ? 'from-emerald-50/60 to-transparent dark:from-emerald-500/10' : 'from-rose-50/60 to-transparent dark:from-rose-500/10'} pointer-events-none`} />
            <div className="absolute -right-2 -bottom-3 text-[72px] font-black text-emerald-500/4 dark:text-emerald-400/[0.07] select-none pointer-events-none leading-none">
              +
            </div>
            <div className="relative">
              <div className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1.5 flex items-center gap-1">
                {t('cartera.gain_total')}
                <button onClick={() => onExplainMetric('Ganancia Total')} className="p-1 -m-1 hover:text-blue-500 transition-colors flex items-center touch-manipulation">
                  <HelpCircle className="w-3.5 h-3.5 opacity-60 shrink-0" />
                </button>
              </div>
              <div className={`font-ledger text-2xl font-bold tabular-nums truncate ${stats.gain >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                {maskMoney(formatMoney(stats.gain, preferredCurrency, { sign: true, decimals: 2 }))}
              </div>
              <div className="mt-2 pt-2 border-t border-slate-100 dark:border-slate-700/60 flex flex-wrap gap-1.5">
                {gainChips.map(chip => (
                  <button key={chip.id} onClick={() => onExplainMetric(chip.id)} className={chipClass(chip.value)}>
                    <span className="text-[8px] font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500 whitespace-nowrap">{chip.label}</span>
                    <span className={`text-[11px] font-extrabold tabular-nums whitespace-nowrap ${chip.value >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                      {maskMoney(formatMoney(chip.value, preferredCurrency, { sign: true, decimals: 2 }))}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </motion.div>

          {/* Card 3 — Rentabilidad con chips de métricas */}
          <motion.div
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.21, ease: 'easeOut' }}
            className={`relative overflow-hidden bg-white dark:bg-slate-800/80 border-l-[3px] ${latentRoiPct >= 0 ? 'border-l-emerald-400 dark:border-l-emerald-500' : 'border-l-rose-400 dark:border-l-rose-500'} border border-slate-200/80 dark:border-slate-700/40 rounded-2xl p-4 flex flex-col justify-center min-w-0 shadow-xs hover:shadow-md transition-shadow duration-200`}
          >
            <div className={`absolute inset-0 bg-linear-to-br ${latentRoiPct >= 0 ? 'from-emerald-50/60 to-transparent dark:from-emerald-500/10' : 'from-rose-50/60 to-transparent dark:from-rose-500/10'} pointer-events-none`} />
            <div className="absolute -right-3 -bottom-2 text-[72px] font-black text-emerald-500/4 dark:text-emerald-400/[0.07] select-none pointer-events-none leading-none">
              %
            </div>
            <div className="relative">
              <div className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1.5 flex items-center gap-1">
                {t('cartera.profitability')}
                <button onClick={() => onExplainMetric('ROI Cartera actual')} className="p-1 -m-1 hover:text-blue-500 transition-colors flex items-center touch-manipulation">
                  <HelpCircle className="w-3.5 h-3.5 opacity-60 shrink-0" />
                </button>
              </div>
              <div className="mb-0.5">
                <span className="text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">{t('cartera.portfolio_roi_current')}</span>
              </div>
              <div className={`font-ledger text-2xl font-bold tabular-nums truncate ${latentRoiPct >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                {formatPercent(latentRoiPct, 2, { sign: true })}
              </div>
              <div className="mt-2 pt-2 border-t border-slate-100 dark:border-slate-700/60 flex flex-wrap gap-1.5">
                {roiChips.map(chip => (
                  <button key={chip.id} onClick={() => onExplainMetric(chip.id)} className={chipClass(chip.value)}>
                    <span className="text-[8px] font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500 whitespace-nowrap">{chip.label}</span>
                    <span className={`text-[11px] font-extrabold tabular-nums whitespace-nowrap ${chip.value >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                      {formatPercent(chip.value, 2, { sign: true })}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <div className="flex-1 h-px bg-slate-100 dark:bg-slate-800"></div>
          <div className={`flex items-center gap-2 px-4 py-1.5 rounded-full border ${stats.totalCash < 0 ? 'bg-rose-50/60 dark:bg-rose-900/10 border-rose-200/60 dark:border-rose-800/40' : 'bg-slate-50 dark:bg-slate-800/60 border-slate-200/60 dark:border-slate-700/40'}`}>
            <span className={`text-[10px] font-semibold uppercase tracking-wider ${stats.totalCash < 0 ? 'text-rose-400 dark:text-rose-500' : 'text-slate-400'}`}>
              {stats.totalCash < 0 ? `${t('cartera.margin_used')}:` : `${t('cartera.cash_available')}:`}
            </span>
            <span className={`text-xs font-bold tabular-nums ${stats.totalCash < 0 ? 'text-rose-500 dark:text-rose-400' : 'text-blue-500 dark:text-blue-400'}`}>
              {maskMoney(formatMoney(Math.abs(stats.totalCash), preferredCurrency, { decimals: 2 }))}
            </span>
          </div>
          <div className="flex-1 h-px bg-slate-100 dark:bg-slate-800"></div>
        </div>
      </div>
    </div>
  );
}
