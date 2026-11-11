import React, { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Landmark, Loader2, UploadCloud, AlertTriangle, CheckCircle2, ArrowLeft, EyeOff,
} from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { extractXlsxRows, rowsToCsv } from '@/lib/xlsxReader';
import { detectBankStatement } from '@/lib/parsers/bank/bankDetect';
import { auditRunningBalance } from '@/lib/parsers/bank/bankCsv';
import { classifyStatement, summarizeIntents } from '@/services/expenses/bankNoiseClassifier';
import { buildPreviewRows, buildBankImportPlan } from '@/services/expenses/bankImportMapper';
import {
  EXPENSE_CATEGORIES, INCOME_CATEGORIES, categoryLabel,
} from '@/services/expenseService';

/**
 * Bank-statement import for the expenses module.
 *
 * Three steps: drop a file → review → confirm. Every financial decision is
 * made by the pure services (parser, noise classifier, mapper); this component
 * only renders them and collects the user's overrides. That split is what lets
 * the maths be tested without a DOM, which this project has no runner for.
 *
 * The review step is NOT optional politeness: roughly half of a Revolut export
 * is FX/crypto/savings noise and a bank cannot tell an employer's payment from
 * the user moving their own money. Rows flagged `needsReview` and rows already
 * imported are shown before anything is written.
 */
