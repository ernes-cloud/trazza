import React, { useMemo, useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Loader2, RefreshCw, BarChart3, Info, X } from 'lucide-react';
import { computePortfolioScore, getScoreLabel } from '@/services/portfolioScoreService';
import { supabase } from '@/lib/customSupabaseClient';
import { useAiUsage } from '@/hooks/useAiUsage';
import { parseInsightBlocks } from '@/lib/aiInsightFormat';
import { renderInline } from '@/components/ui/AiInsightBlocks';
import { useSupabaseAuth } from '@/contexts/SupabaseAuthContext';
import { buildPortfolioContext } from '@/services/portfolioContextService';
import { peekPerformanceSeries } from '@/hooks/usePortfolioPerformance';
import { aiHttpErrorMessage } from '@/lib/aiHttpErrorMessage';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  Dialog, DialogPortal, DialogOverlay,
} from '@/components/ui/dialog';

// ── Constantes del gauge ─────────────────────────────────────────────────────
const R   = 62;
const CX  = 76;
const CY  = 72;
const ARC = Math.PI * R;

const PILL_STYLES = {
  excellent:  'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  good:       'bg-teal-100    text-teal-700    dark:bg-teal-500/15    dark:text-teal-300',
  moderate:   'bg-amber-100   text-amber-700   dark:bg-amber-500/15   dark:text-amber-300',
  improvable: 'bg-orange-100  text-orange-700  dark:bg-orange-500/15  dark:text-orange-400',
  at_risk:    'bg-rose-100    text-rose-700    dark:bg-rose-500/15    dark:text-rose-400',
};

function barColor(score, max) {
  const pct = max > 0 ? score / max : 0;
  if (pct >= 0.75) return '#10b981';
  if (pct >= 0.50) return '#3b82f6';
  if (pct >= 0.28) return '#f59e0b';
  return '#f43f5e';
}

// ── Gauge SVG animado ─────────────────────────────────────────────────────────
function ScoreGauge({ target, color }) {
  const [live, setLive] = useState(0);
  const raf = useRef(null);

  useEffect(() => {
    if (target === 0) { setLive(0); return; }
    const t0 = performance.now();
    const duration = 950;
    const animate = (now) => {
      const p = Math.min((now - t0) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 5);
      setLive(eased * target);
      if (p < 1) raf.current = requestAnimationFrame(animate);
    };
    raf.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf.current);
  }, [target]);

  const arcPath = `M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${CX + R} ${CY}`;
  const offset  = ARC * (1 - live / 100);

  return (
    <svg width="152" height="86" viewBox="0 0 152 86" aria-hidden="true" overflow="visible">
      <defs>
        <filter id="arc-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <path d={arcPath} fill="none" stroke="currentColor"
        className="text-slate-200 dark:text-slate-700"
        strokeWidth="10" strokeLinecap="round" />
      <path d={arcPath} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round"
        strokeDasharray={ARC} strokeDashoffset={offset}
        filter="url(#arc-glow)" opacity="0.25" />
      <path d={arcPath} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round"
        strokeDasharray={ARC} strokeDashoffset={offset} />
      <text x={CX} y={CY - 2} textAnchor="middle" fontSize="32" fontWeight="800"
        fill={color} fontFamily="inherit" letterSpacing="-1">
        {Math.round(live)}
      </text>
      <text x={CX} y={CY + 15} textAnchor="middle" fontSize="11"
        fill="#94a3b8" fontFamily="inherit" fontWeight="500">
        / 100
      </text>
    </svg>
  );
}

