import React, { useState, useEffect } from 'react';
import { AlertTriangle, CheckCircle, Loader2, ChevronDown, ChevronUp, Sparkles, Pencil, Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAiUsage } from '@/hooks/useAiUsage';

// Fields the user can correct inline → [input type, parsedRow key]
const FIXABLE_FIELDS = {
  'Price':    { type: 'number', key: 'precio' },
  'Quantity': { type: 'number', key: 'cantidad' },
  'Date':     { type: 'date',   key: 'transaction_date' },
  'ISIN':     { type: 'text',   key: 'isin' },
  'Currency': { type: 'text',   key: 'moneda' },
};

function IssueRow({ issue, idx, onFixRow }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [value, setValue]     = useState('');
  const [fixed, setFixed]     = useState(false);

  const fixable = FIXABLE_FIELDS[issue.field];
  const canEdit = !!fixable && !!onFixRow;

  const fieldLabels = {
    'Price':    t('cartera.field_price'),
    'Quantity': t('cartera.field_quantity'),
    'Date':     t('cartera.field_date'),
    'ISIN':     'ISIN',
    'Currency': t('cartera.field_currency'),
  };
  const fieldLabel = fieldLabels[issue.field] ?? issue.field;

  function startEdit() {
    setValue(issue.suggestion || '');
    setEditing(true);
  }

  function confirm() {
    if (!value.trim()) return;
    onFixRow(issue.rowIndex, issue.field, value.trim());
    setFixed(true);
    setEditing(false);
  }

  if (fixed) {
    return (
      <div className="px-4 py-2.5 flex items-center gap-2 bg-emerald-50 dark:bg-emerald-900/10">
        <CheckCircle className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
        <span className="text-[12px] text-emerald-700 dark:text-emerald-400 font-medium">
          {t('cartera.validation_fixed_prefix', { row: issue.rowIndex, field: fieldLabel })} <strong>{value}</strong>
        </span>
      </div>
    );
  }

  return (
    <div className={`px-4 py-3 ${issue.severity === 'error' ? 'bg-red-50 dark:bg-red-900/10' : 'bg-amber-50 dark:bg-amber-900/10'}`}>
      <div className="flex items-start gap-2">
        <AlertTriangle className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${issue.severity === 'error' ? 'text-red-500' : 'text-amber-500'}`} />

        <div className="min-w-0 flex-1">
          {/* Header row */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`font-semibold text-sm ${issue.severity === 'error' ? 'text-red-700 dark:text-red-400' : 'text-amber-700 dark:text-amber-400'}`}>
              {t('cartera.validation_row', { n: issue.rowIndex })}
            </span>
            {issue.field && (
              <span className="px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-[10px] font-mono">
                {fieldLabel}
              </span>
            )}
            {issue.autoFixable && (
              <span className="px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 text-[10px] font-semibold">
                {t('cartera.validation_auto_fix_label')}
              </span>
            )}
          </div>

          {/* Row preview */}
          {issue.rowPreview && (
            <p className="mt-1 font-mono text-[11px] text-slate-500 dark:text-slate-400 truncate">
              {issue.rowPreview}
            </p>
          )}

          {/* Issue description */}
          <p className="mt-1 text-[12px] text-slate-700 dark:text-slate-300">{issue.issue}</p>

          {/* Suggestion */}
          {issue.suggestion && !editing && (
            <p className="mt-0.5 text-[12px] text-blue-600 dark:text-blue-400">
              <span className="font-semibold">{t('cartera.validation_suggestion')}</span> {issue.suggestion}
            </p>
          )}

          {/* Inline editor */}
          {editing && canEdit ? (
            <div className="mt-2 flex items-center gap-2">
              <input
                autoFocus
                type={fixable.type}
                value={value}
                onChange={e => setValue(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') confirm(); if (e.key === 'Escape') setEditing(false); }}
                step={fixable.type === 'number' ? '0.0001' : undefined}
                min={fixable.type === 'number' ? '0' : undefined}
                className="flex-1 h-8 px-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500"
                placeholder={t('cartera.validation_placeholder', { field: fieldLabel })}
              />
              <button
                onClick={confirm}
                className="h-8 w-8 rounded-lg bg-blue-600 hover:bg-blue-700 flex items-center justify-center transition-colors"
              >
                <Check className="w-3.5 h-3.5 text-white" />
              </button>
              <button
                onClick={() => setEditing(false)}
                className="h-8 w-8 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center transition-colors"
              >
                <X className="w-3.5 h-3.5 text-slate-500" />
              </button>
            </div>
          ) : (
            canEdit && !editing && (
              <button
                onClick={startEdit}
                className="mt-2 flex items-center gap-1.5 text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
              >
                <Pencil className="w-3 h-3" />
                {t('cartera.validation_fix')}
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * ImportValidationPanel
 *
 * Props:
 *   issues            – array from useImportValidator
 *   validating        – boolean
 *   validationWarning – string | null
 *   onFixRow          – (rowIndex, field, value) => void  (optional)
 */
export default function ImportValidationPanel({ issues = [], validating, validationWarning, onFixRow }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const [hasStarted, setHasStarted] = useState(false);
  const { dailyLeft, monthlyLeft, exhausted } = useAiUsage('import');

  useEffect(() => {
    if (validating) setHasStarted(true);
  }, [validating]);

  const isDone     = hasStarted && !validating;
  const hasResults = issues.length > 0 || validationWarning;

  if (!validating && !hasStarted && !hasResults) return null;

  const errors   = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden text-sm">
      {/* Header */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-2 px-4 py-2.5 bg-slate-50 dark:bg-slate-800/60 hover:bg-slate-100 dark:hover:bg-slate-700/50 transition-colors text-left"
      >
        <Sparkles className="w-3.5 h-3.5 text-blue-500 shrink-0" />
        <span className="font-semibold text-slate-700 dark:text-slate-200 flex-1">
          {t('cartera.validation_ai_title')}
          {validating && <span className="ml-2 text-slate-400 font-normal">{t('cartera.validation_analyzing')}</span>}
          {isDone && issues.length > 0 && (
            <span className="ml-2 font-normal text-slate-400">
              {errors.length > 0 && <span className="text-red-500">{t('cartera.validation_errors', { count: errors.length })}</span>}
              {errors.length > 0 && warnings.length > 0 && <span className="mx-1">·</span>}
              {warnings.length > 0 && <span className="text-amber-500">{t('cartera.validation_warnings', { count: warnings.length })}</span>}
            </span>
          )}
          {isDone && issues.length === 0 && !validationWarning && (
            <span className="ml-2 font-normal text-emerald-500">{t('cartera.validation_no_issues')}</span>
          )}
        </span>

        {/* Quota badge */}
        <span className={`shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-full mr-1 ${
          exhausted
            ? 'bg-rose-100 text-rose-600 dark:bg-rose-500/20 dark:text-rose-400'
            : dailyLeft <= 2
            ? 'bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400'
            : 'bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400'
        }`}>
          {exhausted ? t('cartera.validation_limit') : t('cartera.validation_remaining', { n: dailyLeft })}
        </span>

        {validating
          ? <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />
          : expanded
            ? <ChevronUp className="w-3.5 h-3.5 text-slate-400" />
            : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
        }
      </button>

      {/* Body */}
      {expanded && !validating && (
        <div className="divide-y divide-slate-100 dark:divide-slate-700/50 max-h-56 overflow-y-auto">
          {validationWarning && (
            <div className="px-4 py-3 flex items-start gap-2 bg-amber-50 dark:bg-amber-900/10">
              <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
              <p className="text-amber-700 dark:text-amber-400">{validationWarning}</p>
            </div>
          )}

          {issues.length === 0 && !validationWarning && (
            <div className="px-4 py-3 flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
              <CheckCircle className="w-4 h-4 shrink-0" />
              <span>{t('cartera.validation_no_issues_detail')}</span>
            </div>
          )}

          {issues.map((issue, idx) => (
            <IssueRow key={`${issue.rowIndex}-${issue.field}-${idx}`} issue={issue} idx={idx} onFixRow={onFixRow} />
          ))}
        </div>
      )}
    </div>
  );
}
