import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { PieChart, Waypoints } from 'lucide-react';
import { categoryLabel, endOfMonthIso, presentBreakdown } from '@/services/expenseService';
import MoneyFlowDialog from '@/components/expenses/MoneyFlowDialog';

// Cohesive categorical palette (works on both Ledger themes).
const COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#6366f1', '#f97316', '#14b8a6', '#a855f7', '#64748b'];

// Quick presets → [from, to]. 'ytd' = year-to-date. `to` is END OF THE CURRENT
// MONTH (not today) so current-month recurring occurrences dated later in the
// month — e.g. an autónomo income on the 28th — are included.
const presetRange = (key) => {
  const today = new Date();
  const to = endOfMonthIso(today);
  const d = new Date(today);
  if (key === 'ytd') return [`${today.getFullYear()}-01-01`, to];
  const months = { '1m': 1, '3m': 3, '6m': 6 }[key] || 1;
  d.setMonth(d.getMonth() - months);
  return [d.toISOString().split('T')[0], to];
};

/**
 * Donut of expense OR income totals per category over a selectable [from, to]
 * range. `rows`/`total` come from computeCategoryBreakdownRange; `entries` is the
 * raw list the parent aggregated (used for the click-to-drill-down detail). A
 * click on a slice or legend row expands the individual movements of that
 * category inside the range.
 *
 * OPTIONAL `flowEntries` + `flowYear`/`flowMonth`: enable the "Flujo del dinero"
 * button and its Sankey dialog (moved here from the calendar on 2026-07-31 —
 * the breakdown of a month is what the flow expands on). They are separate from
 * `entries` because the flow is scoped to ONE month and may include projected
 * occurrences, while `entries`/`rows` follow the donut's own [from, to] range.
 */
const MAX_SLICES = 8;

