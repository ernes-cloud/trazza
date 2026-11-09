import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FileText, Building2, ArrowUpDown, Sparkles,
  Calculator, Globe, Database, RefreshCw, Check,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

const STEP_DURATIONS = [820, 700, 980, 1700, 880, 960, 1150, 820];
const STEP_ICONS     = [FileText, Building2, ArrowUpDown, Sparkles, Calculator, Globe, Database, RefreshCw];
const STEP_TAGS      = ['CSV', 'Parser', 'Engine', 'IA · Groq', 'FIFO', 'FX · ECB', 'Supabase', 'Portfolio'];

/* Animated checkmark circle that "pops" into existence */
function StepCheck() {
  return (
    <motion.div
      initial={{ scale: 0, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 520, damping: 22, mass: 0.6 }}
      className="w-5 h-5 rounded-full bg-emerald-500 flex items-center justify-center shadow-lg shadow-emerald-500/40"
    >
      <motion.div
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ delay: 0.08, duration: 0.22, ease: 'easeOut' }}
      >
        <Check className="w-3 h-3 text-white stroke-3" />
      </motion.div>
    </motion.div>
  );
}

/* Active spinner */
function StepSpinner() {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.5 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.2 }}
      className="w-5 h-5 rounded-full border-2 border-blue-500/25 border-t-blue-500 dark:border-blue-400/30 dark:border-t-blue-400 animate-spin"
    />
  );
}

