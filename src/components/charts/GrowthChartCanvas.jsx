import {
  ComposedChart,
  Area,
  Line,
  ReferenceArea,
  ReferenceLine,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { useTranslation } from 'react-i18next';
import { formatPercent, formatNumber } from '@/lib/formatters';
import { GrowthChartTooltip } from './GrowthChartTooltip';

const GRADIENT_STOPS = {
  TTWROR:  [{ offset: '0%', opacity: 0.22 }, { offset: '65%', opacity: 0.04 }, { offset: '100%', opacity: 0 }],
  ROI:     [{ offset: '0%', opacity: 0.28 }, { offset: '65%', opacity: 0.04 }, { offset: '100%', opacity: 0 }],
};

/**
 * Pure Recharts chart for the portfolio growth widget.
 * Receives pre-filtered, pre-normalised data — no data fetching, no business logic.
 */
export function GrowthChartCanvas({
  data,
  activeDataKey,
  chartMode,
  modeConfig,
  displayType,
  showSP500,
  sym,
  privacyMode,
  currentHoldingNames,
  xAxisConfig,
  yieldMin,
}) {
  const { i18n } = useTranslation();
  const dateLocale = i18n.language.startsWith('es') ? 'es-ES' : 'en-US';

  const { color: chartColor, gradId, label: modeLabel } = modeConfig;
  const hasLossZone = yieldMin < 0;

  return (
    <div className="h-[300px] w-full px-2 pb-2">
      <ResponsiveContainer width="100%" height="100%">
        {/* left: 16 y no 0 — la primera etiqueta del eje X va centrada en su
            punto, y con 0 se salía media ("jun 23" se leía "'23"). */}
        <ComposedChart data={data} margin={{ top: 8, right: 36, left: 16, bottom: 0 }}>

          {/* SVG gradient defs */}
          <defs>
            {Object.entries(GRADIENT_STOPS).map(([key, stops]) => {
              const color = { TTWROR: '#3b82f6', GETQUIN: '#f59e0b', ROI: '#8b5cf6', TWR: '#10b981' }[key];
              return (
                <linearGradient key={key} id={`grad${key}`} x1="0" y1="0" x2="0" y2="1">
                  {stops.map((s, i) => (
                    <stop key={i} offset={s.offset} stopColor={color} stopOpacity={s.opacity} />
                  ))}
                </linearGradient>
              );
            })}
          </defs>

          <CartesianGrid strokeDasharray="4 4" vertical={false} stroke="#94a3b8" opacity={0.10} />

          {hasLossZone && displayType !== 'VALUE' && (
            <ReferenceArea y1={yieldMin} y2={0} fill="#ef4444" fillOpacity={0.04} ifOverflow="extendDomain" />
          )}

          <XAxis
            dataKey="date"
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 10, fill: '#94a3b8', fontWeight: 600 }}
            dy={10}
            interval={xAxisConfig.interval}
            tickFormatter={xAxisConfig.formatter}
          />

          <YAxis
            orientation="right"
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 10, fill: '#94a3b8', fontWeight: 600 }}
            tickFormatter={val => {
              if (privacyMode) return '••';
              if (displayType === 'VALUE') {
                return val >= 1000 ? `${formatNumber(val / 1000, 0, 1)} k${sym}` : `${formatNumber(val, 0, 0)} ${sym}`;
              }
              return formatPercent(Number(val), 1, { sign: true });
            }}
            dx={8}
          />

          <ReferenceLine y={0} stroke="#64748b" strokeOpacity={0.45} strokeDasharray="4 3" strokeWidth={1} />

          <Tooltip
            cursor={{ stroke: '#64748b', strokeWidth: 1, strokeDasharray: '4 4', opacity: 0.3 }}
            content={props => (
              <GrowthChartTooltip
                {...props}
                chartMode={chartMode}
                chartColor={chartColor}
                modeLabel={modeLabel}
                displayType={displayType}
                sym={sym}
                dateLocale={dateLocale}
                privacyMode={privacyMode}
                currentHoldingNames={currentHoldingNames}
              />
            )}
          />

          {/* Main area/line */}
          <Area
            type="linear"
            dataKey={activeDataKey}
            name={displayType === 'VALUE' ? 'Valor de la cartera' : modeConfig.desc}
            stroke={chartColor}
            strokeWidth={2}
            fillOpacity={1}
            fill={`url(#${gradId})`}
            animationDuration={900}
            activeDot={{ r: 4, fill: chartColor, stroke: '#0f172a', strokeWidth: 2 }}
            dot={false}
            connectNulls
          />

          {/* Capital invertido line (VALUE mode) */}
          {displayType === 'VALUE' && (
            <Line
              type="linear"
              dataKey="cumulativeCost"
              name="Capital invertido"
              stroke="#64748b"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={false}
              animationDuration={900}
              connectNulls
            />
          )}

          {/* S&P 500 benchmark */}
          {showSP500 && (
            <Line
              type="linear"
              dataKey="sp500Return"
              name="S&P 500 TR"
              stroke="#f97316"
              strokeWidth={1.5}
              dot={false}
              strokeDasharray="5 3"
              animationDuration={900}
              connectNulls
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Footer legend strip shown below the chart canvas.
 */
export function GrowthChartLegend({
  modeConfig,
  displayType,
  showSP500,
  latestSP,
  latestYieldVal,
  timeRange,
  totalReturnPct,
  privacyMode,
}) {
  const { t } = useTranslation();
  const { color: chartColor, desc: modeDesc } = modeConfig;

  return (
    <div className="flex items-center flex-wrap gap-3 px-5 sm:px-6 pb-4 pt-3 border-t border-slate-100 dark:border-slate-800/60">
      <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500">
        <span className="w-4 h-0.5 rounded-full inline-block" style={{ backgroundColor: chartColor }} />
        {/* En la vista Valor la línea es el valor de la cartera, no el modo
            (decía "ROI Simple (coste base)" debajo de una línea en euros). */}
        {displayType === 'VALUE' ? t('portfolio_growth.legend_value') : modeDesc}
      </div>

      {displayType === 'VALUE' && (
        <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500">
          <span className="w-4 h-0 border-t-2 border-dashed border-slate-400 inline-block" />
          {t('portfolio_growth.legend_capital')}
        </div>
      )}

      {showSP500 && (
        <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500">
          <span className="w-4 h-0 border-t-2 border-dashed border-orange-400 inline-block" />
          S&P 500 TR
        </div>
      )}

      {/* No se llama "ROI": es la ganancia total con realizado, dividendos y
          comisiones, sobre TODO el capital desplegado — otra magnitud que la que
          dibuja la línea, que solo mide el latente de las posiciones abiertas.
          Compartir la palabra, a tres centímetros, era lo que hacía leer la
          tarjeta como un fallo de cálculo. Fuera de ALL la línea es siempre
          TTWROR, así que ya no hay colisión de nombres. */}
      {timeRange !== 'ALL' && totalReturnPct != null && (
        <div
          className="ml-auto flex items-center gap-1 text-[9px] font-bold text-slate-400"
          title={t('portfolio_growth.total_return_tooltip')}
        >
          {t('portfolio_growth.total_roi')}
          <span className={`font-black ${totalReturnPct >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
            {privacyMode ? '•••• %' : formatPercent(totalReturnPct, 2, { sign: true })}
          </span>
        </div>
      )}

      {showSP500 && latestSP != null && (() => {
        const diff = latestYieldVal - latestSP;
        const hasRoiLabel = timeRange !== 'ALL' && totalReturnPct != null;
        return (
          <div className={`${hasRoiLabel ? '' : 'ml-auto'} flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-md ${
            diff >= 0
              ? 'bg-emerald-100/50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400'
              : 'bg-rose-100/50 text-rose-500 dark:bg-rose-900/20 dark:text-rose-400'
          }`}>
            {diff >= 0 ? '▲' : '▼'} {t('portfolio_growth.vs_sp500', { pct: privacyMode ? '••••' : `${diff > 0 ? '+' : ''}${formatNumber(diff, 2, 2)}` })}
          </div>
        );
      })()}
    </div>
  );
}
