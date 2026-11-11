import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ResponsiveContainer, LineChart, Line, YAxis } from 'recharts';
import { Flag, Plus, Pencil, Trash2, CheckCircle2, Wallet, CalendarX, RotateCcw } from 'lucide-react';

/**
 * List card for purpose-based savings goals (envelope model). Pure presentation:
 * `goals` come with their progress attached ({ ...goal, progress }) —
 * progress is expenseService.computeGoalProgress output (allocation-based).
 * `availableToAllocate` = savings not yet assigned to any goal.
 * `onAllocate(goalId, amount)` sets the money assigned to a goal.
 * `onToggleComplete(goal, completed)` cierra/reabre una meta: una meta
 * cerrada deja de retener dinero (su saldo vuelve a `availableToAllocate`).
 * `balanceSeries` draws the 12-month savings sparkline.
 */
const SavingsGoalsCard = ({
  goals = [], balanceSeries = [], availableToAllocate = 0,
  formatMoney, formatPercent = (p) => `${Math.round(p)}%`,
  onAdd, onEdit, onDelete, onAllocate, onToggleComplete,
}) => {
  const { t } = useTranslation();
  const [allocEditId, setAllocEditId] = useState(null);
  const [allocInput, setAllocInput] = useState('');

  const startAllocate = (goal) => {
    setAllocEditId(goal.id);
    setAllocInput(goal.allocated_amount ? String(goal.allocated_amount) : '');
  };
  const confirmAllocate = async (goal) => {
    await onAllocate?.(goal.id, allocInput || 0);
    setAllocEditId(null);
  };

  // Two overlapping series so the projected stretch renders dashed; the last
  // real point is repeated in the projected series to keep the line connected.
  const sparkData = useMemo(() => {
    const lastRealIdx = balanceSeries.reduce((acc, b, i) => (b.projected ? acc : i), -1);
    return balanceSeries.map((b, i) => ({
      real: b.projected ? null : b.balance,
      projected: b.projected || i === lastRealIdx ? b.balance : null,
    }));
  }, [balanceSeries]);
  const hasProjectedStretch = balanceSeries.some((b) => b.projected);

  // Renders as an embeddable section (no card chrome) — the caller wraps it in
  // the shared "Objetivos" card next to the annual objective.
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <Flag className="w-4 h-4 text-blue-600" />
          {t('expenses.goals_title')}
          {goals.length > 0 && <span className="text-xs font-semibold text-slate-400">({goals.length})</span>}
        </p>
        <button
          onClick={onAdd}
          className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline"
        >
          <Plus className="w-3.5 h-3.5" />
          {t('expenses.goals_add')}
        </button>
      </div>

      {goals.length > 0 && (
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-2 font-ledger tabular-nums">
          {t('expenses.goals_available_label')}:{' '}
          <span className={`font-ledger font-bold ${availableToAllocate >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'}`}>
            {/* Con céntimos: es el mismo importe que "Ahorro libre" de la
                cabecera y los dos tienen que decir exactamente lo mismo. */}
            {availableToAllocate < 0 ? '−' : ''}{formatMoney(Math.abs(availableToAllocate), 2)}
          </span>
          {availableToAllocate < 0 && <span className="text-rose-500"> · {t('expenses.goals_over_allocated')}</span>}
        </p>
      )}

      {balanceSeries.length > 0 && (
        <div className="mt-3">
          <div className="h-14">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={sparkData} margin={{ top: 4, right: 2, left: 2, bottom: 0 }}>
                <YAxis hide domain={['dataMin', 'dataMax']} />
                <Line type="monotone" dataKey="real" stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="projected" stroke="#3b82f6" strokeWidth={2} strokeDasharray="4 4" strokeOpacity={0.55} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="font-ledger text-[9px] uppercase tracking-[0.2em] text-slate-400 mt-1">
            {t('expenses.balance_spark_label')}{hasProjectedStretch ? ` · ${t('expenses.projected_badge')} ---` : ''}
          </p>
        </div>
      )}

      {goals.length === 0 ? (
        <p className="text-xs text-slate-400 mt-3">{t('expenses.goals_empty_hint')}</p>
      ) : (
        <ul className="mt-4 space-y-4">
          {goals.map((goal) => {
            const p = goal.progress;
            return (
              <li key={goal.id} className="border border-slate-100 dark:border-slate-700/40 rounded-xl p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-slate-900 dark:text-white flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
                      <span className="wrap-break-word">{goal.name}</span>
                      {/* Un solo distintivo por meta, por prioridad: cerrada a
                          mano > vencida > conseguida. Dos etiquetas a la vez
                          ("¡Conseguida!" + "Completada") no añaden nada. */}
                      {p.completed ? (
                        <span className="inline-flex shrink-0 whitespace-nowrap items-center gap-1 text-[9px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-300 bg-slate-100 dark:bg-slate-700/60 rounded-full px-2 py-0.5">
                          <CheckCircle2 className="w-2.5 h-2.5" />
                          {t('expenses.goals_completed_badge')}
                        </span>
                      ) : p.expired ? (
                        <span className="inline-flex shrink-0 whitespace-nowrap items-center gap-1 text-[9px] font-bold uppercase tracking-wide text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 rounded-full px-2 py-0.5">
                          <CalendarX className="w-2.5 h-2.5" />
                          {t('expenses.goals_expired_badge')}
                        </span>
                      ) : p.reached && (
                        <span className="inline-flex shrink-0 whitespace-nowrap items-center gap-1 text-[9px] font-bold uppercase tracking-wide text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/30 rounded-full px-2 py-0.5">
                          <CheckCircle2 className="w-2.5 h-2.5" />
                          {t('expenses.goals_reached')}
                        </span>
                      )}
                    </p>
                    {/* Tres subtítulos posibles: objetivo+fecha, solo objetivo,
                        o sobre libre (ni uno ni otra). */}
                    <p className="text-xs text-slate-400 mt-0.5">
                      {p.isOpen
                        ? t('expenses.goals_envelope_line')
                        : p.hasDeadline
                          ? t('expenses.goals_target_line', { amount: formatMoney(p.target, 0), date: goal.target_date })
                          : t('expenses.goals_target_line_no_date', { amount: formatMoney(p.target, 0) })}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => onEdit(goal)}
                      className="inline-flex items-center justify-center min-w-[40px] min-h-[40px] lg:min-w-0 lg:min-h-0 p-2 lg:p-1.5 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                      aria-label={t('expenses.goals_edit')}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => onDelete(goal)}
                      className="inline-flex items-center justify-center min-w-[40px] min-h-[40px] lg:min-w-0 lg:min-h-0 p-2 lg:p-1.5 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                      aria-label={t('expenses.goals_delete_confirm_title')}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* La barra SOLO existe si hay objetivo. Un sobre libre con una
                    barra al 0% se lee como algo que va mal, cuando va bien. */}
                {!p.isOpen && (
                  <div className="relative h-2.5 rounded-full bg-slate-100 dark:bg-slate-700/60 overflow-hidden mt-3">
                    <div
                      className={`absolute inset-y-0 left-0 rounded-full transition-all ${p.closed ? 'bg-slate-300 dark:bg-slate-600' : p.reached ? 'bg-emerald-500' : 'bg-blue-500'}`}
                      style={{ width: `${p.pct}%` }}
                    />
                  </div>
                )}

                {/* Si un proyecto ya ha consumido parte del sobre hay que DECIRLO:
                    el saldo baja solo y sin esta línea parecería que se ha
                    perdido dinero. */}
                {p.spent > 0 && (
                  <p className="text-[11px] text-slate-400 mt-2 font-ledger tabular-nums">
                    {t('expenses.goals_spent_line', {
                      assigned: formatMoney(p.assigned, 0),
                      spent: formatMoney(p.spent, 0),
                    })}
                  </p>
                )}

                {/* Pasarse del sobre YA no se traga en silencio. El saldo se
                    queda en 0 (el exceso ya bajó del ahorro por su propio
                    gasto), pero el usuario tiene que ver por cuánto se pasó. */}
                {p.overspent > 0 && (
                  <p className="text-[11px] text-rose-500 dark:text-rose-400 mt-1 font-ledger tabular-nums font-semibold">
                    {t('expenses.goals_overspent_line', { value: formatMoney(p.overspent, 0) })}
                  </p>
                )}

                {/* Una meta cerrada no retiene dinero: decirlo aquí es lo que
                    explica que "Disponible para asignar" acabe de subir. */}
                {p.closed && (
                  <p className="text-[11px] text-slate-400 mt-2">
                    {p.expired && <span className="text-amber-600 dark:text-amber-400">{t('expenses.goals_expired_hint')} · </span>}
                    {p.completed && goal.completed_at && (
                      <span>{t('expenses.goals_completed_on', { date: String(goal.completed_at).split('T')[0] })} · </span>
                    )}
                    {p.released > 0
                      ? <span className="font-ledger tabular-nums">{t('expenses.goals_released_line', { value: formatMoney(p.released, 0) })}</span>
                      : t('expenses.goals_released_none')}
                  </p>
                )}

                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 mt-2">
                  <span className="text-xs text-slate-500 dark:text-slate-400 font-ledger tabular-nums">
                    {/* LA CIFRA ES LO QUE EL SOBRE RETIENE AHORA, no lo que se
                        apartó en su día: es exactamente lo que suma "Asignado a
                        metas" de la cabecera. Antes la tarjeta pintaba el bruto
                        (`p.allocated`) y las dos superficies no cuadraban —
                        medido en la demo: 10.755 € en las tarjetas contra 8.324 €
                        en el hero, 2.431 € de diferencia entre metas cerradas
                        (ya no retienen) y sobres ya gastados. El PORCENTAJE sí
                        sigue el progreso (congelado si está conseguida), que es
                        otra magnitud: logro, no saldo. */}
                    {p.closed
                      ? t('expenses.goals_released_label')
                      : p.isOpen ? t('expenses.goals_saved_label') : t('expenses.goals_held_label')}:{' '}
                    <span className={`font-ledger font-bold ${p.closed ? 'text-slate-400 line-through decoration-slate-300 dark:decoration-slate-600' : 'text-slate-900 dark:text-white'}`}>
                      {formatMoney(p.closed ? p.released : p.balance, 0)}
                    </span>
                    {p.pct !== null && ` (${formatPercent(p.pct)})`}
                  </span>
                  {!p.reached && p.neededPerMonth !== null && (
                    <span className="text-xs text-slate-500 dark:text-slate-400 font-ledger tabular-nums">
                      {p.monthsLeft === 1
                        ? t('expenses.goals_needed_this_month', { value: formatMoney(p.neededPerMonth, 0) })
                        : t('expenses.goals_needed_label', { value: formatMoney(p.neededPerMonth, 0) })}
                    </span>
                  )}
                </div>

                {allocEditId === goal.id ? (
                  <div className="flex items-center gap-2 mt-3">
                    <input
                      type="text" inputMode="decimal" autoComplete="off" autoFocus
                      className="w-28 px-3 py-1.5 font-ledger tabular-nums border rounded-lg text-sm text-right dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500"
                      value={allocInput}
                      onChange={(e) => setAllocInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirmAllocate(goal); } if (e.key === 'Escape') setAllocEditId(null); }}
                    />
                    <button onClick={() => confirmAllocate(goal)} className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 transition-colors">{t('expenses.save')}</button>
                    <button onClick={() => setAllocEditId(null)} className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-600 dark:text-slate-300">{t('expenses.cancel')}</button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 mt-2">
                    <span className="text-[11px] text-slate-400 font-ledger tabular-nums">
                      {/* El saldo ya es la cifra principal ("En el sobre: €9"),
                          así que aquí no se repite: queda el estado. Cerrada no
                          dice nada — lo cuenta la línea de "Liberado". */}
                      {p.closed
                        ? ''
                        : p.isOpen
                          ? t('expenses.goals_envelope_free')
                          : p.reached
                            ? t('expenses.goals_reached')
                            : t('expenses.goals_remaining_label', { value: formatMoney(p.remaining, 0) })}
                    </span>
                    <div className="flex items-center gap-3 ml-auto">
                      {/* Asignar solo mientras la meta sigue viva: meter dinero en
                          un sobre cerrado no lo retendría, así que ofrecerlo
                          sería prometer algo que no pasa. Para volver a usarla:
                          Reabrir (completada) o cambiar la fecha (vencida). */}
                      {!p.closed && (
                        <button
                          onClick={() => startAllocate(goal)}
                          className="inline-flex items-center gap-1 min-h-[40px] lg:min-h-0 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          <Wallet className="w-3.5 h-3.5" />
                          {t('expenses.goals_allocate')}
                        </button>
                      )}
                      {onToggleComplete && (
                        p.completed ? (
                          <button
                            onClick={() => onToggleComplete(goal, false)}
                            className="inline-flex items-center gap-1 min-h-[40px] lg:min-h-0 text-xs font-semibold text-slate-500 dark:text-slate-400 hover:underline"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            {t('expenses.goals_reopen')}
                          </button>
                        ) : (
                          <button
                            onClick={() => onToggleComplete(goal, true)}
                            className={`inline-flex items-center gap-1 min-h-[40px] lg:min-h-0 text-xs font-semibold hover:underline ${p.expired ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            {t('expenses.goals_complete')}
                          </button>
                        )
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default SavingsGoalsCard;
