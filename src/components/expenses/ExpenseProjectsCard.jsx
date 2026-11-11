import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Plane, Plus, Pencil, Trash2, ChevronDown } from 'lucide-react';
import { categoryLabel, computeProjectSummary } from '@/services/expenseService';

// Misma paleta categórica que el donut de reparto: un mismo gasto debe llevar el
// mismo color en las dos superficies o el usuario deja de fiarse de los colores.
const COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#6366f1', '#f97316', '#14b8a6', '#a855f7', '#64748b'];

/**
 * Proyectos/eventos de gasto: "cuánto nos hemos dejado en el viaje, y en qué".
 *
 * Presentación pura: los totales y el desglose salen de `computeProjectSummary`
 * (servicio, decimal.js, testeado). El proyecto es una etiqueta ORTOGONAL a la
 * categoría, así que cada fila puede desglosarse por categoría — que es
 * justamente lo que una "categoría viaje" no podría responder.
 *
 * `goalsById` trae los sobres de ahorro enlazados: cuando un proyecto tiene uno,
 * la barra compara lo GASTADO con lo APARTADO. Sin sobre no hay barra: no hay
 * referencia contra la que medir y un porcentaje inventado sería ruido.
 */
const ExpenseProjectsCard = ({
  projects = [], entries = [], goalsById = {}, fxOpts, formatMoney, formatPercent = (p) => `${p.toFixed(0)}%`,
  onAdd, onEdit, onDelete,
}) => {
  const { t } = useTranslation();
  const [expandedId, setExpandedId] = useState(null);

  const summaries = useMemo(() => {
    const map = {};
    for (const p of projects) {
      map[p.id] = computeProjectSummary(entries, {
        projectId: p.id,
        goal: p.goal_id ? goalsById[p.goal_id] : null,
        ...fxOpts,
      });
    }
    return map;
  }, [projects, entries, goalsById, fxOpts]);

  const dateRangeLabel = (project, s) => {
    const from = (project.start_date || s.firstDate || '').split('T')[0];
    const to = (project.end_date || s.lastDate || '').split('T')[0];
    if (!from && !to) return null;
    if (from && to && from !== to) return `${from} → ${to}`;
    return from || to;
  };

  return (
    <div className="h-full bg-white dark:bg-slate-800/80 rounded-2xl border border-slate-200/80 dark:border-slate-700/40 shadow-xs p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <Plane className="w-4 h-4 text-blue-600" />
          {t('expenses.projects_title')}
          {projects.length > 0 && <span className="text-xs font-semibold text-slate-400">({projects.length})</span>}
        </p>
        <button
          onClick={onAdd}
          className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline"
        >
          <Plus className="w-3.5 h-3.5" />
          {t('expenses.projects_add')}
        </button>
      </div>

      {projects.length === 0 ? (
        <p className="text-xs text-slate-400 mt-3">{t('expenses.projects_empty_hint')}</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {projects.map((project) => {
            const s = summaries[project.id];
            const isOpen = expandedId === project.id;
            const range = dateRangeLabel(project, s);
            return (
              <li key={project.id} className="border border-slate-100 dark:border-slate-700/40 rounded-xl p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-slate-900 dark:text-white truncate">{project.name}</p>
                    <p className="text-xs text-slate-400 mt-0.5 font-ledger tabular-nums">
                      {range || t('expenses.projects_no_dates')}
                      {' · '}
                      {t('expenses.projects_movements', { count: s.count })}
                    </p>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      onClick={() => onEdit(project)}
                      className="inline-flex items-center justify-center min-w-[40px] min-h-[40px] lg:min-w-0 lg:min-h-0 p-2 lg:p-1.5 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                      aria-label={t('expenses.projects_edit')}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => onDelete(project)}
                      className="inline-flex items-center justify-center min-w-[40px] min-h-[40px] lg:min-w-0 lg:min-h-0 p-2 lg:p-1.5 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                      aria-label={t('expenses.projects_delete_confirm_title')}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <p className="mt-2 font-ledger text-2xl font-bold tabular-nums tracking-tight text-slate-900 dark:text-white wrap-break-word">
                  {formatMoney(s.total, 0)}
                </p>
                {s.refunded > 0 && (
                  <p className="text-[11px] text-slate-400 font-ledger tabular-nums">
                    {t('expenses.projects_net_hint', { spent: formatMoney(s.spent, 0), refunded: formatMoney(s.refunded, 0) })}
                  </p>
                )}

                {/* Comparación con el sobre: solo si hay uno enlazado. */}
                {s.allocated !== null && s.pct !== null && (
                  <div className="mt-2">
                    <div className="relative h-2 rounded-full bg-slate-100 dark:bg-slate-700/60 overflow-hidden">
                      <div
                        className={`absolute inset-y-0 left-0 rounded-full transition-all ${s.overGoal ? 'bg-rose-500' : 'bg-emerald-500'}`}
                        style={{ width: `${Math.min(100, s.pct)}%` }}
                      />
                    </div>
                    <p className={`text-[11px] mt-1 font-ledger tabular-nums ${s.overGoal ? 'text-rose-500 dark:text-rose-400' : 'text-slate-400'}`}>
                      {s.overGoal
                        ? t('expenses.projects_over_goal', { value: formatMoney(s.total - s.allocated, 0), allocated: formatMoney(s.allocated, 0) })
                        : t('expenses.projects_of_goal', { pct: formatPercent(s.pct), allocated: formatMoney(s.allocated, 0) })}
                    </p>
                  </div>
                )}

                {/* Desglose por categoría — el motivo de existir del widget */}
                {s.rows.length > 0 && (
                  <>
                    <ul className="mt-3 space-y-1.5">
                      {(isOpen ? s.rows : s.rows.slice(0, 4)).map((row, i) => (
                        <li key={row.category} className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                          <span className="text-xs text-slate-600 dark:text-slate-300 truncate min-w-0 flex-1">
                            {categoryLabel(t, row.category)}
                          </span>
                          <span className="relative h-1.5 w-16 sm:w-24 rounded-full bg-slate-100 dark:bg-slate-700/60 overflow-hidden shrink-0">
                            <span
                              className="absolute inset-y-0 left-0 rounded-full"
                              style={{ width: `${row.pct}%`, backgroundColor: COLORS[i % COLORS.length] }}
                            />
                          </span>
                          <span className="font-ledger text-xs tabular-nums text-slate-500 dark:text-slate-400 shrink-0 w-20 text-right">
                            {formatMoney(row.value, 0)} · {formatPercent(row.pct)}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {s.rows.length > 4 && (
                      <button
                        onClick={() => setExpandedId(isOpen ? null : project.id)}
                        className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:underline"
                        aria-expanded={isOpen}
                      >
                        <ChevronDown className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                        {isOpen ? t('expenses.projects_show_less') : t('expenses.projects_show_all', { count: s.rows.length })}
                      </button>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default ExpenseProjectsCard;