// ── SubScoreBar ───────────────────────────────────────────────────────────────
function SubScoreBar({ label, score, max, infoKey, openInfo, onToggleInfo, t }) {
  const pct   = max > 0 ? (score / max) * 100 : 0;
  const color = barColor(score, max);
  const isOpen = openInfo === infoKey;

  return (
    <div>
      <div className="flex justify-between items-center mb-1.5 gap-1">
        <div className="flex items-center gap-1 min-w-0 flex-1">
          <span className="text-[11px] sm:text-xs sm:leading-4 text-slate-500 dark:text-slate-400 font-medium leading-none tracking-wide truncate">
            {label}
          </span>
          <button
            onClick={() => onToggleInfo(infoKey)}
            aria-label={`Información sobre ${label}`}
            className={`shrink-0 w-4 h-4 rounded-full flex items-center justify-center transition-colors ${
              isOpen
                ? 'bg-blue-500 text-white'
                : 'text-slate-300 dark:text-slate-600 hover:text-blue-500 dark:hover:text-blue-400'
            }`}
          >
            <Info className="w-3 h-3" />
          </button>
        </div>
        <span className="text-[11px] sm:text-xs sm:leading-4 font-bold tabular-nums leading-none shrink-0" style={{ color }}>
          {Math.round(score)}
          <span className="text-slate-300 dark:text-slate-600 font-normal text-[10px]">/{max}</span>
        </span>
      </div>
      <div className="h-[3px] bg-slate-100 dark:bg-slate-700/50 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-700 ease-out"
          style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      {isOpen && (
        <div className="mt-2 px-3 py-2.5 rounded-xl bg-blue-50 dark:bg-blue-950/40 border border-blue-100 dark:border-blue-800/50 text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">
          {t(`portfolio_score.info_${infoKey}`)}
        </div>
      )}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────
function EmptyState({ t }) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center gap-3">
      <div className="w-12 h-12 rounded-2xl bg-slate-100 dark:bg-slate-700/50 flex items-center justify-center">
        <BarChart3 className="w-6 h-6 text-slate-400" />
      </div>
      <div>
        <p className="text-sm font-semibold text-slate-600 dark:text-slate-300">
          {t('portfolio_score.empty_title')}
        </p>
        <p className="text-xs text-slate-400 mt-1 max-w-[220px] leading-relaxed">
          {t('portfolio_score.empty_hint')}
        </p>
      </div>
    </div>
  );
}

