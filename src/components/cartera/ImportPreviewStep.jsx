import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, AlertTriangle, ShieldCheck, ShieldAlert } from 'lucide-react';
import ImportValidationPanel from '@/components/ImportValidationPanel';

/**
 * STEP 2 (preview) body of the import dialog: transaction summary, AI-parsed
 * banner, IBKR parse warnings, the AI validation panel, and the auto-fix
 * button. Extracted from CarteraPage. Presentational — row edits and auto-fix
 * are delegated to the parent (onFixRow / onAutoFix), which owns the data.
 *
 * Props:
 *   pendingImportData – parsed rows pending confirmation
 *   ibkrParseWarnings – [{ code, types?|symbols? }] warning descriptors
 *   enableAIValidation– whether AI validation is on
 *   validationIssues  – issues from the validator
 *   validating        – true while validation runs
 *   validationWarning – non-blocking validator warning string
 *   onFixRow          – (rowIndex, field, value) => void, applies one fix
 *   onAutoFix         – () => void, applies all auto-fixable issues
 *   importAudit       – DeGiro ledger reconciliation ({checked, matched, mismatches}|null)
 *   unrecognizedRows  – rows no keyword list matched (silently dropped otherwise)
 *   onReportCsv       – opt-in anonymized sample report to support
 *   csvReportSent     – true once the sample was shared
 */
