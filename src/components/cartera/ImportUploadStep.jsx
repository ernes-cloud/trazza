import React, { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Info, FileText, AlertTriangle, Loader2, Sparkles } from 'lucide-react';

/**
 * STEP 1 (upload) body of the import dialog, minus the broker selector:
 * per-broker instructions, the CSV drop/click zone, the AI fallback parser,
 * and the AI-validation toggle. Extracted from CarteraPage. Presentational —
 * the parent owns the parse logic (onFileSelected) and all state.
 *
 * Props:
 *   importBroker        – selected source (drives which instruction card shows)
 *   isUploading         – true while a file is being read/parsed
 *   onFileSelected      – (File) => void; parent parses and advances the flow
 *   rawCsvText          – non-null when the standard parser found 0 rows (shows AI fallback)
 *   parseHint           – specific reason the parser failed (wrong DeGiro file, no
 *                         trades found…); replaces the generic AI hint when present
 *   aiParseError        – error string from the AI fallback, or null
 *   aiParsing           – true while the AI fallback is running
 *   onAnalyzeWithAI     – run the AI fallback parser
 *   onCancelAiFallback  – dismiss the AI fallback panel
 *   aiExhausted         – per-plan AI quota used up
 *   aiDailyLeft         – remaining AI calls today
 *   enableAIValidation  – AI-validation toggle state
 *   onToggleValidation  – (boolean) => void for the toggle
 */
