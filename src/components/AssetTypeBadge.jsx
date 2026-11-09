import React from 'react';
import { useTranslation } from 'react-i18next';
import { typeLabelKey } from '@/lib/searchResults';

const TYPE_COLORS = {
  ETF:            'bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400',
  EQUITY:         'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400',
  CRYPTOCURRENCY: 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400',
  CURRENCY:       'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400',
  FUTURE:         'bg-rose-100 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400',
  INDEX:          'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400',
  MUTUALFUND:     'bg-teal-100 dark:bg-teal-900/30 text-teal-700 dark:text-teal-400',
};
const FALLBACK_COLOR = 'bg-slate-100 dark:bg-slate-700 text-slate-500';

/**
 * Etiqueta del tipo de un resultado de búsqueda (Acción, ETF, Fondo…), la
 * misma en la barra superior, Favoritos y el alta de posiciones. Un tipo que no
 * conocemos se enseña tal cual.
 * @param {{ type?: string, className?: string }} props
 */
export function AssetTypeBadge({ type, className = '' }) {
  const { t } = useTranslation();
  if (!type) return null;
  const upper = type.toUpperCase();
  const key = typeLabelKey(upper);
  return (
    <span className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider ${TYPE_COLORS[upper] || FALLBACK_COLOR} ${className}`}>
      {key ? t(key) : type}
    </span>
  );
}