const BankImportDialog = ({ open, onOpenChange, userId, defaultCurrency = 'EUR', existingKeys, onConfirm }) => {
  const { t } = useTranslation();
  const [step, setStep] = useState('input'); // 'input' | 'review'
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [detected, setDetected] = useState(null); // { bank, movements, audit }
  const [excluded, setExcluded] = useState(() => new Set());
  const [overrides, setOverrides] = useState({}); // index → { intent?, category? }
  const fileRef = useRef(null);

  const reset = () => {
    setStep('input'); setError(null); setDetected(null);
    setExcluded(new Set()); setOverrides({}); setBusy(false);
  };

  const handleOpenChange = (value) => {
    if (!value) reset();
    onOpenChange(value);
  };

  const classified = useMemo(
    () => (detected ? classifyStatement(detected.movements) : []),
    [detected],
  );

  // User overrides are applied on top of the classifier before anything is
  // previewed or planned, so what the table shows is exactly what gets saved.
  const effective = useMemo(
    () => classified.map((entry, index) => (
      overrides[index]?.intent ? { ...entry, intent: overrides[index].intent } : entry
    )),
    [classified, overrides],
  );

  const preview = useMemo(
    () => (detected
      ? buildPreviewRows(effective, { bank: detected.bank, existingKeys }).map((row) => ({
        ...row,
        category: overrides[row.index]?.category ?? row.category,
      }))
      : []),
    [effective, detected, existingKeys, overrides],
  );

  const summary = useMemo(() => summarizeIntents(effective), [effective]);
  const duplicateCount = preview.filter((r) => r.isDuplicate).length;
  const toImport = preview.filter((r) => r.intent !== 'ignore' && !r.isDuplicate && !excluded.has(r.index)).length;

  const readAsText = async (file) => {
    if (!/\.xlsx$/i.test(file.name || '')) return file.text();
    return rowsToCsv(await extractXlsxRows(await file.arrayBuffer()));
  };

  const handleFile = async (fileList) => {
    const file = Array.from(fileList || [])[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const text = await readAsText(file);
      const result = detectBankStatement(text);
      if (!result) {
        setError(t('bank_import.unrecognized'));
        return;
      }
      setDetected({ ...result, audit: auditRunningBalance(result.movements) });
      setStep('review');
    } catch (e) {
      console.error('[bank-import] file processing failed:', e);
      setError(t('bank_import.file_error'));
    } finally {
      setBusy(false);
    }
  };

  const toggleExcluded = (index) => setExcluded((prev) => {
    const next = new Set(prev);
    if (next.has(index)) next.delete(index); else next.add(index);
    return next;
  });

  const setOverride = (index, patch) => setOverrides((prev) => ({
    ...prev, [index]: { ...prev[index], ...patch },
  }));

  const confirm = async () => {
    if (!detected || toImport === 0 || busy) return;
    setBusy(true);
    try {
      const plan = buildBankImportPlan(effective, {
        userId,
        bank: detected.bank,
        existingKeys,
        defaultCurrency,
        excludedIndexes: excluded,
      });
      // Per-row category overrides ride along on the plan, matched by key.
      const categoryByKey = new Map(preview.map((r) => [r.importKey, r.category]));
      const rows = plan.rows.map((row) => ({
        ...row,
        category: categoryByKey.get(row.import_key) ?? row.category,
      }));
      const ok = await onConfirm(rows, { bank: detected.bank });
      if (ok) handleOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  const categoriesFor = (intent) => (intent === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES);
  const amountClass = (n) => (n < 0 ? 'text-slate-800 dark:text-slate-100' : 'text-emerald-600 dark:text-emerald-400');

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className={`${step === 'review' ? 'max-w-5xl' : 'max-w-lg'} dark:bg-slate-900 border-none p-0 flex flex-col overflow-hidden transition-all`}>
        <div className="h-[3px] w-full shrink-0 bg-linear-to-r from-sky-500 to-emerald-500" />

        <div className="px-6 pt-5 pb-4 border-b border-slate-100 dark:border-slate-800 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-sky-50 dark:bg-sky-900/25 rounded-xl">
              <Landmark className="w-4 h-4 text-sky-500" />
            </div>
            <div>
              <h2 className="text-base font-black text-slate-900 dark:text-white tracking-tight">
                {t('bank_import.dialog_title')}
              </h2>
              <p className="text-[11px] text-slate-400 font-medium">
                {step === 'review'
                  ? t('bank_import.review_hint', { bank: t(`bank_import.bank_${detected?.bank}`) })
                  : t('bank_import.dialog_subtitle')}
              </p>
            </div>
          </div>
        </div>

        {step === 'input' && (
          <div className="p-6 space-y-4 overflow-y-auto">
            <button
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="w-full flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-200 dark:border-slate-700 py-10 text-[11px] font-bold text-slate-500 dark:text-slate-400 hover:border-sky-300 dark:hover:border-sky-700 hover:text-sky-600 dark:hover:text-sky-400 disabled:opacity-50 transition-colors"
            >
              {busy
                ? <><Loader2 className="w-5 h-5 animate-spin" />{t('bank_import.processing')}</>
                : <><UploadCloud className="w-5 h-5" />{t('bank_import.drop_cta')}</>}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx,.txt,text/csv,text/plain"
              className="hidden"
              onChange={(e) => { handleFile(e.target.files); e.target.value = ''; }}
            />

            <p className="text-[10px] text-slate-400 leading-relaxed">{t('bank_import.supported_hint')}</p>
            <p className="text-[10px] text-slate-400 leading-relaxed">{t('bank_import.privacy_hint')}</p>

            {error && (
              <div className="flex items-start gap-2 rounded-xl bg-red-50 dark:bg-red-900/15 border border-red-200 dark:border-red-800/40 px-3.5 py-2.5">
                <AlertTriangle className="w-3.5 h-3.5 text-red-500 shrink-0 mt-0.5" />
                <p className="text-[11px] font-semibold text-red-600 dark:text-red-400">{error}</p>
              </div>
            )}
          </div>
        )}

        {step === 'review' && (
          <>
            <div className="px-6 py-3 border-b border-slate-100 dark:border-slate-800 shrink-0 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] font-bold">
              <span className="text-emerald-600 dark:text-emerald-400">{t('bank_import.stat_import', { count: toImport })}</span>
              <span className="text-slate-400">{t('bank_import.stat_ignored', { count: summary.ignore })}</span>
              {duplicateCount > 0 && (
                <span className="text-sky-600 dark:text-sky-400">{t('bank_import.stat_duplicates', { count: duplicateCount })}</span>
              )}
              {summary.needsReview > 0 && (
                <span className="text-amber-600 dark:text-amber-400">{t('bank_import.stat_review', { count: summary.needsReview })}</span>
              )}
              <span className={`ml-auto ${detected?.audit?.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                {detected?.audit?.ok
                  ? t('bank_import.audit_ok', { count: detected.audit.checked })
                  : t('bank_import.audit_mismatch', { count: detected?.audit?.mismatches.length || 0 })}
              </span>
            </div>

            <div className="flex-1 overflow-auto px-4 py-3">
              <table className="w-full border-separate border-spacing-0 min-w-[820px]">
                <thead>
                  <tr>
                    {['col_date', 'col_merchant', 'col_amount', 'col_intent', 'col_category', ''].map((k, i) => (
                      <th key={i} className="sticky top-0 bg-white dark:bg-slate-900 text-left text-[9px] font-black text-slate-400 uppercase tracking-widest px-2 py-2 border-b border-slate-100 dark:border-slate-800">
                        {k ? t(`bank_import.${k}`) : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.map((row) => {
                    const off = row.intent === 'ignore' || row.isDuplicate || excluded.has(row.index);
                    return (
                      <tr
                        key={row.importKey}
                        className={`${off ? 'opacity-45' : ''} ${row.needsReview && !off ? 'bg-amber-50/40 dark:bg-amber-900/5' : ''}`}
                        title={row.detail || undefined}
                      >
                        <td className="px-2 py-1 text-[11px] font-medium text-slate-500 tabular-nums whitespace-nowrap">{row.date}</td>
                        <td className="px-2 py-1 text-[11px] font-semibold text-slate-800 dark:text-slate-100 max-w-[240px] truncate">
                          {row.merchant}
                          {row.isDuplicate && (
                            <span className="ml-1.5 text-[9px] font-bold uppercase text-sky-500">{t('bank_import.badge_duplicate')}</span>
                          )}
                          {row.intent === 'ignore' && !row.isDuplicate && (
                            <span className="ml-1.5 text-[9px] font-bold uppercase text-slate-400">
                              {t(`bank_import.reason_${row.reason}`, t('bank_import.reason_default'))}
                            </span>
                          )}
                        </td>
                        <td className={`px-2 py-1 text-[11px] font-bold tabular-nums text-right whitespace-nowrap ${amountClass(row.amount)}`}>
                          {row.amount.toFixed(2)} {row.currency}
                          {row.fee ? <span className="block text-[9px] font-semibold text-slate-400">+{row.fee.toFixed(2)} {t('bank_import.fee_label')}</span> : null}
                        </td>
                        <td className="px-2 py-1">
                          <select
                            value={row.intent}
                            onChange={(e) => setOverride(row.index, { intent: e.target.value })}
                            className="w-full bg-transparent text-[11px] font-semibold rounded-lg px-1.5 py-1 border border-transparent hover:border-slate-200 dark:hover:border-slate-700 dark:bg-slate-900 outline-hidden"
                          >
                            <option value="expense">{t('expenses.form_type_expense')}</option>
                            <option value="income">{t('expenses.form_type_income')}</option>
                            <option value="ignore">{t('bank_import.intent_ignore')}</option>
                          </select>
                        </td>
                        <td className="px-2 py-1">
                          <select
                            value={row.category}
                            disabled={row.intent === 'ignore'}
                            onChange={(e) => setOverride(row.index, { category: e.target.value })}
                            className="w-full bg-transparent text-[11px] font-medium rounded-lg px-1.5 py-1 border border-transparent hover:border-slate-200 dark:hover:border-slate-700 dark:bg-slate-900 outline-hidden disabled:opacity-40"
                          >
                            {categoriesFor(row.intent).map((cat) => (
                              <option key={cat} value={cat}>{categoryLabel(t, cat)}</option>
                            ))}
                          </select>
                        </td>
                        <td className="px-2 py-1 w-[44px]">
                          <button
                            onClick={() => toggleExcluded(row.index)}
                            disabled={row.intent === 'ignore' || row.isDuplicate}
                            className="p-2 rounded-lg text-slate-300 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 transition-colors"
                            title={t('bank_import.toggle_row')}
                            aria-label={t('bank_import.toggle_row')}
                          >
                            <EyeOff className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="px-6 py-4 border-t border-slate-100 dark:border-slate-800 shrink-0 flex flex-col sm:flex-row sm:items-center gap-3">
              <p className="flex-1 text-[10px] text-slate-400 leading-relaxed">{t('bank_import.confirm_hint')}</p>
              <div className="flex items-center gap-2">
                <button
                  onClick={reset}
                  className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-xs font-bold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  {t('bank_import.back_btn')}
                </button>
                <button
                  onClick={confirm}
                  disabled={toImport === 0 || busy}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold shadow-lg shadow-emerald-500/25 transition-all"
                >
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                  {t('bank_import.confirm_btn', { count: toImport })}
                </button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default BankImportDialog;