// ── Botón trigger de análisis IA ──────────────────────────────────────────────
function AnalysisTriggerBtn({ insight, loading, exhausted, dailyLeft, generatedAt, lang, t, onOpen }) {
  const dateStr = generatedAt
    ? new Date(generatedAt).toLocaleDateString(lang, { day: 'numeric', month: 'short' })
    : null;

  // Estado: cargando
  if (loading && !insight) {
    return (
      <div className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl bg-violet-50 dark:bg-violet-900/10 border border-violet-100 dark:border-violet-800/40">
        <Loader2 className="w-3.5 h-3.5 text-violet-500 animate-spin" />
        <span className="text-[12px] text-violet-600 dark:text-violet-400 font-medium">
          {t('portfolio_score.analyzing')}
        </span>
      </div>
    );
  }

  // Estado: límite agotado y sin análisis previo
  if (exhausted && !insight) {
    return (
      <div className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl border border-amber-200 dark:border-amber-700/50 bg-amber-50/60 dark:bg-amber-900/10 text-[12px] text-amber-700 dark:text-amber-400">
        <Sparkles className="w-3.5 h-3.5 shrink-0" />
        {t('ai_usage.daily_limit_msg')}
      </div>
    );
  }

  // Estado: sin análisis — CTA primario
  if (!insight) {
    return (
      <button
        onClick={onOpen}
        className="group w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-dashed border-violet-300 dark:border-violet-600/60 bg-violet-50/60 dark:bg-violet-900/10 hover:bg-violet-100/80 dark:hover:bg-violet-900/25 hover:border-violet-400 dark:hover:border-violet-500 transition-all duration-200"
      >
        <Sparkles className="w-3.5 h-3.5 text-violet-600 dark:text-violet-400 transition-transform duration-200 group-hover:scale-110" />
        <span className="text-[12px] font-semibold text-violet-700 dark:text-violet-400">
          {t('portfolio_score.request_analysis')}
        </span>
        {dailyLeft !== Infinity && (
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
            dailyLeft <= 1
              ? 'bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400'
              : 'bg-violet-100 text-violet-500 dark:bg-violet-500/15 dark:text-violet-400'
          }`}>
            {dailyLeft}
          </span>
        )}
      </button>
    );
  }

  // Estado: análisis disponible — botón compacto con badge de fecha
  return (
    <button
      onClick={onOpen}
      className="group w-full flex items-center justify-between gap-2 py-2.5 px-4 rounded-xl bg-violet-50 dark:bg-violet-500/10 hover:bg-violet-100 dark:hover:bg-violet-500/20 border border-violet-100 dark:border-violet-500/20 hover:border-violet-200 dark:hover:border-violet-500/40 transition-all duration-200"
    >
      <div className="flex items-center gap-2">
        <Sparkles className="w-3.5 h-3.5 text-violet-600 dark:text-violet-400 shrink-0" />
        <span className="text-[12px] font-semibold text-violet-700 dark:text-violet-400">
          {t('portfolio_score.open_analysis_btn')}
        </span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {loading && <Loader2 className="w-3 h-3 text-violet-400 animate-spin" />}
        {dateStr && (
          <span className="text-[10px] font-medium text-violet-500 dark:text-violet-500 bg-white dark:bg-slate-800 px-2 py-0.5 rounded-full border border-violet-100 dark:border-violet-500/20">
            {dateStr}
          </span>
        )}
        <svg className="w-3.5 h-3.5 text-violet-400 group-hover:translate-x-0.5 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </div>
    </button>
  );
}

// ── Modal de análisis IA ──────────────────────────────────────────────────────
function AIAnalysisModal({ open, onClose, insight, loading, error, onRequest, exhausted, dailyLeft, generatedAt, lang, t }) {
  const dateStr = generatedAt
    ? new Date(generatedAt).toLocaleDateString(lang, { day: 'numeric', month: 'long', year: 'numeric' })
    : null;

  const parts = useMemo(() => parseInsightBlocks(insight), [insight]);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogPortal>
        {/* z-120: must sit ABOVE the app header (z-[70]) / dropdowns (z-[80]) AND the
            ExpandableWidget "maximize" popup (overlay z-[100], content z-[101]) — when the
            score widget is maximized this dialog opens nested and would otherwise render
            behind the expand popup and stay invisible. */}
        <DialogOverlay className="z-120" />
        {/* max-h in dvh: mobile vh includes the collapsed URL bar, so 92vh pushed the
            sheet's top off the REAL visible viewport. pb-safe for the iOS home indicator. */}
        <DialogPrimitive.Content aria-describedby={undefined} className="fixed left-0 right-0 bottom-0 sm:left-1/2 sm:top-1/2 sm:right-auto sm:bottom-auto sm:-translate-x-1/2 sm:-translate-y-1/2 z-120 w-full sm:w-full sm:max-w-lg max-h-[88dvh] sm:max-h-[85vh] flex flex-col bg-white dark:bg-slate-900 rounded-t-3xl sm:rounded-2xl shadow-2xl border-t border-slate-200/80 dark:border-slate-700/50 sm:border overflow-hidden pb-[env(safe-area-inset-bottom)] sm:pb-0 focus:outline-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:slide-out-to-bottom sm:data-[state=closed]:zoom-out-95 data-[state=open]:slide-in-from-bottom sm:data-[state=open]:zoom-in-95">

            {/* ── Drag handle (mobile only) ── */}
            <div className="flex justify-center pt-3 pb-1 shrink-0 sm:hidden">
              <div className="w-10 h-1 rounded-full bg-slate-200 dark:bg-slate-700" />
            </div>

            {/* ── Header ── */}
            <div className="flex items-start justify-between gap-3 px-5 pt-3 sm:pt-5 pb-4 border-b border-slate-100 dark:border-slate-800 shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                <div className="p-2 rounded-xl bg-violet-100 dark:bg-violet-500/15 shrink-0">
                  <Sparkles className="w-4 h-4 text-violet-600 dark:text-violet-400" />
                </div>
                <div className="min-w-0">
                  {/* Title de Radix (no un <p>): sin él, Radix avisa de que el diálogo
                      no tiene nombre para lectores de pantalla. */}
                  <DialogPrimitive.Title className="text-sm font-bold text-slate-900 dark:text-white leading-none">
                    {t('portfolio_score.modal_title')}
                  </DialogPrimitive.Title>
                  {dateStr && (
                    <p className="text-[11px] text-slate-400 mt-1 leading-none">
                      {t('portfolio_score.modal_generated', { date: dateStr })}
                    </p>
                  )}
                </div>
              </div>
              <button
                onClick={onClose}
                className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors mt-0.5"
                aria-label="Cerrar"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* ── Cuerpo scrollable ── */}
            <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-5 py-4">
              {/* Cargando */}
              {loading && !insight && (
                <div className="flex flex-col items-center justify-center gap-3 py-12">
                  <div className="w-10 h-10 rounded-2xl bg-violet-100 dark:bg-violet-500/15 flex items-center justify-center">
                    <Loader2 className="w-5 h-5 text-violet-500 animate-spin" />
                  </div>
                  <p className="text-sm text-slate-500 dark:text-slate-400 text-center">
                    {t('portfolio_score.analyzing')}
                  </p>
                </div>
              )}

              {/* Límite agotado sin insight */}
              {exhausted && !insight && !loading && (
                <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
                  <Sparkles className="w-8 h-8 text-amber-400" />
                  <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
                    {t('ai_usage.daily_limit_msg')}
                  </p>
                </div>
              )}

              {/* Error de Groq / 503 — sin insight previo (mensaje concreto por code) */}
              {error && !insight && !loading && (
                <div className="flex flex-col items-center justify-center gap-4 py-12 text-center">
                  <div className="w-12 h-12 rounded-2xl bg-rose-100 dark:bg-rose-500/15 flex items-center justify-center">
                    <X className="w-6 h-6 text-rose-500" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                      {t('portfolio_score.ai_error_title')}
                    </p>
                    <p className="text-xs text-slate-400 mt-1 max-w-[280px] leading-relaxed">
                      {typeof error === 'string' ? error : t('portfolio_score.ai_error_desc')}
                    </p>
                  </div>
                  {!exhausted && (
                    <button
                      onClick={onRequest}
                      className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-700 text-white text-sm font-semibold transition-colors"
                    >
                      <RefreshCw className="w-4 h-4" />
                      {t('portfolio_score.refresh_analysis')}
                    </button>
                  )}
                </div>
              )}

              {/* Error de Groq — con insight previo: aviso compacto sobre el texto */}
              {error && insight && !loading && (
                <div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-lg bg-rose-50 dark:bg-rose-900/20 border border-rose-100 dark:border-rose-800/40">
                  <X className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                  <span className="text-[11px] text-rose-600 dark:text-rose-400 flex-1">
                    {t('portfolio_score.ai_error_refresh')}
                  </span>
                  {!exhausted && (
                    <button onClick={onRequest} className="text-[11px] font-semibold text-rose-600 dark:text-rose-400 hover:underline shrink-0">
                      {t('portfolio_score.refresh_analysis')}
                    </button>
                  )}
                </div>
              )}

              {/* Sin insight + sin loading + no agotado + sin error (CTA vacío) */}
              {!insight && !loading && !exhausted && !error && (
                <div className="flex flex-col items-center justify-center gap-4 py-12 text-center">
                  <div className="w-12 h-12 rounded-2xl bg-violet-100 dark:bg-violet-500/15 flex items-center justify-center">
                    <Sparkles className="w-6 h-6 text-violet-500" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                      {t('portfolio_score.request_analysis')}
                    </p>
                    {dailyLeft !== Infinity && (
                      <p className="text-xs text-slate-400 mt-1">
                        {t('ai_usage.remaining', { n: dailyLeft })}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={onRequest}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-700 text-white text-sm font-semibold transition-colors shadow-xs shadow-violet-200 dark:shadow-none"
                  >
                    <Sparkles className="w-4 h-4" />
                    {t('portfolio_score.request_analysis')}
                  </button>
                </div>
              )}

              {/* Insight renderizado */}
              {insight && (
                <div className="space-y-0">
                  {loading && (
                    <div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-lg bg-violet-50 dark:bg-violet-900/20 border border-violet-100 dark:border-violet-800/40">
                      <Loader2 className="w-3.5 h-3.5 text-violet-500 animate-spin shrink-0" />
                      <span className="text-[11px] text-violet-600 dark:text-violet-400">
                        {t('portfolio_score.analyzing')}
                      </span>
                    </div>
                  )}
                  {parts.map((part, i) =>
                    part.type === 'header' ? (
                      <div key={i} className={`flex items-center gap-2 min-w-0 ${i === 0 ? 'mb-3' : 'mt-6 mb-3'}`}>
                        {part.emoji && (
                          <span className="text-base leading-none shrink-0">{part.emoji}</span>
                        )}
                        {/* wrap-break-word (NOT nowrap): long section titles overflowed
                            horizontally on 360px screens, breaking the whole sheet */}
                        <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 tracking-widest uppercase wrap-break-word min-w-0">
                          {part.text}
                        </span>
                        <div className="flex-1 min-w-[16px] h-px bg-slate-100 dark:bg-slate-800" />
                      </div>
                    ) : part.type === 'paragraph' ? (
                      <p key={i} className="text-[13px] text-slate-600 dark:text-slate-300 leading-relaxed wrap-break-word mb-3">
                        {renderInline(part.text)}
                      </p>
                    ) : (
                      <div key={i} className="flex items-start gap-2.5 py-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-violet-400 dark:bg-violet-500 shrink-0 translate-y-[6px]" />
                        <span className="text-[13px] text-slate-600 dark:text-slate-300 leading-relaxed wrap-break-word min-w-0">
                          {renderInline(part.text)}
                        </span>
                      </div>
                    )
                  )}
                </div>
              )}
            </div>

            {/* ── Footer — botón regenerar ── */}
            {insight && (
              <div className="px-5 py-3.5 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3 shrink-0 bg-slate-50/80 dark:bg-slate-900/80">
                <p className="text-[11px] text-slate-400 leading-tight max-w-[60%]">
                  {t('portfolio_score.ai_label')} · Groq / Llama
                </p>
                <button
                  onClick={onRequest}
                  disabled={exhausted || loading}
                  title={exhausted ? t('ai_usage.daily_limit_msg') : undefined}
                  className={`flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-lg transition-colors ${
                    exhausted || loading
                      ? 'text-slate-300 dark:text-slate-600 cursor-not-allowed bg-transparent'
                      : 'text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-500/10'
                  }`}
                >
                  {loading
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <RefreshCw className="w-3.5 h-3.5" />
                  }
                  {t('portfolio_score.refresh_analysis')}
                  {!exhausted && !loading && dailyLeft !== Infinity && (
                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                      dailyLeft <= 1
                        ? 'bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400'
                        : 'bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400'
                    }`}>
                      {dailyLeft}
                    </span>
                  )}
                </button>
              </div>
            )}
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}

