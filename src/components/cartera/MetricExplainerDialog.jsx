import React from 'react';
import { useTranslation } from 'react-i18next';
import { Sigma, BookOpen } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { formatNumber, formatMoney, formatPercent } from '@/lib/formatters';

/**
 * Metric explainer dialog for the brokers screen header tiles/chips.
 *
 * NeuroUI rationale:
 *  - The user taps FROM a number, so the dialog leads with THEIR live value
 *    (visual hierarchy: value → formula → meaning). Muted semantic colors —
 *    a losing metric must inform, not alarm.
 *  - Formula wraps (no horizontal scroll on mobile) in a mono block.
 *  - Meaning in regular type (italics hurt legibility on long copy).
 *
 * @param {string|null} metric        metric id (key of explanations) or null when closed
 * @param {object} explanations       id → { title, formula, description }
 * @param {object} liveValues         id → { value:number|null, format:'money'|'pct'|'x', note?, example? }
 *                                    example: la cuenta hecha con los números del usuario
 *                                    (p. ej. por qué su anualizada no es "TWR ÷ años").
 */
export default function MetricExplainerDialog({
  metric,
  explanations,
  liveValues = {},
  preferredCurrency,
  maskMoney = (s) => s,
  onClose,
}) {
  const { t } = useTranslation();
  const info = metric ? explanations[metric] : null;
  const live = metric ? liveValues[metric] : null;
  const renderLive = () => {
    if (!live || live.value == null || Number.isNaN(live.value)) return null;
    const v = live.value;
    const positive = v >= 0;
    const text = live.format === 'pct'
      ? formatPercent(v, 2, { sign: true })
      : live.format === 'x'
        ? `${formatNumber(v, 2, 2)}×`
        : maskMoney(formatMoney(v, preferredCurrency, { sign: true }));
    return (
      <div className="rounded-xl px-4 py-3 bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/50 flex items-baseline justify-between gap-3">
        <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500">
          {t('cartera.metric_current_value')}
        </span>
        <span className={`text-2xl font-extrabold tabular-nums ${
          live.format === 'x' ? 'text-slate-900 dark:text-white'
            : positive ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-rose-500 dark:text-rose-400'
        }`}>
          {text}
        </span>
      </div>
    );
  };

  /**
   * Nota opcional bajo el valor: el periodo concreto sobre el que se ha
   * calculado. Una métrica anualizada sin su ventana no se puede contrastar con
   * nada — quien no reconoce el número no tiene forma de saber si el error está
   * en la fórmula o en sus datos.
   */
  const renderNote = () => {
    if (!live?.note) return null;
    return (
      <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400 -mt-1.5 px-1">
        {live.note}
      </p>
    );
  };

  return (
    <Dialog open={!!metric} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 text-slate-900 dark:text-white">
            <span className="w-8 h-8 rounded-lg bg-blue-50 dark:bg-blue-900/30 flex items-center justify-center shrink-0">
              <Sigma className="w-4 h-4 text-blue-500 dark:text-blue-400" />
            </span>
            {info?.title}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {renderLive()}
          {renderNote()}

          {live?.example && (
            <div className="space-y-1.5">
              <h4 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">
                {t('cartera.metric_example_label')}
              </h4>
              <p className="text-sm text-slate-700 dark:text-slate-200 leading-relaxed bg-blue-50/60 dark:bg-blue-900/15 border border-blue-100 dark:border-blue-900/40 rounded-xl px-4 py-3">
                {live.example}
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <h4 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">
              {t('cartera.metric_calc_label')}
            </h4>
            <div className="bg-slate-50 dark:bg-slate-900/50 px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-800 font-mono text-[13px] leading-relaxed text-blue-600 dark:text-blue-400 whitespace-normal wrap-break-word">
              {info?.formula}
            </div>
          </div>

          <div className="space-y-1.5">
            <h4 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest flex items-center gap-1">
              <BookOpen className="w-3 h-3" />
              {t('cartera.metric_meaning_label')}
            </h4>
            <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
              {info?.description}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="w-full sm:w-auto">
            {t('cartera.got_it')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
