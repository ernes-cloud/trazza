import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronUp, Info, Sparkles, Target, Crosshair } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { buildProjection, yearGoalReached, requiredMonthlyFor } from '@/services/compoundService';
import { appLocale } from '@/lib/formatters';

const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CHF: 'Fr' };
const getCurrencySymbol = (c) => CURRENCY_SYMBOLS[c] || c || '€';
const fmt = (n, d = 0) => Number(n).toLocaleString(appLocale(), { minimumFractionDigits: d, maximumFractionDigits: d });

const LS_KEY = 'wf_calc_compound';
const loadSaved = () => { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; } };

const BASE_PRESETS = [
  { key: 'preset_conservative', rate: 5, color: 'emerald' },
  { key: 'sp500', rate: 10, color: 'blue' },
  { key: 'preset_aggressive', rate: 15, color: 'amber' },
];

// Clases explícitas por color: Tailwind JIT no genera clases interpoladas
// (`bg-${color}-100` se purga en producción), así que van escritas enteras.
const PRESET_ACTIVE_CLASSES = {
  emerald: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-700',
  blue: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-700',
  amber: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-700',
  purple: 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 border-purple-300 dark:border-purple-700',
};

const inputBase = 'bg-slate-50 dark:bg-slate-900/60 border border-slate-200/80 dark:border-slate-700/40 text-slate-800 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 transition-all tabular-nums';