// ── Widget principal ──────────────────────────────────────────────────────────
export default function PortfolioScoreWidget({
  positions = [],
  brokers = [],
  totalWealth = 0,
  totalInvested = 0,
  totalBuyCost = 0,
  cashPosition = 0,
  totalDividends = 0,
  totalFees = 0,
  totalGainPct = 0,
  portfolioStartDate = null,
  exchangeRates = {},
  currency = 'EUR',
}) {
  const { t, i18n } = useTranslation();
  const { user } = useSupabaseAuth();
  const [insight, setInsight]               = useState(null);
  const [insightTimestamp, setInsightTimestamp] = useState(null);
  const [aiLoading, setAiLoading]           = useState(false);
  /** null | string — mensaje i18n del fallo IA (antes boolean; no avisaba en 503). */
  const [aiError,   setAiError]             = useState(null);
  const [openInfo, setOpenInfo]             = useState(null);
  const [modalOpen, setModalOpen]           = useState(false);

  const { dailyLeft, exhausted: analysisExhausted, refresh: refreshAnalysisUsage } = useAiUsage('analysis');

  const cacheKey = useMemo(() => {
    const uid  = user?.id || 'anon';
    const bids = brokers.map(b => b.id).sort().join('_') || 'all';
    // Con el idioma en la clave: al cambiar de idioma no se sirve el análisis
    // guardado en el otro.
    const lang = i18n.language?.startsWith('es') ? 'es' : 'en';
    return `trazza_score_insight_${uid}_${bids}_${lang}`;
  }, [user?.id, brokers, i18n.language]);

  // Known fallback strings that should never be shown as real analysis
  const STALE_FALLBACKS = [
    'El análisis no está disponible en este momento.',
    'Analysis is not available at this moment.',
  ];

  useEffect(() => {
    setInsight(null);
    setInsightTimestamp(null);
    setAiError(null);
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) {
        const { insight: cached, timestamp, isFallback } = JSON.parse(raw);
        // Clear old-style fallback strings or entries flagged as fallback
        if (isFallback || STALE_FALLBACKS.includes(cached)) {
          localStorage.removeItem(cacheKey);
          return;
        }
        if (cached) { setInsight(cached); setInsightTimestamp(timestamp || null); }
      }
    } catch {}
  }, [cacheKey]);

  const handleToggleInfo = (key) => setOpenInfo(prev => prev === key ? null : key);

  const scoreData = useMemo(() => computePortfolioScore({
    positions, totalWealth, totalInvested, totalBuyCost, cashPosition,
    totalDividends, totalFees, totalGainPct, portfolioStartDate, exchangeRates, currency,
  }), [positions, totalWealth, totalInvested, totalBuyCost, cashPosition, totalDividends, totalFees, totalGainPct, portfolioStartDate]);

  const { total, breakdown, nPositions } = scoreData;
  const { key: labelKey, color } = getScoreLabel(total);

  // Datos para la IA: el MISMO contexto que el chat de cartera
  // (buildPortfolioContext — agrupa por ISIN, nombres limpios, divisas bien
  // etiquetadas, sectores y rentabilidad TWR). Antes este widget hacía su propio
  // cálculo: sin agrupar (Amazon USD y EUR como dos posiciones) y solo con la
  // "clase de activo", que en una cartera de acciones vale "Stock" para todo.
  const aiContext = useMemo(() => {
    const ctx = buildPortfolioContext({
      positions, brokers, rates: exchangeRates, currency,
      performanceSeries: user?.id ? peekPerformanceSeries({ userId: user.id, brokerId: 'general', currency }) : null,
    });
    const top5 = ctx.positions.slice(0, 5).map(p => ({
      name: p.name, ticker: p.symbol, weight: +p.weightPct.toFixed(1), gainPct: +p.gainPct.toFixed(1),
    }));
    const worst3 = [...ctx.positions].sort((x, y) => x.gainPct - y.gainPct)
      .slice(0, 3).filter(p => p.gainPct < -1)
      .map(p => ({ name: p.name, ticker: p.symbol, gainPct: +p.gainPct.toFixed(1) }));
    const classMap = {};
    for (const r of ctx.positions) classMap[r.assetClass || 'Stock'] = (classMap[r.assetClass || 'Stock'] || 0) + r.weightPct;
    const assetClasses = Object.entries(classMap)
      .map(([cls, pct]) => ({ cls, pct: +pct.toFixed(1) }))
      .sort((x, y) => y.pct - x.pct);
    return {
      top5, worst3, assetClasses,
      sectors: ctx.bySector.map(s => ({ name: s.name, pct: s.weightPct })),
      countries: ctx.byCountry.map(c => ({ name: c.name, pct: c.weightPct })),
      performance: ctx.performance,
    };
  }, [positions, brokers, currency, exchangeRates, user?.id]);

  const requestAnalysis = async () => {
    if (analysisExhausted) return;
    // En la demo no hay sesión: el server responde 401 seguro. Se avisa sin
    // lanzar la petición (antes salía el 401 en consola en cada intento).
    if (localStorage.getItem('trazza_demo_mode') === 'true') {
      if (!insight) setInsight(t('portfolio_score.demo_unavailable'));
      return;
    }
    setAiLoading(true);
    try {
      const lang   = i18n.language?.startsWith('es') ? 'es' : 'en';
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch('/api/score-portfolio', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { 'Authorization': `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({
          score: total, breakdown, nPositions, lang, currency,
          brokerNames: brokers.map(b => b.name),
          absoluteValues: {
            totalWealth:    Math.round(totalWealth),
            totalInvested:  Math.round(totalInvested),
            cashPosition:   Math.round(cashPosition),
            totalFees:      Math.round(totalFees),
            totalDividends: Math.round(totalDividends),
          },
          top5: aiContext.top5, worst3: aiContext.worst3, assetClasses: aiContext.assetClasses,
          sectors: aiContext.sectors, countries: aiContext.countries, performance: aiContext.performance,
        }),
      });
      if (resp.status === 429) {
        const errData = await resp.json();
        const reason = errData.reason === 'monthly' ? t('ai_usage.monthly_limit') : t('ai_usage.daily_limit');
        if (!insight) setInsight(reason);
        return;
      }
      if (resp.status === 401) {
        const isDemo = localStorage.getItem('trazza_demo_mode') === 'true';
        if (!insight) setInsight(isDemo ? t('portfolio_score.demo_unavailable') : t('portfolio_score.session_expired'));
        return;
      }
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        setAiError(aiHttpErrorMessage({
          status: resp.status, error: errData.error, code: errData.code, t,
        }));
        return;
      }
      const respData = await resp.json();
      if (respData.isFallback) {
        // Groq failed — don't overwrite a valid cached insight, just surface the error
        setAiError(t('portfolio_score.ai_error_desc'));
      } else if (respData.insight) {
        const timestamp = new Date().toISOString();
        setInsight(respData.insight);
        setInsightTimestamp(timestamp);
        setAiError(null);
        try { localStorage.setItem(cacheKey, JSON.stringify({ insight: respData.insight, timestamp })); } catch {}
        refreshAnalysisUsage();
      }
    } catch {
      setAiError(t('portfolio_score.server_unreachable'));
    } finally {
      setAiLoading(false);
    }
  };

  // Al abrir el modal sin análisis previo, lo lanza automáticamente
  const handleOpenModal = () => {
    setAiError(null);
    setModalOpen(true);
    if (!insight && !aiLoading && !analysisExhausted) requestAnalysis();
  };

  const bars = [
    { labelKey: 'label_diversification', infoKey: 'diversification', ...breakdown.diversification },
    { labelKey: 'label_performance',     infoKey: 'performance',     ...breakdown.performance },
    { labelKey: 'label_costs',           infoKey: 'costs',           ...breakdown.costs },
    { labelKey: 'label_liquidity',       infoKey: 'liquidity',       ...breakdown.liquidity },
    // "Ingresos pasivos" se retiró como pilar (ver portfolioScoreService): sus 15
    // puntos se repartieron entre los cuatro de arriba, que ya suman 100.
  ];

  return (
    <>
      <div className="bg-white dark:bg-slate-800/80 border border-slate-200/80 dark:border-slate-700/40 rounded-2xl shadow-xs overflow-hidden">

        {/* ── Cabecera ── */}
        <div className="flex items-center justify-between px-4 sm:px-5 pt-4 sm:pt-5 pb-3 sm:pb-4">
          <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
            <div className="p-1.5 rounded-xl bg-violet-100 dark:bg-violet-500/15 shrink-0">
              <BarChart3 className="w-4 h-4 text-violet-600 dark:text-violet-400" />
            </div>
            <div className="min-w-0">
              {/* leading-tight y no leading-none: con `truncate` (overflow oculto) el
                  interlineado 1 cortaba la tilde de la Ó mayúscula ("PUNTUACION"). */}
              <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest leading-tight truncate">
                {t('portfolio_score.title')}
              </p>
              {nPositions > 0 && (
                <p className="text-[10px] text-slate-400 mt-0.5 leading-none hidden sm:block">
                  {t('portfolio_score.subtitle', { n: nPositions })}
                </p>
              )}
            </div>
          </div>
          {nPositions > 0 && (
            <span className={`text-[10px] font-bold px-2 sm:px-2.5 py-1 rounded-full shrink-0 ml-2 ${PILL_STYLES[labelKey]}`}>
              {t(`portfolio_score.label_${labelKey}`)}
            </span>
          )}
        </div>

        {/* ── Cuerpo ── */}
        <div className="px-4 sm:px-5 pb-4 sm:pb-5">
          {nPositions === 0 ? (
            <EmptyState t={t} />
          ) : (
            <>
              <div className="flex flex-col sm:grid sm:grid-cols-[140px_1fr] gap-4 sm:gap-5 sm:items-center">
                <div className="flex sm:flex-col items-center justify-center gap-3 sm:gap-0">
                  <ScoreGauge target={total} color={color} />
                  <div className="sm:mt-0.5 text-center">
                    <p className="text-[11px] font-semibold" style={{ color }}>
                      {t(`portfolio_score.label_${labelKey}`)}
                    </p>
                    <p className="text-[10px] text-slate-400 mt-0.5 sm:hidden">
                      {t('portfolio_score.subtitle', { n: nPositions })}
                    </p>
                  </div>
                </div>
                <div className="space-y-3">
                  {bars.map(bar => (
                    <SubScoreBar
                      key={bar.labelKey}
                      label={t(`portfolio_score.${bar.labelKey}`)}
                      score={bar.score}
                      max={bar.max}
                      infoKey={bar.infoKey}
                      openInfo={openInfo}
                      onToggleInfo={handleToggleInfo}
                      t={t}
                    />
                  ))}
                </div>
              </div>

              {/* ── Botón trigger IA ── */}
              <div className="mt-4">
                <AnalysisTriggerBtn
                  insight={insight}
                  loading={aiLoading}
                  exhausted={analysisExhausted}
                  dailyLeft={dailyLeft}
                  generatedAt={insightTimestamp}
                  lang={i18n.language}
                  t={t}
                  onOpen={handleOpenModal}
                />
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Modal ── */}
      <AIAnalysisModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        insight={insight}
        loading={aiLoading}
        error={aiError}
        onRequest={() => { setAiError(null); requestAnalysis(); }}
        exhausted={analysisExhausted}
        dailyLeft={dailyLeft}
        generatedAt={insightTimestamp}
        lang={i18n.language}
        t={t}
      />
    </>
  );
}
