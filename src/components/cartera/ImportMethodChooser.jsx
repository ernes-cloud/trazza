import React from 'react';
import { useTranslation } from 'react-i18next';
import { FileSpreadsheet, Sparkles, ChevronRight, RefreshCw } from 'lucide-react';

/**
 * Entry screen of the import dialog: the two ways to bring data in.
 *   1. CSV/XLSX file  → advances to the broker picker (parent owns the phase)
 *   2. AI import      → free-form flow, gated by the per-plan AI quota
 * (Broker API via SnapTrade was removed from the platform in 2026-07.)
 *
 * Pure presentation — navigation and quota state live in CarteraPage.
 */
const ImportMethodChooser = ({
  onSelectCsv,
  onSelectAi,
  aiExhausted,
  aiDailyLeft,
  onReresolveFunds,
  reresolving = false,
}) => {
  const { t } = useTranslation();

  const cardBase =
    'w-full relative p-4 rounded-xl border-2 text-left transition-all flex items-center gap-3 ' +
    'border-slate-200 dark:border-slate-700';

  return (
    <div>
      <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2.5">
        {t('cartera.import_method_hint')}
      </p>
      <div className="space-y-2.5">
        {/* 1 — CSV/XLSX file */}
        <button
          onClick={onSelectCsv}
          className={`${cardBase} hover:border-blue-400 dark:hover:border-blue-500 hover:bg-blue-50/40 dark:hover:bg-blue-900/10 group`}
        >
          <div className="w-10 h-10 rounded-lg bg-linear-to-br from-blue-500 to-indigo-500 flex items-center justify-center shrink-0">
            <FileSpreadsheet className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-slate-800 dark:text-slate-100">{t('cartera.import_method_csv_title')}</p>
            <p className="text-[11px] text-slate-400 truncate">{t('cartera.import_method_csv_sub')}</p>
          </div>
          <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-blue-500 transition-colors shrink-0" />
        </button>

        {/* 2 — AI import */}
        <button
          onClick={() => { if (!aiExhausted) onSelectAi(); }}
          disabled={aiExhausted}
          className={`${cardBase} hover:border-violet-400 dark:hover:border-violet-500 hover:bg-violet-50/40 dark:hover:bg-violet-900/10 group disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {/* Admin has an unlimited quota (dailyLeft === Infinity) — no badge. */}
          {(aiExhausted || Number.isFinite(aiDailyLeft)) && (
            <span className={`absolute top-2 right-2 text-[9px] font-bold px-2 py-0.5 rounded-full ${
              aiExhausted
                ? 'bg-rose-100 text-rose-600 dark:bg-rose-500/20 dark:text-rose-400'
                : aiDailyLeft <= 2
                ? 'bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400'
                : 'bg-violet-100 text-violet-600 dark:bg-violet-500/20 dark:text-violet-300'
            }`}>
              {aiExhausted ? t('ai_usage.exhausted') : t('ai_usage.remaining', { n: aiDailyLeft })}
            </span>
          )}
          <div className="w-10 h-10 rounded-lg bg-linear-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center shrink-0">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-slate-800 dark:text-slate-100">{t('freeform_import.card_title')}</p>
            <p className="text-[11px] text-slate-400 truncate">
              {aiExhausted ? t('freeform_import.limit_reached') : t('freeform_import.card_subtitle')}
            </p>
          </div>
          {!aiExhausted && <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-violet-500 transition-colors shrink-0" />}
        </button>
      </div>

      {/* Quien abre "Sincronizar" viene porque algo no le cuadra. Antes de
          mandarle a subir un fichero otra vez, se le ofrece el arreglo barato:
          revisar el símbolo de cotización de sus fondos. No toca transacciones
          y no necesita ningún archivo. */}
      {onReresolveFunds && (
        <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-700/60">
          <p className="text-[11px] text-slate-400 dark:text-slate-500">{t('cartera.reresolve_hint')}</p>
          <button
            type="button"
            onClick={onReresolveFunds}
            disabled={reresolving}
            className="mt-1.5 inline-flex items-center gap-1.5 text-[12px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-60 disabled:no-underline"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${reresolving ? 'animate-spin' : ''}`} />
            {reresolving ? t('cartera.reresolve_running') : t('cartera.reresolve_funds')}
          </button>
        </div>
      )}
    </div>
  );
};

export default ImportMethodChooser;
