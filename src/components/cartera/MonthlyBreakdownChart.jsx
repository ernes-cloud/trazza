import React from 'react';
import {
  ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceLine,
} from 'recharts';
import { appLocale } from '@/lib/formatters';
import { usePrivateFormatters } from '@/hooks/usePrivateFormatters';

// "2023-01" → "ene 23" (idioma de la app). Lo que no sea un mes se deja igual.
const monthLabel = (name) => {
  const m = /^(\d{4})-(\d{2})$/.exec(name || '');
  if (!m) return name;
  return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString(appLocale(), { month: 'short', year: '2-digit' });
};

/**
 * Presentational monthly bar-chart card used by the CarteraPage analytics summary
 * (Sales P&L / Dividends / Commissions "por Mes"). Pure presentation — all values
 * (total, footer figures) are pre-computed by the caller and passed in.
 *
 * Props:
 *   title          – already-translated heading string
 *   accent         – 'blue' | 'emerald' | 'rose' (visual chrome only)
 *   valueMode      – 'signed' (color/sign by value) | 'positive' | 'negative'
 *   yAxisAbbreviate– true to render the Y axis with a 'k' thousands suffix
 *   currency       – ISO code of the preferred currency (formatting follows the app language)
 *   data           – [{ name, value, projected? }] (projected bars render faded)
 *   total          – pre-computed sum shown in the header
 *   footer         – [{ label, value, tone }] (tone: 'emerald'|'rose'|'neutral'); [] hides the footer row
 *   projectedLabel – already-translated tag shown in the tooltip of projected bars
 */

const ACCENTS = {
  blue: {
    glow: 'bg-blue-500/5 dark:bg-blue-400/5',
    hover: 'hover:shadow-blue-500/10',
    iconBox: 'bg-blue-50 dark:bg-blue-900/30 border-blue-100 dark:border-blue-800/50',
    dot: 'bg-blue-500',
    cursorFill: 'rgba(148,163,184,0.08)',
  },
  emerald: {
    glow: 'bg-emerald-500/5 dark:bg-emerald-400/5',
    hover: 'hover:shadow-emerald-500/10',
    iconBox: 'bg-emerald-50 dark:bg-emerald-900/30 border-emerald-100 dark:border-emerald-800/50',
    dot: 'bg-emerald-500',
    cursorFill: 'rgba(16,185,129,0.06)',
  },
  rose: {
    glow: 'bg-rose-500/5 dark:bg-rose-400/5',
    hover: 'hover:shadow-rose-500/10',
    iconBox: 'bg-rose-50 dark:bg-rose-900/30 border-rose-100 dark:border-rose-800/50',
    dot: 'bg-rose-500',
    cursorFill: 'rgba(239,68,68,0.06)',
  },
};

const POSITIVE = 'text-emerald-600 dark:text-emerald-400';
const NEGATIVE = 'text-rose-500 dark:text-rose-400';

const TONE = {
  emerald: POSITIVE,
  rose: NEGATIVE,
  neutral: 'text-slate-600 dark:text-slate-300',
};

const MonthlyBreakdownChart = ({
  title,
  accent = 'blue',
  valueMode = 'signed',
  yAxisAbbreviate = false,
  currency = 'EUR',
  data = [],
  total = 0,
  footer = [],
  projectedLabel,
}) => {
  const a = ACCENTS[accent] ?? ACCENTS.blue;
  // Enmascarados en modo privacidad (ver hooks/usePrivateFormatters).
  const { formatMoney, formatMoneyCompact } = usePrivateFormatters();

  const totalColor = valueMode === 'positive' ? POSITIVE
    : valueMode === 'negative' ? NEGATIVE
    : (total >= 0 ? POSITIVE : NEGATIVE);
  // El signo lo decide el modo: las comisiones son SIEMPRE un gasto.
  const signed = (v, decimals) => (valueMode === 'negative'
    ? formatMoney(-Math.abs(v), currency, { decimals })
    : formatMoney(v, currency, { decimals, sign: true }));

  // Compacto con un decimal: "€1k" repetido para 1.050 y 1.400 confundía.
  const yFmt = yAxisAbbreviate
    ? (v) => formatMoneyCompact(v, currency)
    : (v) => formatMoney(v, currency, { decimals: 0 });

  return (
    // Estilo de tarjeta común (el del Dashboard): antes era rounded-4xl con
    // degradado, sombra grande y un salto al pasar el ratón.
    <div className="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-2xl p-5 shadow-xs relative overflow-hidden">
      <div className="flex items-center justify-between mb-4 relative z-10">
        <div className="flex items-center gap-2">
          <div className={`p-1.5 rounded-lg border ${a.iconBox}`}>
            <div className={`w-2 h-2 rounded-full ${a.dot}`} />
          </div>
          <h4 className="text-sm font-bold text-slate-900 dark:text-white">{title}</h4>
        </div>
        <span className={`text-lg font-black tabular-nums tracking-tight ${totalColor}`}>
          {signed(total, 0)}
        </span>
      </div>
      <div className="h-40 mt-2 relative z-10">
        <ResponsiveContainer width="100%" height="100%">
          {/* left 0 + YAxis width: con el margen negativo (-28) el eje se recortaba
              y con etiquetas más largas ("1,4 mil €") solo se leía "mil €". */}
          <BarChart data={data} margin={{ top: 2, right: 2, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#334155" opacity={0.04} />
            <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 9, fill: '#94a3b8', fontWeight: 600 }} interval="preserveStartEnd" dy={8} tickFormatter={monthLabel} />
            <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 9, fill: '#94a3b8', fontWeight: 600 }} tickFormatter={yFmt} width={56} />
            <Tooltip
              cursor={{ fill: a.cursorFill }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const { name, value, projected } = payload[0].payload;
                const tipColor = valueMode === 'positive' ? 'text-emerald-400'
                  : valueMode === 'negative' ? 'text-rose-400'
                  : (value >= 0 ? 'text-emerald-400' : 'text-rose-400');
                return (
                  <div className="bg-slate-900/97 border border-slate-700/60 px-3.5 py-2.5 rounded-xl shadow-2xl backdrop-blur-md">
                    <p className="text-[9px] text-slate-400 font-bold uppercase mb-1.5">{monthLabel(name)}</p>
                    <p className={`text-sm font-black tabular-nums ${tipColor}`}>
                      {signed(value, 2)}
                    </p>
                    {projected && projectedLabel && (
                      <p className="text-[9px] text-amber-400 font-bold uppercase mt-1">{projectedLabel}</p>
                    )}
                  </div>
                );
              }}
            />
            {valueMode === 'signed' ? (
              <>
                <ReferenceLine y={0} stroke="#475569" strokeOpacity={0.2} />
                <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                  {data.map((entry, i) => (
                    <Cell key={i} fill={entry.value >= 0 ? '#10b981' : '#ef4444'} fillOpacity={entry.projected ? 0.35 : 0.9} />
                  ))}
                </Bar>
              </>
            ) : (
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                {data.map((entry, i) => (
                  <Cell key={i} fill={valueMode === 'negative' ? '#ef4444' : '#10b981'} fillOpacity={entry.projected ? 0.35 : 0.9} />
                ))}
              </Bar>
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
      {footer.length > 0 && (
        <div className="flex justify-between mt-4 pt-3 border-t border-slate-100 dark:border-slate-800/60 relative z-10">
          {footer.map((f, i) => (
            <span key={i} className="text-[9px] text-slate-400 uppercase tracking-wide font-bold">
              {f.label}: <span className={`font-black ${TONE[f.tone] ?? TONE.neutral}`}>{f.value}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

export default MonthlyBreakdownChart;
