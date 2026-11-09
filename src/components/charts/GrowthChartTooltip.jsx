import { useTranslation } from 'react-i18next';
import { formatPercent, formatNumber } from '@/lib/formatters';
import { parseIsoDateLocal } from '@/lib/dates';

const formatLocalDate = (dateStr, locale = 'es-ES') => {
  if (!dateStr) return '';
  return (parseIsoDateLocal(dateStr) || new Date(dateStr)).toLocaleDateString(locale, {
    day: 'numeric', month: 'short', year: 'numeric',
  });
};

/**
 * Custom Recharts tooltip for the portfolio growth chart.
 *
 * Props injected by Recharts: active, payload
 * Own props: chartMode, chartColor, displayType, sym, dateLocale,
 *            privacyMode, currentHoldingNames, modeLabel
 */
export function GrowthChartTooltip({
  active,
  payload,
  chartMode,
  chartColor,
  modeLabel,
  displayType,
  sym,
  dateLocale,
  privacyMode,
  currentHoldingNames,
}) {
  const { t } = useTranslation();

  if (!active || !payload?.length) return null;
  const d = payload[0].payload;

  const yldRaw = chartMode === 'ROI' ? (d.normalizedSimpleROI ?? 0)
    : (d.normalizedTTWROR ?? 0);
  const yld = typeof yldRaw === 'number' ? parseFloat(yldRaw.toFixed(2)) : null;

  const sp = d.sp500Return;
  const dailyPct = d.dailyReturn != null ? d.dailyReturn * 100 : null;
  const portfolioValue = d.value;

  const assetEntries = Object.entries(d.breakdown || {})
    .filter(([name, r]) =>
      Math.abs(r) > 0.00005 &&
      (currentHoldingNames === null || currentHoldingNames.has(name))
    )
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 5);

  return (
    <div className="bg-slate-900/97 border border-slate-700/60 p-3.5 rounded-2xl shadow-2xl backdrop-blur-xl min-w-[200px]">
      {/* Date header */}
      <div className="text-slate-400 text-[10px] font-bold mb-2.5 uppercase tracking-widest text-center border-b border-slate-800 pb-2">
        {formatLocalDate(d.date, dateLocale)}
      </div>

      {/* Main metric */}
      <div className="flex flex-col gap-1.5 mb-2">
        {displayType === 'PERCENTAGE' ? (
          <div className="flex justify-between items-center gap-4">
            <span className="flex items-center gap-1.5 text-xs font-bold text-slate-300">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: chartColor }} />
              {modeLabel}
            </span>
            <span className={`text-sm font-black tabular-nums ${yld === null ? 'text-slate-500' : yld >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {privacyMode ? '•••• %' : (yld === null ? '—' : formatPercent(yld, 2, { sign: true }))}
            </span>
          </div>
        ) : (
          <>
            <div className="flex justify-between items-center gap-4">
              <span className="flex items-center gap-1.5 text-xs font-bold text-slate-300">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: chartColor }} />
                {t('portfolio_growth.tooltip_value')}
              </span>
              <span className="text-sm font-black tabular-nums text-white">
                {privacyMode ? '••••' : (portfolioValue != null
                  ? `${formatNumber(portfolioValue, 2, 2)} ${sym}`
                  : '—')}
              </span>
            </div>
            <div className="flex justify-between items-center gap-4">
              <span className="flex items-center gap-1.5 text-xs font-bold text-slate-400">
                <span className="w-2 h-2 rounded-full bg-slate-600 shrink-0" />
                {t('portfolio_growth.tooltip_capital')}
              </span>
              <span className="text-sm font-bold tabular-nums text-slate-300">
                {privacyMode ? '••••' : (d.cumulativeCost != null
                  ? `${formatNumber(d.cumulativeCost, 2, 2)} ${sym}`
                  : '—')}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Sub-info row */}
      {displayType === 'PERCENTAGE' && (portfolioValue != null || dailyPct != null) && (
        <div className="flex items-center justify-between mb-2 bg-slate-800/50 rounded-lg px-2 py-1.5">
          {portfolioValue != null && (
            <span className="text-[10px] text-slate-400 tabular-nums">
              {/* Este importe se colaba en modo privacidad (solo se tapaba el de la vista Valor). */}
              {privacyMode ? '••••' : `${formatNumber(portfolioValue, 0, 0)} ${sym}`}
            </span>
          )}
          {dailyPct != null && (
            <span className={`text-[10px] font-black tabular-nums shrink-0 ${dailyPct >= 0 ? 'text-emerald-400/80' : 'text-rose-400/80'}`}>
              {privacyMode ? '•••• %' : formatPercent(dailyPct, 2, { sign: true })} {t('portfolio_growth.today')}
            </span>
          )}
        </div>
      )}

      {/* S&P 500 comparison */}
      {sp != null && (
        <div className="flex justify-between items-center gap-4 mb-2 border-t border-slate-800 pt-2">
          <span className="flex items-center gap-1.5 text-xs font-bold text-slate-300">
            <span className="w-2 h-2 rounded-full bg-orange-500 shrink-0" />
            S&P 500
          </span>
          <span className={`text-sm font-black tabular-nums ${sp >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {formatPercent(sp, 2, { sign: true })}
          </span>
        </div>
      )}

      {/* Top movers */}
      {assetEntries.length > 0 && (
        <div className="border-t border-slate-700/50 pt-2.5 mt-1">
          <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1.5 text-center">
            {t('portfolio_growth.day_movers')}
          </p>
          <div className="space-y-1">
            {assetEntries.map(([name, ret]) => (
              <div key={name} className="flex items-center justify-between gap-3">
                <span className="text-[10px] text-slate-400 truncate max-w-[120px]">{name}</span>
                <span className={`text-[10px] font-black tabular-nums shrink-0 ${ret > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {formatPercent(ret * 100, 2, { sign: true })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
