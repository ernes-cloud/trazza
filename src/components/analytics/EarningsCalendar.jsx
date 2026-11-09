import React, { useState, useEffect } from 'react';
import { runPooled } from '@/lib/asyncPool';
import { useTranslation } from 'react-i18next';
import { earningsService } from '@/services/earningsService';
import { fetchEarningsDetail, requestEarningsAnalysis, calendarQuarterOf, withEventEstimate } from '@/services/earningsAnalysisService';
import { resolveTicker } from '@/lib/tickerMap';
import { isCashPosition } from '@/lib/positionKind';
import { useAiUsage } from '@/hooks/useAiUsage';
import { AiInsightBlocks } from '@/components/ui/AiInsightBlocks';
import { Loader2, BarChart3, TrendingUp, TrendingDown, Clock, ChevronDown, ChevronRight, Sparkles, RefreshCw, AlertCircle } from 'lucide-react';

// Cached per ticker+report date: re-expanding a row must never re-spend AI quota
const aiCacheKey = (ticker, date) => `trazza_earnings_ai_v2:${ticker}:${date || 'na'}`;

const NOTICE_AMBER = 'bg-amber-50/70 dark:bg-amber-900/10 border-amber-200 dark:border-amber-700/40 text-amber-700 dark:text-amber-400';
const NOTICE_ROSE = 'bg-rose-50/70 dark:bg-rose-900/10 border-rose-200 dark:border-rose-800/40 text-rose-600 dark:text-rose-400';

