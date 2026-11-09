import React from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, ChevronUp, ChevronDown, RotateCcw, LayoutGrid, Link2, Link2Off } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  moveWidget, moveWidgetWithPairs, toggleWidgetVisibility, togglePair, pairOf, applyPairAdjacency,
} from '@/services/dashboardLayout';

/**
 * Dialog to reorder, show/hide and PAIR dashboard widgets. Pure presentation:
 * it derives every new state with the pure helpers and hands it back through
 * `onChange(layout, pairs)`; persistence lives in the page.
 *
 * Pairing: between two ADJACENT rows that are both `half`-capable, a link
 * toggle joins them into one shared cell (mitad y mitad). Paired rows move as
 * a block. Pages without pairable widgets never show the toggle.
 */
const DashboardCustomizer = ({ open, onOpenChange, layout = [], pairs = [], onChange, onReset }) => {
  const { t } = useTranslation();
  const visibleCount = layout.filter((w) => w.visible).length;

  const arePaired = (a, b) => {
    const p = pairOf(pairs, a);
    return !!p && p.includes(b);
  };

  const handleMove = (id, delta) => {
    const next = pairs.length > 0
      ? moveWidgetWithPairs(layout, pairs, id, delta)
      : moveWidget(layout, id, delta);
    onChange(next, pairs);
  };

  const handleTogglePair = (a, b) => {
    const nextPairs = togglePair(pairs, a, b);
    onChange(applyPairAdjacency(layout, nextPairs), nextPairs);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md dark:bg-slate-900 border-none">
        <DialogHeader>
          <DialogTitle className="dark:text-white flex items-center gap-2">
            <LayoutGrid className="w-4 h-4 text-blue-600" />
            {t('dashboard.customize_title')}
          </DialogTitle>
          <DialogDescription>{t('dashboard.customize_desc')}</DialogDescription>
        </DialogHeader>

        <ul className="py-2 max-h-[55vh] overflow-y-auto pr-1">
          {layout.map((w, i) => {
            const next = layout[i + 1];
            const linkable = !!(next && w.half && next.half);
            const linked = linkable && arePaired(w.id, next.id);
            const inPairWithPrev = i > 0 && arePaired(layout[i - 1].id, w.id);
            return (
            <li key={w.id}>
              <div
                className={`flex items-center gap-2 border border-slate-200/80 dark:border-slate-700/40 px-3 py-2 ${w.visible ? '' : 'opacity-55'} ${
                  linked ? 'rounded-t-xl border-b-0 border-blue-300/60 dark:border-blue-500/40'
                    : inPairWithPrev ? 'rounded-b-xl border-t-0 border-blue-300/60 dark:border-blue-500/40'
                    : 'rounded-xl'
                }`}
              >
              <div className="flex flex-col shrink-0">
                <button
                  onClick={() => handleMove(w.id, -1)}
                  disabled={i === 0 || inPairWithPrev}
                  className="p-0.5 rounded text-slate-400 hover:text-blue-600 disabled:opacity-30 disabled:hover:text-slate-400 transition-colors"
                  aria-label={t('dashboard.customize_move_up')}
                >
                  <ChevronUp className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => handleMove(w.id, 1)}
                  disabled={i === layout.length - 1 || linked}
                  className="p-0.5 rounded text-slate-400 hover:text-blue-600 disabled:opacity-30 disabled:hover:text-slate-400 transition-colors"
                  aria-label={t('dashboard.customize_move_down')}
                >
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>
              </div>

              <span className="font-ledger text-[10px] uppercase tracking-[0.2em] text-slate-400 w-5 shrink-0">
                {String(i + 1).padStart(2, '0')}
              </span>

              <span className="flex-1 min-w-0 text-sm font-semibold text-slate-900 dark:text-white truncate">
                {t(w.labelKey)}
              </span>

              <button
                onClick={() => onChange(toggleWidgetVisibility(layout, w.id), pairs)}
                className={`p-1.5 rounded-lg transition-colors ${w.visible
                  ? 'text-blue-600 dark:text-blue-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                  : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                aria-label={w.visible ? t('dashboard.customize_hide') : t('dashboard.customize_show')}
                title={w.visible ? t('dashboard.customize_hide') : t('dashboard.customize_show')}
              >
                {w.visible ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
              </button>
              </div>

              {/* Link toggle between two adjacent pairable rows */}
              {linkable ? (
                <div className={`relative flex justify-center ${linked ? 'border-x border-blue-300/60 dark:border-blue-500/40' : ''}`}>
                  <button
                    onClick={() => handleTogglePair(w.id, next.id)}
                    className={`relative z-10 -my-0.5 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold border transition-colors ${linked
                      ? 'bg-blue-600 text-white border-blue-600 hover:bg-blue-500'
                      : 'bg-white dark:bg-slate-900 text-slate-400 border-slate-200 dark:border-slate-700 hover:text-blue-600 hover:border-blue-300'}`}
                    title={linked ? t('dashboard.customize_unlink') : t('dashboard.customize_link')}
                    aria-pressed={linked}
                  >
                    {linked ? <Link2 className="w-3 h-3" /> : <Link2Off className="w-3 h-3" />}
                    {linked ? t('dashboard.customize_linked') : t('dashboard.customize_link')}
                  </button>
                </div>
              ) : (
                i < layout.length - 1 && <div className="h-1.5" />
              )}
            </li>
            );
          })}
        </ul>

        <p className="font-ledger text-[10px] uppercase tracking-[0.2em] text-slate-400">
          {t('dashboard.customize_count', { visible: visibleCount, total: layout.length })}
        </p>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onReset} className="gap-2">
            <RotateCcw className="w-3.5 h-3.5" />
            {t('dashboard.customize_reset')}
          </Button>
          <Button onClick={() => onOpenChange(false)}>{t('common.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default DashboardCustomizer;