const ImportUploadStep = ({
  importBroker,
  isUploading,
  onFileSelected,
  rawCsvText,
  parseHint,
  aiParseError,
  aiParsing,
  onAnalyzeWithAI,
  onCancelAiFallback,
  aiExhausted,
  aiDailyLeft,
  enableAIValidation,
  onToggleValidation,
  onReportCsv,
  csvReportSent,
}) => {
  const { t } = useTranslation();
  const inputRef = useRef(null);

  // Shared badge tones; only the neutral dark shade differs between the two
  // call sites (fallback: slate-700, toggle: slate-800) — preserved 1:1.
  const badgeTone = (neutralDark) => aiExhausted
    ? 'bg-rose-100 text-rose-600 dark:bg-rose-500/20 dark:text-rose-400'
    : aiDailyLeft <= 2
    ? 'bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400'
    : `bg-slate-100 text-slate-500 ${neutralDark} dark:text-slate-400`;

  return (
    <>
      {/* Broker instructions (progressive disclosure) */}
      {importBroker === 'degiro' && (
        <div className="rounded-xl border border-orange-200 dark:border-orange-900/40 bg-orange-50 dark:bg-orange-900/10 p-3.5 flex gap-3">
          <Info className="w-3.5 h-3.5 text-orange-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-[10px] font-bold text-orange-700 dark:text-orange-400 uppercase tracking-wider mb-1">{t('cartera.csv_how_to')}</p>
            <p className="text-[11px] text-orange-600 dark:text-orange-300 leading-relaxed">
              {t('cartera.csv_degiro_pre')} <strong>{t('cartera.csv_degiro_action')}</strong>
            </p>
          </div>
        </div>
      )}

      {importBroker === 'ibkr' && (
        <div className="rounded-xl border border-blue-200 dark:border-blue-900/40 bg-blue-50 dark:bg-blue-900/10 p-3.5 flex gap-3">
          <Info className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-[10px] font-bold text-blue-700 dark:text-blue-400 uppercase tracking-wider mb-1">{t('cartera.csv_how_to')}</p>
            <p className="text-[11px] text-blue-600 dark:text-blue-300 leading-relaxed">
              {t('cartera.csv_ibkr_pre')} <strong>{t('cartera.csv_ibkr_action')}</strong>
            </p>
          </div>
        </div>
      )}

      {importBroker === 'myinvestor' && (
        <div className="rounded-xl border border-teal-200 dark:border-teal-900/40 bg-teal-50 dark:bg-teal-900/10 p-3.5 flex gap-3">
          <Info className="w-3.5 h-3.5 text-teal-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-[10px] font-bold text-teal-700 dark:text-teal-400 uppercase tracking-wider mb-1">{t('cartera.csv_how_to')}</p>
            <p className="text-[11px] text-teal-600 dark:text-teal-300 leading-relaxed">
              {t('cartera.csv_myinvestor_pre')} <strong>{t('cartera.csv_myinvestor_action')}</strong>
            </p>
            <p className="text-[10px] text-teal-500 dark:text-teal-400 mt-1">
              {t('cartera.csv_myinvestor_note')}
            </p>
          </div>
        </div>
      )}

      {importBroker === 'trading212' && (
        <div className="rounded-xl border border-sky-200 dark:border-sky-900/40 bg-sky-50 dark:bg-sky-900/10 p-3.5 flex gap-3">
          <Info className="w-3.5 h-3.5 text-sky-600 shrink-0 mt-0.5" />
          <div>
            <p className="text-[10px] font-bold text-sky-700 dark:text-sky-400 uppercase tracking-wider mb-1">{t('cartera.csv_how_to')}</p>
            <p className="text-[11px] text-sky-700 dark:text-sky-300 leading-relaxed">
              {t('cartera.csv_t212_pre')} <strong>{t('cartera.csv_t212_action')}</strong>
            </p>
            <p className="text-[10px] text-sky-600 dark:text-sky-400 mt-1">
              {t('cartera.csv_t212_note')}
            </p>
          </div>
        </div>
      )}

      {importBroker === 'binance' && (
        <div className="rounded-xl border border-yellow-200 dark:border-yellow-900/40 bg-yellow-50 dark:bg-yellow-900/10 p-3.5 flex gap-3">
          <Info className="w-3.5 h-3.5 text-yellow-600 shrink-0 mt-0.5" />
          <div>
            <p className="text-[10px] font-bold text-yellow-700 dark:text-yellow-400 uppercase tracking-wider mb-1">{t('cartera.csv_how_to')}</p>
            <p className="text-[11px] text-yellow-700 dark:text-yellow-300 leading-relaxed">
              {t('cartera.csv_binance_pre')} <strong>{t('cartera.csv_binance_action')}</strong>
            </p>
            <p className="text-[10px] text-yellow-600 dark:text-yellow-400 mt-1">
              {t('cartera.csv_binance_note')}
            </p>
          </div>
        </div>
      )}

      {/* Upload zone */}
      <div
        onClick={() => !isUploading && inputRef.current?.click()}
        className="border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-xl py-8 flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-500 hover:bg-blue-50/30 dark:hover:bg-blue-900/10 transition-all group"
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.xlsx"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files[0];
            e.target.value = '';
            if (file) onFileSelected(file);
          }}
        />
        <div className={`w-12 h-12 rounded-2xl mb-3 flex items-center justify-center transition-transform group-hover:scale-110 ${isUploading ? 'bg-blue-100 dark:bg-blue-900/30' : 'bg-slate-100 dark:bg-slate-800'}`}>
          {isUploading
            ? <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
            : <FileText className="w-5 h-5 text-slate-400 group-hover:text-blue-500 transition-colors" />
          }
        </div>
        <p className="text-sm font-semibold text-slate-700 dark:text-slate-200 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
          {isUploading ? t('cartera.csv_processing') : t('cartera.csv_click')}
        </p>
        <p className="text-[11px] text-slate-400 mt-1">{t('cartera.csv_only')}</p>
      </div>

      {/* AI fallback parser — shown when standard parser returned 0 rows */}
      {rawCsvText && (
        <div className="rounded-xl border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/10 p-4 space-y-3">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-semibold text-amber-800 dark:text-amber-300">
                {t('cartera.no_transactions')}
              </p>
              <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-0.5 leading-relaxed">
                {parseHint || t('cartera.ai_parser_hint')}
              </p>
            </div>
          </div>

          {aiParseError && (
            <p className="text-[11px] text-rose-600 dark:text-rose-400 pl-7">{aiParseError}</p>
          )}

          <div className="flex gap-2 pl-7 flex-wrap items-center">
            <button
              onClick={onAnalyzeWithAI}
              disabled={aiParsing || aiExhausted}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 active:scale-95 text-white text-[12px] font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {aiParsing
                ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> {t('cartera.ai_analyzing')}</>
                : <><Sparkles className="w-3.5 h-3.5" /> {t('cartera.ai_analyze')}</>
              }
            </button>
            {!aiParsing && (
              <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${badgeTone('dark:bg-slate-700')}`}>
                {aiExhausted ? t('ai_usage.exhausted') : t('ai_usage.remaining', { n: aiDailyLeft })}
              </span>
            )}
            <button
              onClick={onCancelAiFallback}
              disabled={aiParsing}
              className="px-3 py-2 rounded-lg text-[12px] text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-50"
            >
              {t('common.cancel')}
            </button>
          </div>

          <p className="text-[10px] text-amber-600 dark:text-amber-500 pl-7">
            {t('cartera.ai_experimental')}
          </p>

          {/* Opt-in support report: anonymized sample so the format can be fixed */}
          {onReportCsv && (
            <div className="pl-7">
              {csvReportSent ? (
                <p className="text-[11px] text-emerald-600 dark:text-emerald-400 font-semibold">
                  {t('cartera.report_sent_inline')}
                </p>
              ) : (
                <button
                  onClick={onReportCsv}
                  className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 underline underline-offset-2 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                >
                  {t('cartera.report_csv_button')}
                </button>
              )}
              <p className="text-[10px] text-slate-400 mt-0.5">{t('cartera.report_csv_privacy')}</p>
            </div>
          )}
        </div>
      )}

      {/* AI validation toggle */}
      <label className="flex items-start gap-3 cursor-pointer select-none group">
        <input
          type="checkbox"
          checked={enableAIValidation}
          onChange={(e) => onToggleValidation(e.target.checked)}
          className="mt-0.5 w-4 h-4 rounded accent-blue-600 cursor-pointer shrink-0"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1.5 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
              <Sparkles className="w-3.5 h-3.5 text-blue-500" />
              {t('cartera.ai_validate')}
            </p>
            <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${badgeTone('dark:bg-slate-800')}`}>
              {aiExhausted ? t('ai_usage.exhausted') : t('ai_usage.remaining', { n: aiDailyLeft })}
            </span>
          </div>
          <p className="text-[11px] text-slate-400 leading-snug mt-0.5">
            {aiExhausted ? t('cartera.ai_exhausted_hint') : t('cartera.ai_validate_hint')}
          </p>
        </div>
      </label>
    </>
  );
};

export default ImportUploadStep;