const ExpenseCategoryDonut = ({
  rows = [], total = 0, displayRows, amountsHidden = false, entries = [], from, to, type = 'expense',
  onTypeChange, onFromChange, onToChange, formatMoney, formatPercent = (p) => `${p.toFixed(0)}%`,
  flowEntries, flowYear, flowMonth, fxOpts,
  privacyMode,
}) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(null); // category slug or '__rest__' or null
  const [isFlowOpen, setIsFlowOpen] = useState(false);
  const presented = useMemo(() => {
    if (displayRows) return { amountsHidden, rows: displayRows };
    return presentBreakdown(rows, { privacyMode: !!privacyMode || amountsHidden });
  }, [displayRows, amountsHidden, rows, privacyMode]);
  const pctOf = (category, value) => {
    const hit = presented.rows.find((r) => r.category === category);
    if (hit && hit.pct != null) return hit.pct;
    return total > 0 ? (value / total) * 100 : 0;
  };
  const dateClass = 'px-2 py-1 border rounded-lg text-xs dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500';
  const segBtn = (active) => `px-2.5 py-1 text-xs font-semibold transition-colors ${active ? (type === 'income' ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white') : 'bg-white dark:bg-slate-800 text-slate-500'}`;

  const applyPreset = (key) => { const [f, tt] = presetRange(key); onFromChange(f); onToChange(tt); };
  const activePreset = useMemo(() => {
    for (const key of ['1m', '3m', '6m', 'ytd']) {
      const [f, tt] = presetRange(key);
      if (f === from && tt === to) return key;
    }
    return null;
  }, [from, to]);
  const presetBtn = (active) => `px-2 py-1 rounded-lg text-[11px] font-semibold transition-colors ${active ? 'bg-blue-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`;

  // Arc geometry: collapse a long tail into "Otros" so the donut stays readable.
  // Memoized because `detail` depends on it — a fresh array on every render
  // made that useMemo recompute constantly.
  const slices = useMemo(() => (
    rows.length > MAX_SLICES
      ? [...rows.slice(0, MAX_SLICES - 1), { category: '__rest__', value: rows.slice(MAX_SLICES - 1).reduce((s, r) => s + r.value, 0), rest: rows.slice(MAX_SLICES - 1) }]
      : rows
  ), [rows]);

  const colorOf = (i) => COLORS[i % COLORS.length];
  const toggle = (cat) => setExpanded((cur) => (cur === cat ? null : cat));

  // Individual movements of the expanded category within [from, to] (desc by date).
  const detail = useMemo(() => {
    if (!expanded) return null;
    const inRange = (e) => {
      const day = (e.entry_date || '').split('T')[0];
      return e.type === type && day && (!from || day >= from) && (!to || day <= to);
    };
    if (expanded === '__rest__') {
      return { kind: 'rest', rows: (slices.find((s) => s.category === '__rest__')?.rest || []) };
    }
    const list = entries
      .filter((e) => inRange(e) && (e.category || 'other') === expanded)
      .sort((a, b) => ((a.entry_date || '') < (b.entry_date || '') ? 1 : -1));
    return { kind: 'entries', rows: list };
  }, [expanded, entries, type, from, to, slices]);

  const expandedLabel = expanded === '__rest__' ? t('expenses.donut_other') : categoryLabel(t, expanded);

  return (
    <div className="h-full bg-white dark:bg-slate-800/80 rounded-2xl border border-slate-200/80 dark:border-slate-700/40 shadow-xs p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <PieChart className="w-4 h-4 text-blue-600" />
            {type === 'income' ? t('expenses.donut_title_income') : t('expenses.donut_title')}
          </p>
          {flowEntries && (
            <button
              type="button"
              onClick={() => setIsFlowOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300 hover:text-blue-600 hover:border-blue-400 dark:hover:text-blue-400 dark:hover:border-blue-500/60 transition-colors"
            >
              <Waypoints className="w-3.5 h-3.5" />
              {t('expenses.flow_button')}
            </button>
          )}
        </div>
        {/* Expense / Income toggle */}
        <div className="inline-flex rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700">
          <button type="button" onClick={() => { onTypeChange('expense'); setExpanded(null); }} className={segBtn(type === 'expense')}>{t('expenses.form_type_expense')}</button>
          <button type="button" onClick={() => { onTypeChange('income'); setExpanded(null); }} className={segBtn(type === 'income')}>{t('expenses.form_type_income')}</button>
        </div>
      </div>

      {/* Rango: presets y fechas. En móvil van en DOS bloques (los presets en una
          fila propia, los dos date en un grid 50/50) porque un `input[type=date]`
          mide ~125px de ancho intrínseco: los dos más los cuatro presets suman
          bastante más que los ~300px útiles de la card en un teléfono, y el
          flex-wrap los partía dejando un date colgando solo. */}
      <div className="flex flex-wrap items-center gap-1.5 gap-y-2 mb-4">
        {[['1m', t('expenses.range_1m')], ['3m', t('expenses.range_3m')], ['6m', t('expenses.range_6m')], ['ytd', t('expenses.range_ytd')]].map(([key, label]) => (
          <button key={key} type="button" onClick={() => applyPreset(key)} className={presetBtn(activePreset === key)}>{label}</button>
        ))}
        <span className="hidden sm:block w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1" />
        {/* basis-[calc(50%-...)] hace que en móvil las dos fechas caigan a la
            línea siguiente repartiéndosela al 50%; en sm+ recuperan su ancho
            natural y vuelven a la fila de los presets. */}
        <input
          type="date" value={from} max={to} onChange={(e) => onFromChange(e.target.value)}
          className={`${dateClass} basis-[calc(50%-0.375rem)] min-w-0 py-2 sm:basis-auto sm:py-1`}
          aria-label={t('expenses.donut_from')}
        />
        <span className="hidden sm:block text-slate-400 text-xs">→</span>
        <input
          type="date" value={to} min={from} onChange={(e) => onToChange(e.target.value)}
          className={`${dateClass} basis-[calc(50%-0.375rem)] min-w-0 py-2 sm:basis-auto sm:py-1`}
          aria-label={t('expenses.donut_to')}
        />
      </div>

      {slices.length === 0 || total <= 0 ? (
        <p className="text-xs text-slate-400 text-center py-10">{type === 'income' ? t('expenses.donut_empty_income') : t('expenses.donut_empty')}</p>
      ) : (
        <>
        <div className="grid md:grid-cols-[1fr_auto] gap-5 items-center">
          {/* Legend / breakdown — left (clickable rows) */}
          <ul className="space-y-1 order-2 md:order-1">
            {slices.map((s, i) => {
              const pct = pctOf(s.category, s.value);
              const label = s.category === '__rest__' ? t('expenses.donut_other') : categoryLabel(t, s.category);
              const isActive = expanded === s.category;
              return (
                <li key={s.category}>
                  <button
                    type="button"
                    onClick={() => toggle(s.category)}
                    className={`w-full flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left transition-colors ${isActive ? 'bg-slate-100 dark:bg-slate-700/50' : 'hover:bg-slate-50 dark:hover:bg-slate-700/30'}`}
                    aria-expanded={isActive}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: colorOf(i) }} />
                      <span className="text-xs text-slate-700 dark:text-slate-300 truncate">{label}</span>
                    </span>
                    <span className="font-ledger text-xs tabular-nums text-slate-500 dark:text-slate-400 shrink-0">
                      {presented.amountsHidden
                        ? formatPercent(pct)
                        : `${formatMoney(s.value, 0)} · ${formatPercent(pct)}`}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {/* Donut — right (clickable arcs) */}
          <div className="relative w-44 h-44 mx-auto order-1 md:order-2">
            <svg viewBox="0 0 200 200" className="transform -rotate-90">
              {(() => { let acc = 0; return slices.map((s, i) => {
                const pct = pctOf(s.category, s.value);
                const startAngle = (acc / 100) * 360;
                acc += pct;
                const endAngle = (acc / 100) * 360;
                const largeArc = pct > 50 ? 1 : 0;
                const x1 = 100 + 80 * Math.cos((startAngle * Math.PI) / 180);
                const y1 = 100 + 80 * Math.sin((startAngle * Math.PI) / 180);
                const x2 = 100 + 80 * Math.cos((endAngle * Math.PI) / 180);
                const y2 = 100 + 80 * Math.sin((endAngle * Math.PI) / 180);
                const dim = expanded && expanded !== s.category;
                const label = s.category === '__rest__' ? t('expenses.donut_other') : categoryLabel(t, s.category);
                return (
                  <path
                    key={s.category}
                    d={`M 100 100 L ${x1} ${y1} A 80 80 0 ${largeArc} 1 ${x2} ${y2} Z`}
                    fill={colorOf(i)}
                    role="button"
                    tabIndex={0}
                    aria-label={`${label}: ${formatPercent(pct)}`}
                    onClick={() => toggle(s.category)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(s.category); } }}
                    className={`cursor-pointer transition-opacity hover:opacity-80 focus:outline-hidden focus-visible:opacity-100 ${dim ? 'opacity-30' : ''}`}
                  />
                );
              }); })()}
              <circle cx="100" cy="100" r="52" className="fill-white dark:fill-slate-800" />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className="font-ledger text-[9px] uppercase tracking-[0.2em] text-slate-400">{t('expenses.donut_total')}</span>
              <span className="font-ledger text-base font-bold tabular-nums text-slate-900 dark:text-white">{formatMoney(total, 0)}</span>
            </div>
          </div>
        </div>

        {/* Drill-down detail of the clicked category */}
        {expanded && detail && (
          <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-700/50">
            <div className="flex items-center justify-between gap-3 mb-2">
              <p className="font-ledger text-[10px] uppercase tracking-[0.2em] text-slate-400">
                {t('expenses.donut_detail_of', { category: expandedLabel })}
              </p>
              <button type="button" onClick={() => setExpanded(null)} className="text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:underline">
                {t('expenses.donut_detail_close')}
              </button>
            </div>
            {detail.kind === 'rest' ? (
              <ul className="space-y-1 max-h-48 overflow-y-auto pr-1">
                {detail.rows.map((r) => (
                  <li key={r.category} className="flex items-center justify-between gap-3 text-xs px-1 py-1">
                    <span className="text-slate-600 dark:text-slate-300 truncate">{categoryLabel(t, r.category)}</span>
                    <span className="font-ledger tabular-nums text-slate-500 dark:text-slate-400 shrink-0">{formatMoney(r.value, 0)}</span>
                  </li>
                ))}
              </ul>
            ) : detail.rows.length === 0 ? (
              <p className="text-xs text-slate-400 py-2">{t('expenses.donut_no_entries')}</p>
            ) : (
              <ul className="space-y-1 max-h-48 overflow-y-auto pr-1">
                {detail.rows.map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-3 text-xs px-1 py-1">
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="font-ledger tabular-nums text-slate-400 shrink-0">{(e.entry_date || '').split('T')[0]}</span>
                      <span className="text-slate-600 dark:text-slate-300 truncate">{e.notes || categoryLabel(t, e.category)}</span>
                    </span>
                    <span className={`font-ledger tabular-nums shrink-0 ${type === 'income' ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400'}`}>
                      {formatMoney(e.amount, 2)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        </>
      )}

      {flowEntries && (
        <MoneyFlowDialog
          open={isFlowOpen}
          onOpenChange={setIsFlowOpen}
          entries={flowEntries}
          year={flowYear}
          month={flowMonth}
          fxOpts={fxOpts}
          formatMoney={formatMoney}
          formatPercent={formatPercent}
        />
      )}
    </div>
  );
};

export default ExpenseCategoryDonut;