const CompoundInterestCalculator = ({ portfolioValue = 0, totalInvested = 0, monthlyCashFlow = 0, portfolioCagr = null, preferredCurrency = 'EUR' }) => {
  const { t } = useTranslation();
  const saved = useMemo(() => loadSaved(), []);
  const sym = getCurrencySymbol(preferredCurrency);

  const defaultInitial = portfolioValue > 0 ? Math.round(portfolioValue) : 1000;
  const [initial, setInitial] = useState(defaultInitial);
  const [monthly, setMonthly] = useState(saved.monthly ?? (monthlyCashFlow > 0 ? Math.round(monthlyCashFlow) : 200));
  const [rate, setRate] = useState(saved.rate ?? (portfolioCagr > 0 ? Math.round(portfolioCagr * 10) / 10 : 10));
  const [years, setYears] = useState(saved.years ?? 20);
  const [freq, setFreq] = useState(saved.freq ?? 'monthly');
  const [inflation, setInflation] = useState(saved.inflation ?? false);
  const [inflationPct, setInflationPct] = useState(saved.inflationPct ?? 2.5);
  const [stepUp, setStepUp] = useState(saved.stepUp ?? 0);
  const [goal, setGoal] = useState(saved.goal ?? '');
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    if (portfolioValue > 0) setInitial(Math.round(portfolioValue));
  }, [portfolioValue]);
  useEffect(() => {
    if (!saved.monthly && monthlyCashFlow > 0) setMonthly(Math.round(monthlyCashFlow));
  }, [monthlyCashFlow]);
  useEffect(() => {
    if (!saved.rate && portfolioCagr > 0) setRate(Math.round(portfolioCagr * 10) / 10);
  }, [portfolioCagr]);

  // Persist other settings (not initial — it always resets to portfolio value on open)
  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ monthly, rate, years, freq, inflation, inflationPct, stepUp, goal })); } catch {}
  }, [monthly, rate, years, freq, inflation, inflationPct, stepUp, goal]);

  // Toda la matemática vive en compoundService (puro y testeado)
  const params = useMemo(() => ({
    initial,
    monthly,
    annualRate: rate,
    years,
    freq,
    stepUpPct: stepUp,
    inflationPct: inflation ? inflationPct : null,
  }), [initial, monthly, rate, years, freq, stepUp, inflation, inflationPct]);

  const { table: tableData, chart: chartData, finalValue, finalValueReal, totalContributed, totalInterest, milestones } =
    useMemo(() => buildProjection(params), [params]);

  const goalNum = parseFloat(goal) || 0;
  const goalInfo = useMemo(() => {
    if (goalNum <= 0) return null;
    return {
      year: yearGoalReached(params, goalNum),
      required: requiredMonthlyFor(params, goalNum),
    };
  }, [params, goalNum]);

  const compoundPower = totalContributed > 0 ? (totalInterest / totalContributed * 100) : 0;

  const allPresets = useMemo(() => {
    const presets = BASE_PRESETS.map(p => ({ ...p, label: p.key === 'sp500' ? 'S&P 500' : t(`compound_calc.${p.key}`) }));
    if (portfolioCagr > 0) {
      return [presets[0], { key: 'preset_portfolio', label: t('compound_calc.preset_portfolio'), rate: Math.round(portfolioCagr * 10) / 10, color: 'purple' }, ...presets.slice(1)];
    }
    return presets;
  }, [portfolioCagr, t]);

  const handleNumInput = (setter) => (e) => {
    const v = e.target.value.replace(',', '.');
    setter(v === '' ? 0 : parseFloat(v) || 0);
  };

  return (
    <div className="bg-white dark:bg-slate-800/80 border border-slate-200/80 dark:border-slate-700/40 rounded-2xl shadow-xs overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-700/60 bg-linear-to-r from-blue-50/80 to-indigo-50/50 dark:from-blue-900/20 dark:to-indigo-900/10">
        <div className="flex items-center gap-2.5">
          <div className="p-2 bg-blue-100 dark:bg-blue-900/40 rounded-xl">
            <Sparkles className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          </div>
          <div>
            <h3 className="text-sm font-black text-slate-800 dark:text-white tracking-tight">{t('compound_calc.title')}</h3>
            <p className="text-[10px] text-slate-400 dark:text-slate-500 font-medium mt-0.5">{t('compound_calc.subtitle')}</p>
          </div>
        </div>
      </div>

      <div className="p-4 space-y-4">
        {/* Balance Inicial */}
        <div>
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 block">{t('compound_calc.initial_balance')}</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm font-bold">{sym}</span>
            <input type="text" inputMode="decimal" value={initial} onChange={handleNumInput(setInitial)}
              className={`w-full pl-8 pr-3 py-2.5 rounded-xl text-sm font-bold ${inputBase}`} />
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
            {totalInvested > 0 && initial !== Math.round(totalInvested) && (
              <button onClick={() => setInitial(Math.round(totalInvested))} className="text-[9px] font-bold text-blue-500 hover:text-blue-600 transition-colors">
                {t('compound_calc.use_invested', { sym, amount: fmt(totalInvested, 0) })}
              </button>
            )}
            {portfolioValue > 0 && initial !== Math.round(portfolioValue) && (
              <button onClick={() => setInitial(Math.round(portfolioValue))} className="text-[9px] font-bold text-slate-400 hover:text-slate-600 transition-colors">
                {t('compound_calc.use_current_value', { sym, amount: fmt(portfolioValue, 0) })}
              </button>
            )}
          </div>
        </div>

        {/* Aportación Mensual + Aumento anual */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 block">{t('compound_calc.monthly_contribution')}</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm font-bold">{sym}</span>
              <input type="text" inputMode="decimal" value={monthly} onChange={handleNumInput(setMonthly)}
                className={`w-full pl-8 pr-3 py-2.5 rounded-xl text-sm font-bold ${inputBase}`} />
            </div>
            {monthlyCashFlow > 0 && monthly !== Math.round(monthlyCashFlow) && (
              <button onClick={() => setMonthly(Math.round(monthlyCashFlow))} className="mt-1 text-[9px] font-bold text-blue-500 hover:text-blue-600 transition-colors">
                {t('compound_calc.use_monthly_avg', { sym, amount: fmt(monthlyCashFlow, 0) })}
              </button>
            )}
          </div>
          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 block">{t('compound_calc.stepup')}</label>
            <div className="relative">
              <input type="text" inputMode="decimal" value={stepUp} onChange={handleNumInput(setStepUp)}
                className={`w-full pl-3 pr-8 py-2.5 rounded-xl text-sm font-bold ${inputBase}`} />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm font-bold">%</span>
            </div>
            <p className="mt-1 text-[9px] font-medium text-slate-400">{t('compound_calc.stepup_hint')}</p>
          </div>
        </div>

        {/* Rentabilidad Anual */}
        <div>
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 block">{t('compound_calc.annual_return')}</label>
          <div className="flex items-center gap-2">
            <input type="range" min="1" max="25" step="0.5" value={rate} onChange={(e) => setRate(parseFloat(e.target.value))}
              className="flex-1 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full appearance-none cursor-pointer accent-blue-600" />
            <div className="relative w-20 shrink-0">
              <input type="text" inputMode="decimal" value={rate} onChange={handleNumInput(setRate)}
                className={`w-full pr-6 pl-2 py-1.5 rounded-lg text-sm font-bold text-right ${inputBase}`} />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 text-sm font-bold">%</span>
            </div>
          </div>
          {/* Presets */}
          <div className="flex flex-wrap gap-1.5 mt-2">
            {allPresets.map(p => (
              <button key={p.label} onClick={() => setRate(p.rate)}
                className={`px-2.5 py-1 rounded-lg text-[10px] font-bold transition-all border ${
                  rate === p.rate
                    ? PRESET_ACTIVE_CLASSES[p.color]
                    : 'bg-slate-50 dark:bg-slate-800 text-slate-500 border-slate-200/80 dark:border-slate-700/40 hover:border-slate-300 dark:hover:border-slate-600'
                }`}>
                {p.label} ({p.rate}%)
              </button>
            ))}
          </div>
        </div>

        {/* Duración */}
        <div>
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 block">{t('compound_calc.time_horizon')}</label>
          <div className="flex items-center gap-2">
            <input type="range" min="1" max="50" step="1" value={years} onChange={(e) => setYears(parseInt(e.target.value))}
              className="flex-1 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full appearance-none cursor-pointer accent-blue-600" />
            <div className="relative w-24 shrink-0">
              <input type="number" min="1" max="50" value={years} onChange={(e) => setYears(parseInt(e.target.value) || 1)}
                className={`w-full pr-12 pl-2 py-1.5 rounded-lg text-sm font-bold text-right ${inputBase}`} />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 font-bold">{t('compound_calc.years')}</span>
            </div>
          </div>
        </div>

        {/* Frecuencia + Inflación */}
        <div className="flex items-center gap-3">
          <div className="flex bg-slate-100 dark:bg-slate-800 p-0.5 rounded-lg flex-1">
            {[{ id: 'monthly', l: t('compound_calc.freq_monthly') }, { id: 'quarterly', l: t('compound_calc.freq_quarterly') }, { id: 'annual', l: t('compound_calc.freq_annual') }].map(f => (
              <button key={f.id} onClick={() => setFreq(f.id)}
                className={`flex-1 px-2 py-1.5 text-[10px] font-bold rounded-md transition-all ${freq === f.id ? 'bg-white dark:bg-slate-700 text-blue-600 shadow-xs' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}>
                {f.l}
              </button>
            ))}
          </div>
          <button onClick={() => setInflation(!inflation)}
            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] font-bold border transition-all shrink-0 ${
              inflation ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800' : 'bg-slate-50 dark:bg-slate-800 text-slate-500 border-slate-200/80 dark:border-slate-700/40 hover:text-slate-700'
            }`}>
            <Info className="w-3 h-3" /> {t('compound_calc.inflation')}
          </button>
        </div>
        {inflation && (
          <div className="flex items-center gap-2 text-[9px] font-medium text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/15 px-3 py-1.5 rounded-lg border border-amber-100 dark:border-amber-800/40">
            <Info className="w-3 h-3 shrink-0" />
            <span className="flex-1">{t('compound_calc.inflation_note')}</span>
            <div className="relative w-16 shrink-0">
              <input type="text" inputMode="decimal" value={inflationPct} onChange={handleNumInput(setInflationPct)}
                aria-label={t('compound_calc.inflation_rate')}
                className="w-full pr-5 pl-2 py-1 rounded-md bg-white/70 dark:bg-slate-900/50 border border-amber-200 dark:border-amber-800/40 text-[10px] font-bold text-right text-amber-700 dark:text-amber-300 outline-hidden focus:ring-2 focus:ring-amber-400/40 tabular-nums" />
              <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[9px] font-bold text-amber-500">%</span>
            </div>
          </div>
        )}

        {/* Objetivo */}
        <div className="rounded-xl border border-slate-200/60 dark:border-slate-700/30 bg-slate-50/60 dark:bg-slate-900/30 p-3">
          <label className="flex items-center gap-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">
            <Crosshair className="w-3 h-3" /> {t('compound_calc.goal_title')}
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm font-bold">{sym}</span>
            <input type="text" inputMode="decimal" value={goal} placeholder={t('compound_calc.goal_placeholder')}
              onChange={(e) => setGoal(e.target.value.replace(',', '.'))}
              className={`w-full pl-8 pr-3 py-2 rounded-xl text-sm font-bold placeholder:font-medium placeholder:text-slate-400 ${inputBase}`} />
          </div>
          {goalInfo && (
            <div className="mt-2 space-y-1 text-[10px] font-semibold">
              {goalInfo.year === 0 ? (
                <p className="text-emerald-600 dark:text-emerald-400">{t('compound_calc.goal_already')}</p>
              ) : goalInfo.year != null ? (
                <p className="text-emerald-600 dark:text-emerald-400">{t('compound_calc.goal_reached', { year: goalInfo.year })}</p>
              ) : (
                <p className="text-amber-600 dark:text-amber-400">{t('compound_calc.goal_not_reached')}</p>
              )}
              {goalInfo.required != null && goalInfo.required > 0 && (
                <p className="text-slate-500 dark:text-slate-400">
                  {t('compound_calc.goal_required', { years, sym, amount: fmt(Math.ceil(goalInfo.required), 0) })}
                </p>
              )}
            </div>
          )}
        </div>

        {/* ═══ RESULTS ═══ */}
        <div className="pt-2 border-t border-slate-100 dark:border-slate-700/60 space-y-4">
          {/* Hero KPIs */}
          <div className="grid grid-cols-2 gap-2.5">
            <div className="bg-linear-to-br from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/15 rounded-xl p-3 border border-blue-100/80 dark:border-blue-800/30">
              <p className="text-[9px] font-bold text-blue-500/70 uppercase tracking-wider mb-0.5">{t('compound_calc.kpi_final_value')}</p>
              <p className="text-lg font-black tabular-nums text-blue-700 dark:text-blue-300 leading-tight">{sym}{fmt(finalValue, 0)}</p>
              {inflation && (
                <p className="text-[8px] font-bold text-purple-500 dark:text-purple-400 mt-0.5">
                  {t('compound_calc.kpi_final_real', { sym, amount: fmt(finalValueReal, 0) })}
                </p>
              )}
            </div>
            <div className="bg-slate-50 dark:bg-slate-900/40 rounded-xl p-3 border border-slate-200/60 dark:border-slate-700/30">
              <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">{t('compound_calc.kpi_contributed')}</p>
              <p className="text-lg font-extrabold tabular-nums text-slate-700 dark:text-slate-200 leading-tight">{sym}{fmt(totalContributed, 0)}</p>
            </div>
            <div className="bg-emerald-50 dark:bg-emerald-900/15 rounded-xl p-3 border border-emerald-100/80 dark:border-emerald-800/30">
              <p className="text-[9px] font-bold text-emerald-500/70 uppercase tracking-wider mb-0.5">{t('compound_calc.kpi_interest')}</p>
              <p className="text-lg font-black tabular-nums text-emerald-700 dark:text-emerald-300 leading-tight">+{sym}{fmt(totalInterest, 0)}</p>
            </div>
            <div className="bg-purple-50 dark:bg-purple-900/15 rounded-xl p-3 border border-purple-100/80 dark:border-purple-800/30">
              <p className="text-[9px] font-bold text-purple-500/70 uppercase tracking-wider mb-0.5">{t('compound_calc.kpi_power')}</p>
              <p className="text-lg font-black tabular-nums text-purple-700 dark:text-purple-300 leading-tight">{fmt(compoundPower, 0)}%</p>
              <p className="text-[8px] text-purple-400 mt-0.5">{t('compound_calc.kpi_power_note')}</p>
            </div>
          </div>

          {/* Milestones */}
          {milestones.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {milestones.slice(0, 4).map(m => (
                <div key={m.value} className="flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-50 dark:bg-amber-900/15 border border-amber-200/60 dark:border-amber-800/30">
                  <Target className="w-3 h-3 text-amber-500" />
                  <span className="text-[9px] font-bold text-amber-700 dark:text-amber-300">{sym}{m.value >= 1e6 ? `${(m.value/1e6).toFixed(0)}M` : m.value >= 1e3 ? `${(m.value/1e3).toFixed(0)}k` : m.value}</span>
                  <span className="text-[8px] text-amber-500">{t('compound_calc.milestone_year', { n: m.year })}</span>
                </div>
              ))}
            </div>
          )}

          {/* Chart */}
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorContribs" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#94a3b8" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#94a3b8" stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="colorInterest" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.5} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" className="dark:stroke-slate-800" />
                <XAxis dataKey="year" axisLine={false} tickLine={false} tick={{ fontSize: 9, fill: '#94a3b8', fontWeight: 600 }} tickFormatter={v => `${v}${t('compound_calc.year_abbr')}`} interval={Math.max(1, Math.floor(years / 6))} />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 9, fill: '#94a3b8', fontWeight: 600 }} tickFormatter={v => v >= 1e6 ? `${(v/1e6).toFixed(1)}M` : v >= 1e3 ? `${(v/1e3).toFixed(0)}k` : v} />
                <Tooltip content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0].payload;
                  return (
                    <div className="bg-slate-900/97 border border-slate-700/60 p-3 rounded-xl shadow-2xl min-w-[180px]">
                      <p className="text-[10px] text-slate-400 font-bold uppercase mb-2">{t('compound_calc.tooltip_year', { year: d.year })}</p>
                      <div className="space-y-1">
                        <div className="flex justify-between"><span className="text-[10px] text-slate-300">{t('compound_calc.tooltip_contributions')}</span><span className="text-xs font-bold text-slate-200">{sym}{fmt(d.contributions, 0)}</span></div>
                        <div className="flex justify-between"><span className="text-[10px] text-emerald-400">{t('compound_calc.tooltip_interest')}</span><span className="text-xs font-bold text-emerald-300">+{sym}{fmt(d.interest, 0)}</span></div>
                        <div className="flex justify-between border-t border-slate-700/50 pt-1 mt-1"><span className="text-[10px] text-blue-400 font-bold">{t('compound_calc.tooltip_total')}</span><span className="text-sm font-black text-blue-300">{sym}{fmt(d.total, 0)}</span></div>
                        {inflation && (
                          <div className="flex justify-between"><span className="text-[10px] text-purple-400">{t('compound_calc.tooltip_real')}</span><span className="text-xs font-bold text-purple-300">{sym}{fmt(d.totalReal, 0)}</span></div>
                        )}
                      </div>
                    </div>
                  );
                }} />
                <Area type="monotone" dataKey="contributions" stackId="1" stroke="#94a3b8" strokeWidth={1.5} fillOpacity={1} fill="url(#colorContribs)" animationDuration={1000} />
                <Area type="monotone" dataKey="interest" stackId="1" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#colorInterest)" animationDuration={1200} />
                {inflation && (
                  <Line type="monotone" dataKey="totalReal" stroke="#8b5cf6" strokeWidth={2} strokeDasharray="5 4" dot={false} animationDuration={1200} />
                )}
                {goalNum > 0 && (
                  <ReferenceLine y={goalNum} ifOverflow="extendDomain" stroke="#f59e0b" strokeDasharray="4 4" strokeWidth={1.5} />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          {/* Legend */}
          <div className="flex items-center justify-center gap-4 text-[10px] font-bold text-slate-500">
            <span className="flex items-center gap-1"><span className="w-3 h-1.5 bg-slate-400 rounded-full inline-block" /> {t('compound_calc.legend_contributions')}</span>
            <span className="flex items-center gap-1"><span className="w-3 h-1.5 bg-emerald-500 rounded-full inline-block" /> {t('compound_calc.legend_interest')}</span>
            {inflation && (
              <span className="flex items-center gap-1"><span className="w-3 h-1.5 bg-purple-500 rounded-full inline-block" /> {t('compound_calc.legend_real')}</span>
            )}
            {goalNum > 0 && (
              <span className="flex items-center gap-1"><span className="w-3 h-1.5 bg-amber-500 rounded-full inline-block" /> {t('compound_calc.legend_goal')}</span>
            )}
          </div>

          {/* Collapsible Table */}
          <div>
            <button onClick={() => setShowTable(!showTable)} className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900/40 border border-slate-200/60 dark:border-slate-700/30 hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">{t('compound_calc.table_title')}</span>
              {showTable ? <ChevronUp className="w-3.5 h-3.5 text-slate-400" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />}
            </button>
            <AnimatePresence>
              {showTable && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25 }} className="overflow-hidden">
                  <div className="max-h-60 overflow-y-auto mt-2 rounded-lg border border-slate-200/60 dark:border-slate-700/30">
                    <table className="w-full text-[10px]">
                      <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10">
                        <tr className="text-slate-400 uppercase tracking-wider font-bold border-b border-slate-200 dark:border-slate-700">
                          <th className="px-2 py-2 text-left">{t('compound_calc.table_year')}</th>
                          <th className="px-2 py-2 text-right">{t('compound_calc.table_year_contrib')}</th>
                          <th className="px-2 py-2 text-right">{t('compound_calc.table_year_interest')}</th>
                          <th className="px-2 py-2 text-right font-black">{t('compound_calc.table_balance')}</th>
                          {inflation && <th className="px-2 py-2 text-right">{t('compound_calc.table_balance_real')}</th>}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
                        {tableData.map(r => (
                          <tr key={r.year} className="hover:bg-slate-50/80 dark:hover:bg-slate-800/30 transition-colors">
                            <td className="px-2 py-1.5 font-bold text-slate-600 dark:text-slate-300">{r.year}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{sym}{fmt(r.contribution, 0)}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-emerald-600 dark:text-emerald-400 font-semibold">+{sym}{fmt(r.interest, 0)}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums font-black text-slate-800 dark:text-white">{sym}{fmt(r.balance, 0)}</td>
                            {inflation && <td className="px-2 py-1.5 text-right tabular-nums text-purple-600 dark:text-purple-400 font-semibold">{sym}{fmt(r.balanceReal, 0)}</td>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CompoundInterestCalculator;