export default function ImportLoadingOverlay({ visible, onComplete }) {
  const { t } = useTranslation();
  const [currentStep, setCurrentStep]     = useState(-1);
  const [completedSteps, setCompletedSteps] = useState([]);
  const [isDone, setIsDone]               = useState(false);
  const timerRef   = useRef(null);
  const listRef    = useRef(null);
  const stepRefs   = useRef([]);

  const STEP_LABELS = [
    t('cartera.import_step_read'),
    t('cartera.import_step_broker'),
    t('cartera.import_step_normalize'),
    t('cartera.import_step_ai'),
    t('cartera.import_step_fifo'),
    t('cartera.import_step_fx'),
    t('cartera.import_step_save'),
    t('cartera.import_step_update'),
  ];

  useEffect(() => {
    if (!visible) {
      setCurrentStep(-1);
      setCompletedSteps([]);
      setIsDone(false);
      return;
    }

    const schedule = (idx) => {
      if (idx >= STEP_DURATIONS.length) {
        timerRef.current = setTimeout(() => {
          setIsDone(true);
          timerRef.current = setTimeout(() => onComplete?.(), 1100);
        }, 200);
        return;
      }
      setCurrentStep(idx);
      timerRef.current = setTimeout(() => {
        setCompletedSteps(prev => [...prev, idx]);
        schedule(idx + 1);
      }, STEP_DURATIONS[idx]);
    };

    timerRef.current = setTimeout(() => schedule(0), 350);
    return () => clearTimeout(timerRef.current);
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll: keep the active step centered in the list
  useEffect(() => {
    const el = stepRefs.current[currentStep];
    if (el && listRef.current) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [currentStep]);

  const progress = isDone
    ? 100
    : currentStep < 0
      ? 2
      : Math.round((completedSteps.length / STEP_DURATIONS.length) * 94 + 3);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="import-loading"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="absolute inset-0 z-10 flex flex-col rounded-2xl overflow-hidden bg-white dark:bg-slate-900"
        >
          {/* Ambient glows */}
          <div className="absolute inset-0 pointer-events-none overflow-hidden">
            <div className="absolute -top-20 -left-20 w-72 h-72 rounded-full bg-blue-600/8 blur-3xl" />
            <div className="absolute -bottom-20 -right-20 w-72 h-72 rounded-full bg-indigo-600/6 blur-3xl" />
          </div>

          {/* Progress bar */}
          <div className="relative h-[3px] w-full shrink-0 bg-slate-200 dark:bg-slate-800/80">
            <motion.div
              className="h-full bg-linear-to-r from-blue-500 via-indigo-400 to-blue-400"
              initial={{ width: '2%' }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.55, ease: 'easeInOut' }}
            />
          </div>

          <div className="relative flex flex-col flex-1 px-5 py-4 gap-3 overflow-hidden">

            {/* Header */}
            <div className="flex items-center gap-3 shrink-0">
              {/* Rotating ring + step icon */}
              <div className="relative shrink-0">
                <motion.div
                  animate={{ rotate: isDone ? 0 : 360 }}
                  transition={{ duration: 2.8, repeat: isDone ? 0 : Infinity, ease: 'linear' }}
                  className="w-10 h-10 rounded-full border border-dashed border-blue-500/30"
                />
                <div className="absolute inset-1.5 rounded-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700/80 flex items-center justify-center">
                  <AnimatePresence mode="wait">
                    {isDone ? (
                      <motion.div key="done"
                        initial={{ scale: 0 }} animate={{ scale: 1 }}
                        transition={{ type: 'spring', stiffness: 400, damping: 18 }}
                      >
                        <Check className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400 stroke-[2.5]" />
                      </motion.div>
                    ) : currentStep >= 0 ? (
                      <motion.div key={`icon-${currentStep}`}
                        initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.4, opacity: 0 }} transition={{ duration: 0.18 }}
                      >
                        {(() => { const Icon = STEP_ICONS[currentStep]; return <Icon className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400" />; })()}
                      </motion.div>
                    ) : (
                      <motion.div key="loader"
                        className="w-3 h-3 border-2 border-blue-500 dark:border-blue-400 border-t-transparent rounded-full animate-spin"
                      />
                    )}
                  </AnimatePresence>
                </div>
              </div>

              {/* Title */}
              <div className="min-w-0">
                <AnimatePresence mode="wait">
                  {isDone ? (
                    <motion.p key="done-t"
                      initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                      className="text-sm font-bold text-emerald-600 dark:text-emerald-400 leading-tight"
                    >
                      {t('cartera.import_step_done')}
                    </motion.p>
                  ) : (
                    <motion.p key="loading-t"
                      initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                      className="text-sm font-bold text-slate-900 dark:text-white leading-tight"
                    >
                      {t('cartera.import_loading_title')}
                    </motion.p>
                  )}
                </AnimatePresence>
                <p className="text-[10px] text-slate-500 mt-0.5 leading-tight">
                  {isDone ? t('cartera.import_step_done_sub') : t('cartera.import_loading_subtitle')}
                </p>
              </div>
            </div>

            {/* Step list */}
            <div ref={listRef} className="flex flex-col gap-1 flex-1 overflow-y-auto no-scrollbar">
              {STEP_LABELS.map((label, idx) => {
                const isCompleted = completedSteps.includes(idx);
                const isActive    = currentStep === idx && !isCompleted;
                const isPending   = !isCompleted && !isActive;
                const Icon        = STEP_ICONS[idx];

                return (
                  <motion.div
                    key={idx}
                    ref={el => { stepRefs.current[idx] = el; }}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: isPending ? 0.28 : 1, x: 0 }}
                    transition={{ delay: idx * 0.03, duration: 0.25 }}
                    className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg transition-colors duration-300 ${
                      isActive    ? 'bg-blue-500/10 border border-blue-500/20' :
                      isCompleted ? 'bg-emerald-500/5 border border-emerald-500/10' :
                                    'border border-transparent'
                    }`}
                  >
                    {/* Icon pill */}
                    <div className={`shrink-0 w-6 h-6 rounded-md flex items-center justify-center transition-colors duration-300 ${
                      isCompleted ? 'bg-emerald-500/15' :
                      isActive    ? 'bg-blue-500/20' :
                                    'bg-slate-100 dark:bg-slate-800/60'
                    }`}>
                      <Icon className={`w-3 h-3 transition-colors duration-300 ${
                        isCompleted ? 'text-emerald-500 dark:text-emerald-400' :
                        isActive    ? 'text-blue-500 dark:text-blue-400' :
                                      'text-slate-400 dark:text-slate-600'
                      }`} />
                    </div>

                    {/* Label */}
                    <div className="flex-1 min-w-0">
                      <p className={`text-[11px] font-medium leading-tight truncate transition-colors duration-300 ${
                        isCompleted ? 'text-slate-500 dark:text-slate-400' :
                        isActive    ? 'text-slate-900 dark:text-white' :
                                      'text-slate-400 dark:text-slate-600'
                      }`}>
                        {label}
                        {isActive && (
                          <motion.span
                            animate={{ opacity: [1, 0.2, 1] }}
                            transition={{ duration: 1.0, repeat: Infinity }}
                          > …</motion.span>
                        )}
                      </p>
                      <span className={`text-[9px] font-mono transition-colors duration-300 ${
                        isCompleted ? 'text-slate-400 dark:text-slate-600' :
                        isActive    ? 'text-blue-500/70 dark:text-blue-500/60' :
                                      'text-slate-300 dark:text-slate-700'
                      }`}>
                        {STEP_TAGS[idx]}
                      </span>
                    </div>

                    {/* Status — THIS is the satisfying part */}
                    <div className="shrink-0 w-5 h-5 flex items-center justify-center">
                      <AnimatePresence mode="wait">
                        {isCompleted ? (
                          <StepCheck key="check" />
                        ) : isActive ? (
                          <StepSpinner key="spin" />
                        ) : null}
                      </AnimatePresence>
                    </div>
                  </motion.div>
                );
              })}
            </div>

            {/* Footer dots */}
            <div className="flex items-center justify-center gap-1.5 shrink-0 pt-1">
              {STEP_DURATIONS.map((_, idx) => {
                const done = completedSteps.includes(idx) || isDone;
                const active = currentStep === idx && !done;
                return (
                  <motion.div
                    key={idx}
                    animate={{ width: done || active ? 16 : 5 }}
                    transition={{ duration: 0.3, ease: 'easeInOut' }}
                    className={`h-1 rounded-full transition-colors duration-300 ${
                      done   ? 'bg-emerald-500' :
                      active ? 'bg-blue-400' :
                               'bg-slate-300 dark:bg-slate-600'
                    }`}
                    style={{ width: 5 }}
                  />
                );
              })}
              <span className="text-[9px] text-slate-500 dark:text-slate-600 tabular-nums ml-1">{progress}%</span>
            </div>

          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