// BPA y sorpresa con el separador decimal del idioma: la cabecera y el historial
// de una misma tarjeta no pueden escribir "$4.70" y "$4,72" a la vez.
const localeOf = (lang) => (lang?.startsWith('es') ? 'es-ES' : 'en-US');
const formatEps = (v, locale) => `$${v.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const formatSurprise = (v, locale) =>
    `${v >= 0 ? '+' : ''}${v.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;

/**
 * Una fila del historial trimestral: "T2 2026 · publicado 30 jul" a la izquierda,
 * "est. $1,83 → $5,75 +214,9 %" a la derecha. La fila del trimestre en curso
 * lleva el consenso y cuántos analistas lo forman en lugar del resultado.
 */
const QuarterHistoryRow = ({ q }) => {
    const { t, i18n } = useTranslation();
    const locale = localeOf(i18n.language);
    const eps = (v) => formatEps(v, locale);
    const cq = calendarQuarterOf(q.date);
    const label = cq ? t('analytics.earnings_calendar.quarter_label', { q: cq.quarter, y: cq.year }) : (q.date || '—');
    const reported = q.reportedDate
        ? new Date(`${q.reportedDate}T12:00:00`).toLocaleDateString(locale, { day: 'numeric', month: 'short' })
        : null;
    const hasBoth = q.epsActual !== null && q.epsEstimate !== null;
    const beat = hasBoth && q.epsActual > q.epsEstimate;
    const miss = hasBoth && q.epsActual < q.epsEstimate;
    const tone = beat ? 'text-emerald-600 dark:text-emerald-400' : miss ? 'text-rose-500 dark:text-rose-400' : 'text-slate-600 dark:text-slate-300';

    return (
        <div className={`flex items-center justify-between gap-2 py-1.5 px-2 rounded-md ${q.upcoming ? 'bg-purple-50 dark:bg-purple-900/10' : 'bg-slate-50 dark:bg-slate-800/50'}`}>
            <div className="flex items-center gap-2 min-w-0">
                <span className="text-[11px] font-black text-slate-700 dark:text-slate-200 tabular-nums" title={q.date || undefined}>{label}</span>
                {q.upcoming ? (
                    <span className="text-[8px] font-black uppercase bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 px-1 py-0.5 rounded">{t('analytics.dividend_calendar.upcoming')}</span>
                ) : reported && (
                    <span className="text-[9px] text-slate-400 truncate">{t('analytics.earnings_calendar.reported_on', { date: reported })}</span>
                )}
            </div>
            <div className="flex items-center gap-2 shrink-0 tabular-nums">
                {q.epsEstimate !== null && (
                    <span className="text-[10px] text-slate-400">
                        {t('analytics.earnings_calendar.est_short')} <span className="font-bold text-slate-600 dark:text-slate-300">{eps(q.epsEstimate)}</span>
                    </span>
                )}
                {q.upcoming && q.analysts !== null && q.analysts !== undefined && (
                    <span className="text-[9px] text-slate-400">· {t('analytics.earnings_calendar.analysts', { count: q.analysts })}</span>
                )}
                {q.epsActual !== null && (
                    <span className={`text-[10px] font-bold flex items-center gap-0.5 ${tone}`}>
                        {beat && <TrendingUp className="w-2.5 h-2.5" />}
                        {miss && <TrendingDown className="w-2.5 h-2.5" />}
                        {eps(q.epsActual)}
                    </span>
                )}
                {q.surprisePct !== null && (
                    <span className={`text-[9px] font-black px-1 py-0.5 rounded min-w-[44px] text-right ${q.surprisePct >= 0 ? 'bg-emerald-100/60 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400' : 'bg-rose-100/60 dark:bg-rose-900/30 text-rose-500 dark:text-rose-400'}`}>
                        {formatSurprise(q.surprisePct, locale)}
                    </span>
                )}
            </div>
        </div>
    );
};

const Notice = ({ tone, icon: Icon, children }) => (
    <div className={`flex items-start gap-2 px-3 py-2 rounded-xl border text-[11px] leading-4 ${tone}`}>
        <Icon className="w-3.5 h-3.5 shrink-0 mt-px" />
        <span className="flex-1">{children}</span>
    </div>
);

// ── Panel de análisis IA de una presentación de resultados ────────────────────
const EarningsAiPanel = ({ ai, loading, exhausted, dailyLeft, published, lang, onAnalyze, t }) => {
    const insight = ai?.insight;
    const status = ai?.status;
    const dateStr = ai?.generatedAt
        ? new Date(ai.generatedAt).toLocaleDateString(lang, { day: 'numeric', month: 'short' })
        : null;

    if (loading) {
        return (
            <div className="flex items-center justify-center gap-2 py-2.5 rounded-xl bg-violet-50 dark:bg-violet-900/10 border border-violet-100 dark:border-violet-800/40">
                <Loader2 className="w-3.5 h-3.5 text-violet-500 animate-spin" />
                <span className="text-[11px] font-medium text-violet-600 dark:text-violet-400">
                    {t('analytics.earnings_calendar.ai_analyzing')}
                </span>
            </div>
        );
    }

    if (insight) {
        return (
            <div className="rounded-xl bg-violet-50/50 dark:bg-violet-900/10 border border-violet-100 dark:border-violet-800/30 p-3">
                {status === 'error' && (
                    <div className="mb-2">
                        <Notice tone={NOTICE_ROSE} icon={AlertCircle}>{t('analytics.earnings_calendar.ai_error')}</Notice>
                    </div>
                )}
                <AiInsightBlocks insight={insight} />
                <div className="flex items-center justify-between gap-2 mt-3 pt-2 border-t border-violet-100 dark:border-violet-800/30">
                    <p className="text-[9px] text-slate-400 leading-snug flex-1">
                        {t('analytics.earnings_calendar.ai_disclaimer')}
                        {dateStr && ` · ${t('analytics.earnings_calendar.ai_generated_on', { date: dateStr })}`}
                    </p>
                    {!exhausted && (
                        <button
                            onClick={onAnalyze}
                            className="flex items-center gap-1 shrink-0 text-[10px] font-bold text-violet-600 dark:text-violet-400 hover:underline"
                        >
                            <RefreshCw className="w-3 h-3" />
                            {t('analytics.earnings_calendar.ai_regenerate')}
                        </button>
                    )}
                </div>
            </div>
        );
    }

    if (status === 'auth') {
        const isDemo = localStorage.getItem('trazza_demo_mode') === 'true';
        return <Notice tone={NOTICE_AMBER} icon={Sparkles}>{isDemo ? t('portfolio_score.demo_unavailable') : t('portfolio_score.session_expired')}</Notice>;
    }
    if (status === 'limit') {
        return <Notice tone={NOTICE_AMBER} icon={Sparkles}>{ai.reason === 'monthly' ? t('ai_usage.monthly_limit_msg') : t('ai_usage.daily_limit_msg')}</Notice>;
    }
    if (exhausted) {
        return <Notice tone={NOTICE_AMBER} icon={Sparkles}>{t('ai_usage.daily_limit_msg')}</Notice>;
    }
    if (status === 'error') {
        return (
            <div className="space-y-2">
                <Notice tone={NOTICE_ROSE} icon={AlertCircle}>{t('analytics.earnings_calendar.ai_error')}</Notice>
                <button
                    onClick={onAnalyze}
                    className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl border border-violet-200 dark:border-violet-700/50 text-[11px] font-semibold text-violet-700 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors"
                >
                    <RefreshCw className="w-3.5 h-3.5" />
                    {t('analytics.earnings_calendar.ai_retry')}
                </button>
            </div>
        );
    }

    return (
        <button
            onClick={onAnalyze}
            className="group w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-dashed border-violet-300 dark:border-violet-600/60 bg-violet-50/60 dark:bg-violet-900/10 hover:bg-violet-100/80 dark:hover:bg-violet-900/25 hover:border-violet-400 dark:hover:border-violet-500 transition-all duration-200"
        >
            <Sparkles className="w-3.5 h-3.5 text-violet-600 dark:text-violet-400 transition-transform duration-200 group-hover:scale-110" />
            <span className="text-[11px] font-semibold text-violet-700 dark:text-violet-400">
                {published
                    ? t('analytics.earnings_calendar.ai_analyze')
                    : t('analytics.earnings_calendar.ai_analyze_upcoming')}
            </span>
            {dailyLeft !== Infinity && (
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                    dailyLeft <= 1
                        ? 'bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400'
                        : 'bg-violet-100 text-violet-500 dark:bg-violet-500/15 dark:text-violet-400'
                }`}>
                    {dailyLeft}
                </span>
            )}
        </button>
    );
};

const EarningsCalendar = ({ positions = [] }) => {
    const { t, i18n } = useTranslation();
    const [events, setEvents] = useState([]);
    const [noDataTickers, setNoDataTickers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [expandedTicker, setExpandedTicker] = useState(null);
    const [detailCache, setDetailCache] = useState({});   // ticker → { history, revenue, priceReaction }
    const [historyLoading, setHistoryLoading] = useState({});
    const [aiByTicker, setAiByTicker] = useState({});   // ticker → { insight, generatedAt, status }
    const [aiLoading, setAiLoading] = useState({});
    const { dailyLeft, exhausted: aiExhausted, refresh: refreshAiUsage } = useAiUsage('analysis');

    useEffect(() => {
        if (!positions.length) { setLoading(false); return; }

        const fetchAll = async () => {
            setLoading(true);
            const seen = new Set();
            const results = [];
            const noData = [];

            const invested = positions.filter(p => {
                const hasQty = parseFloat(p.quantity) > 0.0001; // exclude sold/closed positions
                const isCash = isCashPosition(p);
                const ticker = resolveTicker(p.assets?.ticker);
                const isCrypto = ticker ? /^[A-Z0-9]+-[A-Z]{3}$/.test(ticker) : false;
                const isEtf = p.assets?.asset_class === 'ETF';
                return hasQty && !isCash && !isCrypto && !isEtf;
            });

            // POOL, no ráfaga: cada ticker acaba en /api/yahoo-profile, que es
            // justo el proxy que devolvía 429 en cadena (ver lib/asyncPool).
            await runPooled(invested.map((p) => async () => {
                const ticker = resolveTicker(p.assets?.ticker);
                if (!ticker || seen.has(ticker)) return;
                seen.add(ticker);
                try {
                    const data = await earningsService.getEarnings(ticker);
                    if (!data) {
                        noData.push({ ticker, name: p.assets?.company_name || ticker });
                        return;
                    }
                    results.push({
                        ticker,
                        name: data.name || p.assets?.company_name || ticker,
                        date: data.date,
                        epsActual: data.epsActual,
                        epsForecast: data.epsForecast,
                        surprisePct: data.surprisePct,
                        time: data.time,
                        fiscalQuarter: data.fiscalQuarter,
                    });
                } catch (e) {
                    console.warn(`EarningsCalendar: ${ticker}`, e);
                    noData.push({ ticker, name: p.assets?.company_name || ticker });
                }
            }));

            const now = new Date();
            results.sort((a, b) => {
                const aFut = new Date(a.date) >= now;
                const bFut = new Date(b.date) >= now;
                if (aFut && bFut) return new Date(a.date) - new Date(b.date);
                if (aFut) return -1;
                if (bFut) return 1;
                return new Date(b.date) - new Date(a.date);
            });

            setEvents(results);
            setNoDataTickers(noData);
            setLoading(false);
        };

        fetchAll();
    }, [positions]);

    // Historial + ingresos + cotización en UNA sola llamada (ver earningsAnalysisService):
    // el detalle completo se guarda porque el análisis IA reutiliza revenue/priceReaction.
    // Se guarda ya alineado con la estimación de la cabecera (withEventEstimate).
    const fetchEarningsHistory = async (ev) => {
        const { ticker } = ev;
        if (detailCache[ticker] !== undefined) return;
        setHistoryLoading(prev => ({ ...prev, [ticker]: true }));
        try {
            const detail = withEventEstimate(await fetchEarningsDetail(ticker), ev);
            setDetailCache(prev => ({ ...prev, [ticker]: detail }));
        } finally {
            setHistoryLoading(prev => ({ ...prev, [ticker]: false }));
        }
    };

    // Restores a previously generated analysis from localStorage (same report date only)
    const loadCachedAnalysis = (ev) => {
        if (aiByTicker[ev.ticker] !== undefined) return;
        try {
            const raw = localStorage.getItem(aiCacheKey(ev.ticker, ev.date));
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (!parsed?.insight) return;
            setAiByTicker(prev => ({
                ...prev,
                [ev.ticker]: { insight: parsed.insight, generatedAt: parsed.generatedAt || null, status: 'ok' },
            }));
        } catch { /* corrupted entry — just regenerate on demand */ }
    };

    const analyzeEarnings = async (ev) => {
        if (aiLoading[ev.ticker]) return;
        setAiLoading(prev => ({ ...prev, [ev.ticker]: true }));
        try {
            const lang = i18n.language?.startsWith('es') ? 'es' : 'en';
            // El detalle ya se cargó al desplegar la fila; si Yahoo falló entonces,
            // se reintenta aquí antes de gastar cuota con un prompt vacío.
            const detail = detailCache[ev.ticker]?.history?.length
                ? detailCache[ev.ticker]
                : withEventEstimate(await fetchEarningsDetail(ev.ticker), ev);
            if (detail !== detailCache[ev.ticker]) setDetailCache(prev => ({ ...prev, [ev.ticker]: detail }));
            const result = await requestEarningsAnalysis({
                ticker: ev.ticker,
                name: ev.name,
                lang,
                event: {
                    date: ev.date,
                    epsActual: ev.epsActual,
                    epsForecast: ev.epsForecast,
                    surprisePct: ev.surprisePct,
                    time: ev.time,
                    fiscalQuarter: ev.fiscalQuarter,
                },
                history: detail.history,
                revenue: detail.revenue,
                priceReaction: detail.priceReaction,
            });

            if (result.status === 'ok') {
                const generatedAt = new Date().toISOString();
                setAiByTicker(prev => ({ ...prev, [ev.ticker]: { insight: result.insight, generatedAt, status: 'ok' } }));
                try {
                    localStorage.setItem(aiCacheKey(ev.ticker, ev.date), JSON.stringify({ insight: result.insight, generatedAt }));
                } catch { /* quota full — the analysis still shows this session */ }
                refreshAiUsage();
            } else {
                // Keep any previous insight visible; only flag the failed attempt
                setAiByTicker(prev => ({
                    ...prev,
                    [ev.ticker]: { ...(prev[ev.ticker] || {}), status: result.status, reason: result.reason },
                }));
            }
        } finally {
            setAiLoading(prev => ({ ...prev, [ev.ticker]: false }));
        }
    };

    const toggleExpand = (ev) => {
        if (expandedTicker === ev.ticker) {
            setExpandedTicker(null);
        } else {
            setExpandedTicker(ev.ticker);
            fetchEarningsHistory(ev);
            loadCachedAnalysis(ev);
        }
    };

    const getDaysUntil = (dateStr) => {
        if (!dateStr) return null;
        return (new Date(dateStr) - new Date()) / (1000 * 60 * 60 * 24);
    };

    const uiLocale = localeOf(i18n.language);
    const formatDate = (dateStr) =>
        new Date(dateStr).toLocaleDateString(uiLocale, { day: 'numeric', month: 'short', year: 'numeric' });

    const formatCountdown = (days) => {
        if (days === null) return null;
        if (days < -1) return t('common.days_ago', { n: Math.abs(Math.floor(days)) });
        if (days < 0) return t('common.yesterday');
        if (days < 1) return t('common.today_label');
        if (days < 2) return t('common.tomorrow');
        return t('common.in_days', { n: Math.ceil(days) });
    };

    const getCardStyle = (days, published) => {
        // Ya pasado (publicado o aún sin cifras): neutro. `days <= 1` también es
        // cierto para los negativos, y un resultado de hace 2 días salía en el
        // rojo de "inminente".
        if (published || (days !== null && days < 0)) return 'bg-slate-50 dark:bg-slate-900/30 border-slate-200 dark:border-slate-700/50';
        if (days !== null && days <= 1) return 'bg-red-50 dark:bg-red-900/10 border-red-300 dark:border-red-700/40';
        if (days !== null && days <= 7) return 'bg-orange-50 dark:bg-orange-900/10 border-orange-200 dark:border-orange-700/30';
        return 'bg-purple-50 dark:bg-purple-900/10 border-purple-200 dark:border-purple-800/30';
    };

    const UrgencyBadge = ({ days }) => {
        if (days === null || days < 0) return null;
        if (days <= 1) return <span className="text-[9px] font-black uppercase tracking-wide bg-red-500 text-white px-1.5 py-0.5 rounded-full">{t('analytics.earnings_calendar.imminent')}</span>;
        if (days <= 7) return <span className="text-[9px] font-black uppercase tracking-wide bg-orange-400 text-white px-1.5 py-0.5 rounded-full">{t('analytics.earnings_calendar.this_week')}</span>;
        return null;
    };

    const TimeLabel = ({ time }) => {
        if (!time || time === 'time-not-supplied') return null;
        const label = time === 'time-after-hours' ? t('analytics.earnings_calendar.close') : time === 'time-before-hours' ? t('analytics.earnings_calendar.open') : null;
        if (!label) return null;
        return <span className="text-[9px] text-slate-400 font-medium">{label}</span>;
    };

    if (loading) return (
        // h-full + min-h: mientras carga tiene que ocupar la misma celda que
        // ocupará después, o la fila da un salto de alto al resolverse.
        <div className="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-2xl overflow-hidden shadow-xs h-full min-h-[400px] flex items-center justify-center">
            <Loader2 className="w-8 h-8 animate-spin text-purple-600" />
        </div>
    );

    return (
        <div className="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-2xl overflow-hidden shadow-xs relative flex flex-col h-full">
            {/* Cabecera con el estilo del resto de widgets (Noticias, Puntuación):
                antes era una tarjeta aparte — esquinas de 2.5rem, degradado, sombra
                grande y título text-xl — y la fila de abajo no parecía del mismo panel. */}
            <div className="shrink-0 flex items-center px-5 py-3.5 border-b border-slate-100 dark:border-slate-800">
                <div className="flex items-center gap-2">
                    <div className="p-1.5 bg-purple-50 dark:bg-purple-900/20 rounded-lg">
                        <BarChart3 className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                    </div>
                    <div>
                        <h3 className="text-sm font-bold text-slate-900 dark:text-white">{t('analytics.earnings_calendar.title')}</h3>
                        <p className="text-[10px] text-slate-400 mt-px">{t('analytics.earnings_calendar.subtitle')}</p>
                    </div>
                </div>
            </div>

            {/* El cuerpo RELLENA el alto que le deje la fila en vez de capar a una
                altura fija: la card estira con `h-full` y la fila la marca el widget
                más alto que la comparta, así que el tope dejaba un hueco blanco de
                ~175px al final (medido en la demo: card 693px, contenido 518px) y,
                a la vez, cortaba la lista a media fila.
                El scroller va ABSOLUTO dentro de un contenedor `relative`: fuera de
                flujo, su contenido no infla la fila — que es lo que el tope evitaba.
                `min-h-[420px]` conserva EXACTAMENTE la contribución de antes; sin él
                la lista colapsaría a 0 en móvil, donde la fila mide su contenido.
                Mismo patrón que PortfolioNewsWidget. */}
            <div className="p-4 md:p-5 flex-1 min-h-0 flex flex-col">

            {events.length === 0 && noDataTickers.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center py-12 text-center bg-slate-50/50 dark:bg-slate-800/30 rounded-2xl border border-slate-100 dark:border-slate-800">
                    <p className="text-sm font-bold text-slate-500">{t('analytics.earnings_calendar.no_earnings')}</p>
                    <p className="text-xs text-slate-400 mt-1.5">{t('analytics.earnings_calendar.global_note')}</p>
                </div>
            ) : (
                <div className="relative flex-1 min-h-[420px]">
                <div className="absolute inset-0 space-y-3 overflow-y-auto overflow-x-hidden pr-2 custom-scrollbar">
                    {events.map((ev, i) => {
                        const days = getDaysUntil(ev.date);
                        const published = ev.epsActual !== null;
                        const beat = published && ev.epsForecast !== null && ev.epsActual > ev.epsForecast;
                        const isExpanded = expandedTicker === ev.ticker;
                        return (
                            <div key={`${ev.ticker}-${i}`}
                                className={`rounded-2xl border transition-colors shadow-xs hover:shadow-md ${getCardStyle(days, published)}`}>

                                {/* Main card row — clickable to expand */}
                                <div
                                    className="p-4 cursor-pointer"
                                    onClick={() => toggleExpand(ev)}
                                >
                                    {/* Row 1: ticker · name · expand · urgency */}
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="flex items-center gap-2 min-w-0">
                                            {isExpanded
                                                ? <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
                                                : <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
                                            }
                                            <span className="text-xs font-black bg-white/50 dark:bg-slate-800/50 text-purple-600 dark:text-purple-400 px-2 py-0.5 rounded-md border border-purple-100/50 dark:border-purple-800/50 shadow-xs shrink-0">{ev.ticker}</span>
                                            <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300 truncate">{ev.name}</span>
                                        </div>
                                        <UrgencyBadge days={days} />
                                    </div>

                                    {/* Row 2: date + countdown + time-of-day + eps forecast */}
                                    <div className="flex items-center justify-between mt-3 bg-white/40 dark:bg-slate-900/40 rounded-xl p-2.5">
                                        <div className="flex items-center gap-3 flex-wrap">
                                            <div className="flex items-center gap-1.5">
                                                <Clock className="w-3.5 h-3.5 text-slate-400" />
                                                <span className="text-xs font-black text-slate-700 dark:text-slate-200">
                                                    {formatDate(ev.date)}
                                                </span>
                                            </div>
                                            <span className="text-[10px] font-bold text-slate-500 bg-slate-200/50 dark:bg-slate-700/50 px-2 py-0.5 rounded-full">{formatCountdown(days)}</span>
                                            <TimeLabel time={ev.time} />
                                        </div>
                                        {ev.epsForecast !== null && !published && (
                                            <div className="text-right shrink-0">
                                                <span className="text-[9px] text-slate-500 uppercase font-black tracking-wider">{t('analytics.earnings_calendar.eps_est')} </span>
                                                <span className="text-xs font-black text-slate-700 dark:text-slate-200">
                                                    {formatEps(ev.epsForecast, uiLocale)}
                                                </span>
                                            </div>
                                        )}
                                    </div>

                                    {/* Row 3: published results */}
                                    {published && (
                                        <div className="mt-3 pt-3 border-t border-slate-200/60 dark:border-slate-700/40 flex items-center justify-between">
                                            <div className={`flex items-center gap-1.5 text-[11px] font-black ${beat ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                                                {beat ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                                                {t('analytics.earnings_calendar.eps_actual', { value: formatEps(ev.epsActual, uiLocale) })}
                                                {ev.epsForecast !== null && (
                                                    <span className="text-slate-500 dark:text-slate-400 font-medium"> / {t('analytics.earnings_calendar.est_short')} {formatEps(ev.epsForecast, uiLocale)}</span>
                                                )}
                                                {ev.surprisePct !== null && (
                                                    <span className={`ml-1 px-1.5 py-0.5 rounded text-[10px] font-black ${beat ? 'bg-emerald-100/50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400' : 'bg-rose-100/50 dark:bg-rose-900/30 text-rose-500 dark:text-rose-400'}`}>
                                                        {formatSurprise(ev.surprisePct, uiLocale)}
                                                    </span>
                                                )}
                                            </div>
                                            {ev.fiscalQuarter && (
                                                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{ev.fiscalQuarter}</span>
                                            )}
                                        </div>
                                    )}
                                </div>

                                {/* Expanded: historical quarterly EPS */}
                                {isExpanded && (
                                    <div className="px-3 pb-3 border-t border-slate-200/60 dark:border-slate-700/40">
                                        {historyLoading[ev.ticker] ? (
                                            <div className="flex items-center justify-center py-3">
                                                <Loader2 className="w-4 h-4 animate-spin text-purple-500" />
                                            </div>
                                        ) : ((detailCache[ev.ticker]?.history || [])).length === 0 ? (
                                            <p className="text-[10px] text-slate-400 italic py-2 text-center">{t('analytics.earnings_calendar.no_history')}</p>
                                        ) : (
                                            <div className="mt-2 space-y-1">
                                                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">{t('analytics.earnings_calendar.quarterly_history')}</p>
                                                {((detailCache[ev.ticker]?.history || [])).map(q => (
                                                    <QuarterHistoryRow key={`${q.date}-${q.upcoming ? 'u' : 'p'}`} q={q} />
                                                ))}
                                            </div>
                                        )}

                                        {/* Análisis IA de la presentación — solo cuando el
                                            historial ya está resuelto: lanzarlo antes gastaría
                                            cuota con un prompt sin trimestres anteriores. */}
                                        {!historyLoading[ev.ticker] && (
                                        <div className="mt-3 pt-3 border-t border-slate-200/60 dark:border-slate-700/40">
                                            <EarningsAiPanel
                                                ai={aiByTicker[ev.ticker]}
                                                loading={!!aiLoading[ev.ticker]}
                                                exhausted={aiExhausted}
                                                dailyLeft={dailyLeft}
                                                published={published}
                                                lang={i18n.language || 'es'}
                                                onAnalyze={() => analyzeEarnings(ev)}
                                                t={t}
                                            />
                                        </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                    {noDataTickers.length > 0 && (
                        <div className="mt-4 pt-4 border-t border-slate-200/60 dark:border-slate-700/50">
                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">{t('analytics.earnings_calendar.no_date')}</p>
                            <div className="flex flex-wrap gap-2">
                                {noDataTickers.map(({ ticker, name }) => (
                                    <div key={ticker} title={name} className="text-[10px] font-bold text-slate-500 bg-slate-100/80 dark:bg-slate-800/80 px-2.5 py-1 rounded-lg border border-slate-200/50 dark:border-slate-700/50 shadow-xs">
                                        {ticker}
                                    </div>
                                ))}
                            </div>
                            <p className="text-[10px] text-slate-400 mt-3 font-medium">{t('analytics.earnings_calendar.global_action')}</p>
                        </div>
                    )}
                </div>
                </div>
            )}
            </div>
        </div>
    );
};

export default EarningsCalendar;
