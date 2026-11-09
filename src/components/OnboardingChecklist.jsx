import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle2, Circle, Lock, ChevronDown, ChevronUp,
  Sparkles, X, Upload, BarChart3, UserCheck,
} from 'lucide-react';
import CurrencySelector from '@/components/CurrencySelector';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { useToast } from '@/components/ui/use-toast';
import { useNavigate } from 'react-router-dom';

// Se aprende una vez por sesión (ver markComplete).
let onboardingColumnMissing = false;

const LS_STEP2    = 'wf_onboarding_step2';
const LS_COMPLETE = 'wf_onboarding_complete';

export default function OnboardingChecklist({ hasPositions = false, hasWealth = false }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const navigate = useNavigate();

  // Step 2: local flag OR DB confirms preferred_currency was saved (authoritative after localStorage clear)
  const [step2DoneLocal, setStep2DoneLocal] = useState(() => localStorage.getItem(LS_STEP2) === 'true');
  const [panelOpen, setPanelOpen] = useState(false);
  const [emailOptIn, setEmailOptIn] = useState(true);
  const [currency, setCurrency] = useState('EUR');
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(LS_COMPLETE) === 'true');
  const [celebrating, setCelebrating] = useState(false);

  // ── Preferencias: la fila compartida (UserPreferencesContext) ───────────────
  const { preferences: prefs, loading: isLoading, savePreferences } = useUserPreferences();

  // step2Done: local flag OR DB confirms preferred_currency was saved (survives localStorage clear)
  const step2Done = step2DoneLocal || !!prefs?.preferred_currency;

  // Sync panel inputs from DB values on load
  useEffect(() => {
    if (prefs?.preferred_currency) setCurrency(prefs.preferred_currency);
    if (prefs?.email_notifications_enabled != null) setEmailOptIn(prefs.email_notifications_enabled);
  }, [prefs]);

  // ── Save preferences (step 2) ────────────────────────────────────────────────
  const savePrefs = useMutation({
    mutationFn: async () => {
      const { error } = await savePreferences({ preferred_currency: currency, email_notifications_enabled: emailOptIn });
      if (error) throw error;
    },
    onSuccess: () => {
      localStorage.setItem(LS_STEP2, 'true');
      setStep2DoneLocal(true);
      setPanelOpen(false);
      toast({ title: t('onboarding.step2_saved_title'), description: t('onboarding.step2_saved_desc') });
    },
    onError: () => toast({ variant: 'destructive', title: t('common.error') }),
  });

  // ── Mark onboarding complete ─────────────────────────────────────────────────
  // La columna `onboarding_completed` puede no estar migrada. Antes se intentaba
  // el upsert en CADA carga y el 400 (PGRST204) se veía siempre en consola aunque
  // estuviera manejado. Se prueba UNA vez por sesión: si la columna no está, se
  // deja de intentar y basta con el localStorage, que ya evita que la lista vuelva.

  const markComplete = useMutation({
    mutationFn: async () => {
      if (onboardingColumnMissing) return;   // ya sabemos que no existe

      const { error } = await savePreferences({ onboarding_completed: true });
      // `onboarding_completed` puede no estar migrada: el 400 (PGRST204/42703) no
      // es un fallo del usuario y no debe propagarse — el estado ya se guarda en
      // localStorage (LS_COMPLETE), así que la lista no reaparece igualmente.
      if (error && (error.code === 'PGRST204' || error.code === '42703')) {
        onboardingColumnMissing = true;
        return;
      }
      if (error) throw error;
    },
    onSuccess: () => {
      localStorage.setItem(LS_COMPLETE, 'true');
      setTimeout(() => setDismissed(true), 600);
    },
    onError: () => {
      localStorage.setItem(LS_COMPLETE, 'true');
      setTimeout(() => setDismissed(true), 600);
    },
  });

  // ── Step definitions ─────────────────────────────────────────────────────────
  const step4Done = hasPositions && hasWealth;
  const steps = [
    {
      id: 1, done: true, locked: false,
      icon: UserCheck,
      title: t('onboarding.step1_title'),
      desc: t('onboarding.step1_desc'),
    },
    {
      id: 2, done: step2Done, locked: false,
      icon: () => <span className="text-base">⚙️</span>,
      title: t('onboarding.step2_title'),
      desc: t('onboarding.step2_desc'),
      action: () => setPanelOpen(o => !o),
      actionLabel: step2Done ? t('onboarding.step2_edit') : t('onboarding.step2_action'),
    },
    {
      id: 3, done: hasPositions, locked: false,
      icon: Upload,
      title: t('onboarding.step3_title'),
      desc: t('onboarding.step3_desc'),
      action: () => navigate('/app/brokers'),
      actionLabel: t('onboarding.step3_action'),
      secondAction: () => navigate('/app/brokers'),
      secondActionLabel: t('onboarding.step3_action2'),
    },
    {
      id: 4, done: step4Done, locked: !hasPositions,
      icon: BarChart3,
      title: t('onboarding.step4_title'),
      desc: t('onboarding.step4_desc'),
      action: () => navigate('/app'),
      actionLabel: t('onboarding.step4_action'),
    },
  ];

  const completedCount = steps.filter(s => s.done).length;
  const allDone = completedCount === steps.length;

  // Trigger celebration + completion when all steps done
  useEffect(() => {
    if (allDone && !celebrating && !dismissed && !prefs?.onboarding_completed) {
      setCelebrating(true);
      setTimeout(() => markComplete.mutate(), 1800);
    }
  }, [allDone]);

  // Defence: if user clearly has positions + wealth but localStorage was wiped (e.g. "clear
  // cookies"), auto-complete silently so the widget doesn't resurface. step2Done is NOT required
  // here — a user who has already imported a portfolio has clearly been using the app.
  useEffect(() => {
    if (
      !isLoading &&
      !prefs?.onboarding_completed &&
      !dismissed &&
      !markComplete.isPending &&
      hasPositions && hasWealth
    ) {
      markComplete.mutate();
    }
  }, [isLoading, hasPositions, hasWealth, prefs?.onboarding_completed]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Early exits ──────────────────────────────────────────────────────────────
  if (isLoading) return null;
  if (prefs?.onboarding_completed || dismissed) return null;

  const pct = Math.round((completedCount / steps.length) * 100);

  return (
    <AnimatePresence>
      <motion.div
        key="onboarding"
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -12, scale: 0.97 }}
        transition={{ duration: 0.35 }}
        className="relative overflow-hidden rounded-2xl border border-blue-200/60 dark:border-blue-500/20 bg-white dark:bg-slate-900/80 shadow-xs"
      >
        {/* Ambient glow */}
        <div className="absolute inset-0 bg-linear-to-br from-blue-500/5 via-transparent to-purple-500/5 pointer-events-none" />

        {/* ── Header ── */}
        <div className="relative flex items-center justify-between px-5 pt-4 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-blue-500/10 dark:bg-blue-500/15 flex items-center justify-center">
              <Sparkles className="w-4 h-4 text-blue-500" />
            </div>
            <div>
              <p className="text-sm font-bold text-slate-900 dark:text-white leading-none">
                {t('onboarding.title')}
              </p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                {celebrating
                  ? t('onboarding.celebrating')
                  : t('onboarding.progress', { done: completedCount, total: steps.length })}
              </p>
            </div>
          </div>

          <button
            onClick={() => {
              localStorage.setItem(LS_COMPLETE, 'true');
              setDismissed(true);
              if (!prefs?.onboarding_completed) markComplete.mutate();
            }}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            aria-label="Cerrar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* ── Progress bar ── */}
        <div className="px-5 pb-3">
          <div className="h-1.5 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
            <motion.div
              className="h-full rounded-full bg-linear-to-r from-blue-500 to-blue-400"
              initial={{ width: 0 }}
              animate={{ width: `${pct}%` }}
              transition={{ duration: 0.6, ease: 'easeOut' }}
            />
          </div>
        </div>

        {/* ── Steps ── */}
        <div className="px-4 pb-4 space-y-1">
          {steps.map((step) => {
            return (
              <div key={step.id}>
                <div
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors ${
                    step.locked
                      ? 'opacity-40'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                  }`}
                >
                  {/* Status icon */}
                  <div className="shrink-0">
                    {step.done ? (
                      <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                    ) : step.locked ? (
                      <Lock className="w-4.5 h-4.5 text-slate-400" />
                    ) : (
                      <Circle className="w-5 h-5 text-slate-300 dark:text-slate-600" />
                    )}
                  </div>

                  {/* Text */}
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-semibold leading-none ${
                      step.done
                        ? 'text-slate-400 dark:text-slate-500 line-through'
                        : 'text-slate-800 dark:text-slate-200'
                    }`}>
                      {step.title}
                    </p>
                    <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5 truncate">
                      {step.desc}
                    </p>
                  </div>

                  {/* Action */}
                  {step.action && !step.locked && !step.done && (
                    <div className="shrink-0 flex flex-col gap-1">
                      <button
                        onClick={step.action}
                        className="flex items-center justify-center gap-1 px-3 py-1.5 rounded-lg bg-blue-500 hover:bg-blue-400 text-white text-[11px] font-bold transition-colors"
                      >
                        {step.actionLabel}
                        {step.id === 2 && (panelOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)}
                      </button>
                      {step.secondAction && (
                        <button
                          onClick={step.secondAction}
                          className="flex items-center justify-center px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 text-[11px] font-semibold hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                        >
                          {step.secondActionLabel}
                        </button>
                      )}
                    </div>
                  )}
                  {step.action && !step.locked && step.done && step.id === 2 && (
                    <button
                      onClick={step.action}
                      className="shrink-0 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 text-[11px] font-semibold hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors flex items-center gap-1"
                    >
                      {step.actionLabel}
                      {panelOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    </button>
                  )}
                </div>

                {/* ── Inline config panel (step 2) ── */}
                <AnimatePresence>
                  {step.id === 2 && panelOpen && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.25 }}
                      className="overflow-hidden"
                    >
                      <div className="mx-3 mb-2 p-4 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/50 space-y-4">
                        {/* Currency */}
                        <div className="flex items-center justify-between gap-4">
                          <div>
                            <p className="text-xs font-bold text-slate-700 dark:text-slate-200">
                              {t('onboarding.currency_label')}
                            </p>
                            <p className="text-[11px] text-slate-400 mt-0.5">
                              {t('onboarding.currency_hint')}
                            </p>
                          </div>
                          <CurrencySelector
                            value={currency}
                            onChange={setCurrency}
                            className="w-56"
                          />
                        </div>

                        {/* Email notifications */}
                        <div className="flex items-center justify-between gap-4">
                          <div>
                            <p className="text-xs font-bold text-slate-700 dark:text-slate-200">
                              {t('onboarding.email_label')}
                            </p>
                            <p className="text-[11px] text-slate-400 mt-0.5">
                              {t('onboarding.email_hint')}
                            </p>
                          </div>
                          <button
                            role="switch"
                            aria-checked={emailOptIn}
                            onClick={() => setEmailOptIn(v => !v)}
                            className={`relative shrink-0 w-11 h-6 rounded-full transition-colors duration-200 focus:outline-hidden focus:ring-2 focus:ring-blue-500 ${
                              emailOptIn ? 'bg-blue-500' : 'bg-slate-300 dark:bg-slate-600'
                            }`}
                          >
                            <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-xs transition-transform duration-200 ${
                              emailOptIn ? 'translate-x-5' : 'translate-x-0'
                            }`} />
                          </button>
                        </div>

                        {/* Save button */}
                        <button
                          onClick={() => savePrefs.mutate()}
                          disabled={savePrefs.isPending}
                          className="w-full py-2 rounded-lg bg-blue-500 hover:bg-blue-400 disabled:opacity-60 text-white text-sm font-bold transition-colors"
                        >
                          {savePrefs.isPending ? t('common.saving') : t('onboarding.save_prefs')}
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>

        {/* ── Celebration overlay ── */}
        <AnimatePresence>
          {celebrating && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 flex flex-col items-center justify-center bg-white/90 dark:bg-slate-900/90 backdrop-blur-xs rounded-2xl z-10"
            >
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 500, damping: 22 }}
                className="text-5xl mb-3"
              >
                🎉
              </motion.div>
              <p className="text-base font-black text-slate-900 dark:text-white">
                {t('onboarding.complete_title')}
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                {t('onboarding.complete_desc')}
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </AnimatePresence>
  );
}
