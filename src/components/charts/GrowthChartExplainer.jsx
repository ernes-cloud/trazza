import { X, Info } from 'lucide-react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

/**
 * Methodology explainer modal — shown when user clicks "¿Cómo se calcula?" in PortfolioGrowthChart.
 * Describes the three chart modes (TTWROR, TWR, ROI) and the S&P 500 overlay.
 */
export function GrowthChartExplainer({ onClose }) {
  const { t } = useTranslation();

  return (
    <div
      className="fixed inset-0 z-100 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        onClick={e => e.stopPropagation()}
        className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200/80 dark:border-slate-700/50 max-w-lg w-full overflow-hidden"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center">
          <div className="flex items-center gap-2">
            <Info className="w-4 h-4 text-blue-500" />
            <h4 className="font-bold text-sm text-slate-900 dark:text-white">
              {t('portfolio_growth.methodology_title')}
            </h4>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 text-sm text-slate-600 dark:text-slate-300 overflow-y-auto max-h-[65vh]">

          {/* TTWROR — azul, modo por defecto */}
          <div>
            <p className="font-bold text-slate-900 dark:text-white mb-1 text-xs uppercase tracking-wider flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-blue-500 inline-block" />
              {t('portfolio_growth.ttwror_title')}
            </p>
            <p>{t('portfolio_growth.ttwror_desc')}</p>
          </div>
          <div className="space-y-1.5">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
              {t('portfolio_growth.ttwror_formula_label')}
            </p>
            <div className="bg-blue-50 dark:bg-blue-900/20 p-3.5 rounded-xl border border-blue-100 dark:border-blue-800/40 font-mono text-center text-blue-700 dark:text-blue-300 text-sm">
              R = (V_final − V_inicial − CF) / V_inicial
            </div>
            <p className="text-xs text-slate-400 dark:text-slate-500 italic">
              {t('portfolio_growth.ttwror_note')}
            </p>
          </div>

          {/* ROI — violeta */}
          <div className="border-t border-slate-100 dark:border-slate-800 pt-4">
            <p className="font-bold text-slate-900 dark:text-white mb-1 text-xs uppercase tracking-wider flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-violet-500 inline-block" />
              {t('portfolio_growth.roi_actual_title')}
            </p>
            <p>{t('portfolio_growth.roi_actual_desc')}</p>
          </div>
          <div className="space-y-1.5">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
              {t('portfolio_growth.roi_formula_label')}
            </p>
            <div className="bg-violet-50 dark:bg-violet-900/20 p-3.5 rounded-xl border border-violet-100 dark:border-violet-800/40 font-mono text-center text-violet-700 dark:text-violet-300 text-sm">
              {t('portfolio_growth.roi_formula')}
            </div>
            <p className="text-xs text-slate-400 dark:text-slate-500 italic">
              {t('portfolio_growth.roi_note')}
            </p>
          </div>


</div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-blue-600 flex justify-center">
          <button onClick={onClose} className="text-white font-bold text-sm tracking-wide uppercase">
            {t('portfolio_growth.got_it')}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
