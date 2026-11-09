import { HelpCircle, Calendar, BarChart2, TrendingUp, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatPercent, formatNumber } from '@/lib/formatters';

const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CHF: 'Fr' };
const getCurrencySymbol = (c) => CURRENCY_SYMBOLS[c] || c || '€';

/**
 * Header section of the portfolio growth chart.
 * Renders: title, KPI number, sub-label, period tabs, mode selector, S&P toggle, custom date pickers.
 */
export function GrowthChartHeader({
  // KPI
  displayType,
  latestYieldVal,
  modeConfig,
  sym,
  privacyMode,
  displayMarketValue,
  displayCostBasis,
  periodAbsoluteGain,
  incompleteHistory = false,

  // Controls
  timeRange,
  onTimeRangeChange,
  availableYears,
  chartMode,
  roiDisabled = false,
  onChartModeChange,
  showSP500,
  onToggleSP500,
  sp500Loading,
  benchmarkApplies = true,
  customStart,
  customEnd,
  onCustomStartChange,
  onCustomEndChange,
  onToggleDisplayType,
  onOpenExplainer,

  // i18n
  currency,
}) {
  const { t } = useTranslation();
  const { color: chartColor, label: modeLabel } = modeConfig;

  return (
    <div className="px-5 pt-5 pb-0 sm:px-6 sm:pt-6">

      {/* Row 1: title + help + display-type toggle */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <p className="text-sm font-bold text-slate-700 dark:text-slate-200 leading-none">
            {t('portfolio_growth.title')}
          </p>
          <button
            onClick={onOpenExplainer}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
            aria-label={t('portfolio_growth.methodology')}
          >
            <HelpCircle className="w-3.5 h-3.5" />
          </button>
        </div>

        <button
          onClick={onToggleDisplayType}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-bold transition-colors border ${
            displayType === 'VALUE'
              ? 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200'
              : 'border-transparent text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
          }`}
          title={displayType === 'VALUE' ? t('portfolio_growth.toggle_pct_title') : t('portfolio_growth.toggle_value_title')}
        >
          {displayType === 'VALUE'
            ? <><BarChart2 className="w-3 h-3" /> {t('portfolio_growth.toggle_value')} {getCurrencySymbol(currency)}</>
            : <><TrendingUp className="w-3 h-3" /> {t('portfolio_growth.toggle_pct')}</>
          }
        </button>
      </div>

      {/* Row 2: KPI number */}
      <div className="mb-1.5">
        {displayType === 'VALUE' ? (
          <span className="text-3xl md:text-4xl font-black tabular-nums tracking-tight text-slate-900 dark:text-white">
            {privacyMode ? '••••' : formatNumber(displayMarketValue, 2, 2)}
            <span className="text-2xl text-slate-400 ml-1">{sym}</span>
          </span>
        ) : (
          <div className="flex items-center gap-2.5">
            {/* Un % calculado sobre un histórico INCOMPLETO no puede pintarse en
                verde/rojo: ese color es un veredicto. En gris y con "≈" se lee como
                lo que es —una estimación— y el aviso ámbar de debajo dice por qué. */}
            <span
              title={incompleteHistory ? t('portfolio_growth.incomplete_kpi_tooltip') : undefined}
              className={`text-3xl md:text-4xl font-black tabular-nums tracking-tight ${
                incompleteHistory
                  ? 'text-slate-400 dark:text-slate-500'
                  : latestYieldVal >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'
              }`}
            >
              {privacyMode ? '•••• %' : (incompleteHistory ? `≈${formatPercent(latestYieldVal, 2)}` : formatPercent(latestYieldVal, 2, { sign: true }))}
            </span>
            <span
              className="text-[10px] font-black px-2 py-0.5 rounded-full border"
              style={{ color: chartColor, borderColor: `${chartColor}50`, backgroundColor: `${chartColor}14` }}
            >
              {modeLabel}
            </span>
          </div>
        )}
      </div>

      {/* Row 3: sub-label */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-4 text-sm text-slate-500 dark:text-slate-400">
        {displayType === 'VALUE' ? (
          <>
            <span className="text-xs">{t('portfolio_growth.gain_period')}</span>
            {privacyMode ? (
              <span className="font-bold text-slate-900 dark:text-white text-xs">••••</span>
            ) : (
              <span className={`text-xs font-bold px-1.5 py-0.5 rounded-md ${periodAbsoluteGain >= 0 ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' : 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400'}`}>
                {periodAbsoluteGain >= 0 ? '+' : '−'}{formatNumber(Math.abs(periodAbsoluteGain), 2, 2)} {sym}
                <span className="ml-1 opacity-60">({formatPercent(latestYieldVal, 2, { sign: true })})</span>
              </span>
            )}
          </>
        ) : (
          <>
            <span className="text-xs">{t('portfolio_growth.capital_invested')}</span>
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
              {privacyMode ? '••••' : `${formatNumber(displayCostBasis, 2, 2)} ${sym}`}
            </span>
          </>
        )}
      </div>

      {/* Row 4: period tabs + mode selector + S&P toggle */}
      <div className="flex flex-wrap items-center gap-2 pb-4">

        {/* Period selector */}
        <div className="flex items-center gap-0.5 bg-slate-100/80 dark:bg-slate-800/60 p-0.5 rounded-xl border border-slate-200/50 dark:border-slate-700/50">
          {['1D', '1W', '6M', '1Y', 'YTD', 'ALL'].map(r => (
            <button
              key={r}
              onClick={() => onTimeRangeChange(r)}
              className={`px-2.5 py-1 text-[10px] font-bold rounded-lg transition-colors ${
                timeRange === r
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
              }`}
            >
              {r}
            </button>
          ))}
          {availableYears.map(yr => (
            <button
              key={yr}
              onClick={() => onTimeRangeChange(yr)}
              className={`px-2.5 py-1 text-[10px] font-bold rounded-lg transition-colors ${
                timeRange === yr
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
              }`}
            >
              {yr}
            </button>
          ))}
          <button
            onClick={() => onTimeRangeChange('CUSTOM')}
            className={`p-1 rounded-lg transition-colors ${timeRange === 'CUSTOM' ? 'bg-white dark:bg-slate-700 text-blue-500 shadow-xs' : 'text-slate-400 hover:text-slate-600'}`}
          >
            <Calendar className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Mode selector (only in % mode) */}
        {displayType !== 'VALUE' && (
          <ModeSelector modes={MODES} chartMode={chartMode} roiDisabled={roiDisabled} onChartModeChange={onChartModeChange} />
        )}

        {/* S&P 500 toggle — en modo ROI se DESHABILITA en vez de desaparecer: un
            botón que se esfuma al cambiar de métrica parece un fallo; uno apagado
            con su porqué enseña que esa comparación no es válida. */}
        {displayType !== 'VALUE' && (
          <button
            onClick={onToggleSP500}
            disabled={!benchmarkApplies}
            title={benchmarkApplies ? undefined : t('portfolio_growth.benchmark_only_twr')}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-bold rounded-xl border transition-all ${
              !benchmarkApplies
                ? 'text-slate-300 dark:text-slate-600 border-slate-200/60 dark:border-slate-700/50 cursor-not-allowed'
                : showSP500
                ? 'bg-orange-50 dark:bg-orange-900/20 text-orange-600 dark:text-orange-400 border-orange-200 dark:border-orange-500/30'
                : 'text-slate-500 border-slate-200/60 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-800'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${showSP500 ? 'bg-orange-500' : 'bg-slate-300 dark:bg-slate-600'}`} />
            S&P 500 TR
            {sp500Loading && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
          </button>
        )}
      </div>

      {/* Custom date pickers */}
      {timeRange === 'CUSTOM' && (
        <div className="flex items-center gap-2 pb-3">
          <input
            type="date"
            value={customStart}
            onChange={e => onCustomStartChange(e.target.value)}
            className="text-[11px] font-bold border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-hidden focus:ring-1 focus:ring-blue-500/50"
          />
          <span className="text-slate-400 text-xs">—</span>
          <input
            type="date"
            value={customEnd}
            onChange={e => onCustomEndChange(e.target.value)}
            className="text-[11px] font-bold border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-hidden focus:ring-1 focus:ring-blue-500/50"
          />
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const MODES = {
  TTWROR:  { color: '#3b82f6', gradId: 'gradTTWROR',  label: 'TTWROR',  desc: 'True Time-Weighted Return' },
  ROI:     { color: '#8b5cf6', gradId: 'gradROI',     label: 'ROI',     desc: 'ROI Simple (coste base)' },
};

// El ROI se DESHABILITA fuera del rango completo, no desaparece — el mismo
// criterio que el botón del S&P: un control que se esfuma al cambiar de rango
// se lee como un fallo, y uno apagado con su porqué enseña por qué esa lectura
// no es válida ahí.
function ModeSelector({ modes, chartMode, roiDisabled = false, onChartModeChange }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-0.5 bg-slate-100/80 dark:bg-slate-800/60 p-0.5 rounded-xl border border-slate-200/50 dark:border-slate-700/50">
      {Object.entries(modes).map(([key, cfg]) => {
        const off = key === 'ROI' && roiDisabled;
        return (
          <button
            key={key}
            onClick={() => onChartModeChange(key)}
            disabled={off}
            title={off ? t('portfolio_growth.roi_only_all') : cfg.desc}
            className={`px-2.5 py-1 text-[10px] font-bold rounded-lg transition-all ${
              off
                ? 'text-slate-300 dark:text-slate-600 cursor-not-allowed'
                : chartMode === key
                ? 'bg-white dark:bg-slate-700 shadow-xs'
                : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
            }`}
            style={!off && chartMode === key ? { color: cfg.color } : {}}
          >
            {cfg.label}
          </button>
        );
      })}
    </div>
  );
}