const ImportPreviewStep = ({
  pendingImportData,
  ibkrParseWarnings,
  enableAIValidation,
  validationIssues,
  validating,
  validationWarning,
  onFixRow,
  onAutoFix,
  importAudit,
  unrecognizedRows = [],
  onReportCsv,
  csvReportSent,
}) => {
  const { t } = useTranslation();
  const [showUnrecognized, setShowUnrecognized] = useState(false);

  const buys  = pendingImportData.filter(t => t.type === 'BUY').length;
  const sells = pendingImportData.filter(t => t.type === 'SELL').length;
  const divs  = pendingImportData.filter(t => t.type === 'DIVIDEND').length;
  const fees  = pendingImportData.filter(t => t.type === 'FEE' || t.type === 'FEES').length;
  const cash  = pendingImportData.filter(t => t.type === 'CASH').length;
  const total = pendingImportData.length;

  const fixableCount = validationIssues.filter(i => i.autoFixable).length;

  return (
    <div className="space-y-4 pb-4">

      {/* Transaction summary */}
      <div className="rounded-xl bg-slate-50 dark:bg-slate-800/50 p-4">
        <div className="flex items-baseline gap-2 mb-3">
          <span className="text-2xl font-black text-slate-900 dark:text-white">{total}</span>
          <span className="text-sm text-slate-500">{t('cartera.tx_found')}</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {buys  > 0 && <span className="px-2.5 py-1 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 text-[11px] font-bold text-emerald-700 dark:text-emerald-400">{t('cartera.badge_buys', { count: buys })}</span>}
          {sells > 0 && <span className="px-2.5 py-1 rounded-lg bg-rose-100 dark:bg-rose-900/30 text-[11px] font-bold text-rose-600 dark:text-rose-400">{t('cartera.badge_sells', { count: sells })}</span>}
          {divs  > 0 && <span className="px-2.5 py-1 rounded-lg bg-blue-100 dark:bg-blue-900/30 text-[11px] font-bold text-blue-700 dark:text-blue-400">{t('cartera.badge_divs', { count: divs })}</span>}
          {fees  > 0 && <span className="px-2.5 py-1 rounded-lg bg-amber-100 dark:bg-amber-900/30 text-[11px] font-bold text-amber-700 dark:text-amber-400">{t('cartera.badge_fees', { count: fees })}</span>}
          {cash  > 0 && <span className="px-2.5 py-1 rounded-lg bg-purple-100 dark:bg-purple-900/30 text-[11px] font-bold text-purple-700 dark:text-purple-400">{t('cartera.badge_cash', { count: cash })}</span>}
        </div>
      </div>

      {/* Ledger reconciliation — the CSV audits its own parsing (DeGiro) */}
      {importAudit && importAudit.checked > 0 && (
        importAudit.mismatches.length === 0 ? (
          <div className="flex items-center gap-2.5 rounded-xl border border-emerald-200 dark:border-emerald-800/50 bg-emerald-50 dark:bg-emerald-900/10 px-4 py-2.5">
            <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0" />
            <p className="text-[12px] font-semibold text-emerald-700 dark:text-emerald-300">
              {t('cartera.audit_ok', { n: importAudit.matched })}
            </p>
          </div>
        ) : (
          <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 dark:border-amber-700/50 bg-amber-50 dark:bg-amber-900/10 px-4 py-3">
            <ShieldAlert className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-[12px] font-semibold text-amber-800 dark:text-amber-300">
                {t('cartera.audit_mismatches', { n: importAudit.mismatches.length, total: importAudit.checked })}
              </p>
              <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">
                {t('cartera.audit_mismatches_hint', {
                  lines: importAudit.mismatches.slice(0, 5).map(m => m.line).join(', '),
                })}
              </p>
            </div>
          </div>
        )
      )}

      {/* Rows no keyword list recognised — they will NOT be imported */}
      {unrecognizedRows.length > 0 && (
        <div className="rounded-xl border border-amber-200 dark:border-amber-700/50 bg-amber-50 dark:bg-amber-900/10 px-4 py-3">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-semibold text-amber-800 dark:text-amber-300">
                {t('cartera.unrecognized_rows', { count: unrecognizedRows.length })}
              </p>
              <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">
                {t('cartera.unrecognized_rows_hint')}
              </p>
              <button
                onClick={() => setShowUnrecognized(v => !v)}
                className="text-[11px] font-semibold text-amber-700 dark:text-amber-300 underline underline-offset-2 mt-1"
              >
                {showUnrecognized ? t('cartera.unrecognized_hide') : t('cartera.unrecognized_show')}
              </button>
              {showUnrecognized && (
                <ul className="mt-2 space-y-0.5 max-h-32 overflow-y-auto">
                  {unrecognizedRows.slice(0, 20).map(r => (
                    <li key={r.line} className="text-[11px] text-amber-700 dark:text-amber-400 font-mono truncate">
                      L{r.line} · {r.fecha} · {r.descripcion}
                    </li>
                  ))}
                  {unrecognizedRows.length > 20 && (
                    <li className="text-[11px] text-amber-500 italic">+{unrecognizedRows.length - 20}…</li>
                  )}
                </ul>
              )}
              {onReportCsv && (
                csvReportSent ? (
                  <p className="text-[11px] text-emerald-600 dark:text-emerald-400 font-semibold mt-1.5">
                    {t('cartera.report_sent_inline')}
                  </p>
                ) : (
                  <button
                    onClick={onReportCsv}
                    className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 underline underline-offset-2 hover:text-blue-600 dark:hover:text-blue-400 mt-1.5"
                  >
                    {t('cartera.report_csv_button')}
                  </button>
                )
              )}
            </div>
          </div>
        </div>
      )}

      {/* AI-parsed banner */}
      {pendingImportData?.some(t => t.isAIParsed) && (
        <div className="flex items-start gap-3 rounded-xl border border-blue-200 dark:border-blue-800/50 bg-blue-50 dark:bg-blue-900/10 px-4 py-3">
          <Sparkles className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-[12px] font-semibold text-blue-800 dark:text-blue-300">{t('cartera.ai_extracted_title')}</p>
            <p className="text-[11px] text-blue-600 dark:text-blue-400 mt-0.5">{t('cartera.ai_extracted_desc')}</p>
          </div>
        </div>
      )}

      {/* IBKR parse warnings — unknown types / zero-price transfers */}
      {ibkrParseWarnings.map((w, wi) => {
        const warnCard = (title, desc) => (
          <div key={wi} className="flex items-start gap-3 rounded-xl border border-amber-200 dark:border-amber-700/50 bg-amber-50 dark:bg-amber-900/10 px-4 py-3">
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-[12px] font-semibold text-amber-800 dark:text-amber-300">{title}</p>
              <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">{desc}</p>
            </div>
          </div>
        );
        if (w.code === 'ibkr_unknown_types') return warnCard(
          t('cartera.ibkr_unknown_types_title'),
          t('cartera.ibkr_unknown_types_desc', { types: w.types.join(', ') })
        );
        if (w.code === 't212_cash_incomplete') return warnCard(
          t('cartera.t212_cash_incomplete_title'),
          t('cartera.t212_cash_incomplete_desc', { amount: w.amount, currency: w.currency })
        );
        if (w.code === 't212_stock_splits') return warnCard(
          t('cartera.t212_stock_splits_title'),
          t('cartera.t212_stock_splits_desc', { symbols: w.symbols.join(', ') })
        );
        if (w.code === 't212_unsupported_actions') return warnCard(
          t('cartera.t212_unsupported_title'),
          t('cartera.t212_unsupported_desc', { types: w.types.join(', ') })
        );
        if (w.code === 'ibkr_transfer_zero_price') return warnCard(
          t('cartera.ibkr_transfer_zero_price_title'),
          t('cartera.ibkr_transfer_zero_price_desc', { symbols: w.symbols.join(', ') })
        );
        return null;
      })}

      {/* AI Validation Panel */}
      {enableAIValidation ? (
        <ImportValidationPanel
          issues={validationIssues}
          validating={validating}
          validationWarning={validationWarning}
          onFixRow={onFixRow}
        />
      ) : (
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 px-4 py-3 flex items-center gap-2.5 text-[12px] text-slate-400">
          <Sparkles className="w-3.5 h-3.5 shrink-0" />
          {t('cartera.ai_disabled')}
        </div>
      )}

      {/* Auto-fix button — only when AI found fixable issues */}
      {fixableCount > 0 && !validating && (
        <button
          onClick={onAutoFix}
          className="w-full py-2.5 rounded-xl border-2 border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 text-sm font-bold text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors flex items-center justify-center gap-2"
        >
          <Sparkles className="w-3.5 h-3.5" />
          {t('cartera.ai_auto_fix', { count: fixableCount })}
        </button>
      )}

    </div>
  );
};

export default ImportPreviewStep;
