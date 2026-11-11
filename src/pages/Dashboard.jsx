import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { formatPercent, appLocale } from '@/lib/formatters';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { Helmet } from 'react-helmet';
import {
  DollarSign, TrendingUp, TrendingDown, Loader2, Filter, RefreshCw, Share2, LayoutGrid, ChevronDown, Check, Plus
} from 'lucide-react';
import { supabase } from '@/lib/customSupabaseClient';
import { useSupabaseAuth } from '@/contexts/SupabaseAuthContext';
import { useToast } from '@/components/ui/use-toast';
import PortfolioTreemap from '@/components/PortfolioTreemap';
import ExpandableWidget, { ExpandAware } from '@/components/ExpandableWidget';
import DashboardCustomizer from '@/components/dashboard/DashboardCustomizer';
import {
  resolveDashboardLayout, serializeLayout, DASHBOARD_WIDGETS,
  DASHBOARD_EXPENSE_WIDGETS_ENABLED,
  resolvePairs, applyPairAdjacency, computeRenderGroups, DEFAULT_DASHBOARD_ORDER, layoutForEmptyPortfolio,
} from '@/services/dashboardLayout';
import { useExpensesFeature } from '@/contexts/ExpensesFeatureContext';
import { fetchDashboardExpenseRows } from '@/services/expenses/paginatedFetch';
import { applyDashboardExpenseRowsResult } from '@/services/expenses/expenseFetchResult';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import PortfolioAlertButton from '@/components/PortfolioAlertButton';
import WatchlistTracker from '@/components/WatchlistTracker';
import PortfolioGrowthChart from '@/components/PortfolioGrowthChart';
import { isHeldInvestedPosition } from '@/lib/positionKind';
import EmptyPortfolioHero from '@/components/dashboard/EmptyPortfolioHero';
import { countryFromIsin, countryFromTicker } from '@/lib/listingCountry';
import { useDashboardData } from '@/hooks/useDashboardData';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { getFundExposure, MULTI_CURRENCY } from '@/services/fundExposure';
import { usePrivacyMode } from '@/contexts/PrivacyModeContext';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import OnboardingChecklist from '@/components/OnboardingChecklist';
import PortfolioNewsWidget from '@/components/PortfolioNewsWidget';
import PortfolioScoreWidget from '@/components/PortfolioScoreWidget';

// Analytics Components
import DividendCalendar from '@/components/analytics/DividendCalendar';
import EarningsCalendar from '@/components/analytics/EarningsCalendar';
import SharePortfolioModal from '@/components/SharePortfolioModal';
import { assetDisplayName } from '@/services/assetDisplayName';

const Dashboard = () => {
  const { t } = useTranslation();
  const { user } = useSupabaseAuth();
  const { privacyMode } = usePrivacyMode();
  const navigate = useNavigate();
  const { toast } = useToast();
  // Carga y valoración en vivo: hooks/useDashboardData (la página solo pinta).
  const {
    loading, preferences, currency, brokers, selectedBrokerId, setSelectedBrokerId,
    exchangeRates: exchangeRatesDB, portfolioData, fundSectorWeights, reload: loadDashboardData,
  } = useDashboardData(user);
  const { savePreferences } = useUserPreferences();
  const { expensesEnabled } = useExpensesFeature();
  const showExpenseWidgets = expensesEnabled && DASHBOARD_EXPENSE_WIDGETS_ENABLED;
  const [expenseRows, setExpenseRows] = useState([]);
  const fetchExpenseRows = useCallback(async () => {
    if (!showExpenseWidgets || !user?.id) { setExpenseRows([]); return; }
    // expense_entries — paginado (fetchDashboardExpenseRows / fetchAllRows)
    const result = await fetchDashboardExpenseRows(supabase, user.id);
    applyDashboardExpenseRowsResult(result, { setExpenseRows, toast, t });
  }, [showExpenseWidgets, user?.id, toast, t]);
  useEffect(() => { fetchExpenseRows(); }, [fetchExpenseRows]);
  void expenseRows;

  const [savedWidgets, setSavedWidgets] = useState(null);
  const [isCustomizerOpen, setIsCustomizerOpen] = useState(false);
  const widgetRegistry = useMemo(() => DASHBOARD_WIDGETS, []);
  const widgetLayoutBase = useMemo(
    () => resolveDashboardLayout(savedWidgets, widgetRegistry, DEFAULT_DASHBOARD_ORDER),
    [savedWidgets, widgetRegistry],
  );
  // Explicit pairs (mitad y mitad): two half-widgets sharing one cell. Pair
  // members are kept adjacent in the layout so the customizer shows them joined.
  const widgetPairs = useMemo(
    () => resolvePairs(savedWidgets, widgetLayoutBase),
    [savedWidgets, widgetLayoutBase],
  );
  const widgetLayout = useMemo(
    () => applyPairAdjacency(widgetLayoutBase, widgetPairs),
    [widgetLayoutBase, widgetPairs],
  );
  // Cuenta sin posiciones (en la vista general): en vez de 8 tarjetas vacías,
  // la tarjeta de bienvenida y solo los widgets que funcionan sin cartera. Es
  // el layout que se PINTA; el personalizador sigue editando el guardado.
  const isEmptyPortfolio = selectedBrokerId === 'general'
    && !portfolioData.positions.some(isHeldInvestedPosition)
    && !(portfolioData.cashPosition > 0);
  const shownLayout = useMemo(
    () => (isEmptyPortfolio ? layoutForEmptyPortfolio(widgetLayout) : widgetLayout),
    [isEmptyPortfolio, widgetLayout],
  );
  const widgetGroups = useMemo(
    () => computeRenderGroups(shownLayout, widgetPairs),
    [shownLayout, widgetPairs],
  );

  const [portfolioPerformance, setPortfolioPerformance] = useState([]);

  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [donutTab, setDonutTab] = useState(0);
  // Hovered slice index (chart or legend) — drives the center label + slice dimming
  const [donutHover, setDonutHover] = useState(null);
  // DOM-level gate for the donut tooltip: Recharts' internal active flag can get
  // stuck on fast mouse exits (its SVG mousemove-based deactivation misses events),
  // so the tooltip only renders while the pointer is really inside the chart box
  const [isPointerOverDonut, setIsPointerOverDonut] = useState(false);
  // El layout de widgets guardado llega con las preferencias que lee el hook.
  useEffect(() => {
    if (preferences) setSavedWidgets(preferences.dashboard_widgets ?? null);
  }, [preferences]);

  // Widget layout helpers: `order` drives the CSS order inside the grid, so
  // reordering never moves JSX around. Persisted fire-and-forget.
  const widgetOrder = (id) => {
    const i = widgetLayout.findIndex((w) => w.id === id);
    return i === -1 ? 99 : i;
  };
  const isWidgetVisible = (id) => shownLayout.find((w) => w.id === id)?.visible !== false;

  const saveWidgets = async (config) => {
    setSavedWidgets(config);
    if (!user?.id) return;
    const { error } = await savePreferences({ dashboard_widgets: config });
    if (error) console.warn('[dashboard] could not save widget layout:', error.message);
  };
  const persistWidgetLayout = (nextLayout, nextPairs) =>
    saveWidgets(serializeLayout(nextLayout, nextPairs ?? widgetPairs));
  const resetWidgetLayout = () => saveWidgets(null);

  const HIDDEN = '••••';

  // Porcentajes de TU cartera (variación total, % invertido, reparto): privacidad
  // los oculta igual que los importes — un "46 %" de una porción filtra el mismo
  // reparto (regla de Gastos, docs/claude/expenses.md). La variación de un activo
  // en el mercado es pública y se sigue viendo.
  const formatShare = (value, decimals, options) => (privacyMode ? HIDDEN : formatPercent(value, decimals, options));

  const formatCurrency = (amount) => {
    if (privacyMode) return HIDDEN;
    return new Intl.NumberFormat(appLocale(), {
      style: 'currency',
      currency: currency,
      useGrouping: true,
      maximumFractionDigits: 0
    }).format(amount);
  };

  // Skeleton screen instead of a spinner: mirrors the real layout so the page
  // doesn't "jump" when data lands, and perceived latency drops (users tolerate
  // structure-shaped placeholders far better than a centered spinner).
  if (loading) return (
    <div className="space-y-6 pt-3 animate-pulse" aria-busy="true">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="h-72 rounded-2xl bg-linear-to-br from-blue-600/40 to-indigo-700/40 dark:from-blue-900/40 dark:to-indigo-900/40" />
        {[1, 2, 3].map(i => (
          <div key={i} className="h-72 rounded-2xl bg-slate-200/70 dark:bg-slate-800/70" />
        ))}
      </div>
      <div className="h-[420px] rounded-2xl bg-slate-200/70 dark:bg-slate-800/70" />
      <div className="h-64 rounded-2xl bg-slate-200/70 dark:bg-slate-800/70" />
    </div>
  );

  // NOTE: the chart no longer receives a "live ROI" override for its last point —
  // when the live value disagreed with the chart's own series (e.g. an incomplete
  // live cost basis), it drew a vertical cliff that crushed the scale.

  // Shared entrance variant for Row-1 widgets (staggered by the parent grid)
  const fadeUp = {
    hidden: { opacity: 0, y: 10 },
    show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: 'easeOut' } },
  };

  // pt-9 y no pt-3: el primer hijo es la barra de acciones (fixed). En Tailwind 3,
  // space-y-6 daba margen arriba al SEGUNDO hijo y ese hueco de 24 px existía
  // aunque la barra no ocupe sitio; en v4 el margen va abajo del primero y se
  // perdía. Se mantiene explícito para conservar el diseño.
  return (
    <div className="relative space-y-6 pt-9">
      <Helmet><title>Dashboard — Trazza</title></Helmet>
      
      {/* ── Dashboard Toolbar (Floating) ── */}
      <div className="fixed top-[72px] right-4 lg:right-6 z-60 flex items-center gap-2">
        {/* Broker selector — Radix dropdown (native <select> broke the Ledger look) */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-2 bg-white/95 dark:bg-slate-800/95 backdrop-blur-md border border-slate-200 dark:border-slate-700 rounded-full pl-3 pr-2.5 py-2 shadow-xs shadow-slate-900/5 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors">
              <Filter className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <span className="text-xs font-bold text-slate-700 dark:text-slate-200 max-w-[130px] truncate">
                {selectedBrokerId === 'general' ? t('dashboard.all_brokers') : (brokers.find(b => b.id === selectedBrokerId)?.name || t('dashboard.all_brokers'))}
              </span>
              <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {[{ id: 'general', name: t('dashboard.all_brokers') }, ...brokers].map((b) => (
              <DropdownMenuItem
                key={b.id}
                onClick={() => setSelectedBrokerId(b.id)}
                className={`gap-2 cursor-pointer text-sm ${selectedBrokerId === b.id ? 'font-bold text-blue-600 dark:text-blue-400' : ''}`}
              >
                <Check className={`w-3.5 h-3.5 shrink-0 ${selectedBrokerId === b.id ? 'opacity-100' : 'opacity-0'}`} />
                <span className="truncate">{b.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          onClick={loadDashboardData}
          disabled={loading}
          className="flex items-center gap-1.5 bg-white/95 dark:bg-slate-800/95 backdrop-blur-md border border-slate-200 dark:border-slate-700 rounded-full px-3 py-2 shadow-xs shadow-slate-900/5 text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span className="hidden sm:inline">{t('dashboard.refresh')}</span>
        </button>

        <button
          onClick={() => setIsCustomizerOpen(true)}
          className="flex items-center gap-1.5 bg-white/95 dark:bg-slate-800/95 backdrop-blur-md border border-slate-200 dark:border-slate-700 rounded-full px-3 py-2 shadow-xs shadow-slate-900/5 text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
          title={t('dashboard.customize_title')}
        >
          <LayoutGrid className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">{t('dashboard.customize_button')}</span>
        </button>

        {/* Portfolio price alert — scoped to the selected broker (or all brokers) */}
        <PortfolioAlertButton
          scope={selectedBrokerId}
          scopeLabel={selectedBrokerId === 'general'
            ? t('dashboard.all_brokers')
            : (brokers.find(b => b.id === selectedBrokerId)?.name || t('dashboard.all_brokers'))}
        />

        {/* Share = the outward CTA — accent color separates it from utility buttons */}
        <button
          onClick={() => setShareModalOpen(true)}
          className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 rounded-full px-3 py-2 shadow-lg shadow-blue-500/25 text-xs font-bold text-white transition-colors"
        >
          <Share2 className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">{t('share.button')}</span>
        </button>
      </div>

      {/* performanceData y dashboardMetrics están filtrados por selectedBrokerId;
          se pasa como metricsScope para que el modal no cuelgue la curva de un
          broker suelto de un share que cubre toda la cartera. */}
      <SharePortfolioModal
        open={shareModalOpen}
        onClose={() => setShareModalOpen(false)}
        positions={portfolioData.positions}
        brokers={brokers}
        exchangeRates={exchangeRatesDB}
        performanceData={portfolioPerformance}
        metricsScope={selectedBrokerId}
        dashboardMetrics={{
          marketValue:        portfolioData.totalWealth - portfolioData.cashPosition,
          openInvested:       portfolioData.totalInvested,
          unrealizedPnl:      (portfolioData.totalWealth - portfolioData.cashPosition) - portfolioData.totalInvested,
          realizedPnl:        portfolioData.realizedGain,
          dividends:          portfolioData.totalDividends,
          fees:               portfolioData.totalFees,
          totalBuyCost:       portfolioData.totalBuyCost,
          portfolioStartDate: portfolioData.portfolioStartDate,
          roiSimple:          portfolioData.totalGainPct,
        }}
      />

      {/* ── Onboarding checklist (hidden once completed) ──
          Con la cartera vacía manda EmptyPortfolioHero: las dos a la vez eran
          dos guías compitiendo por el primer paso. La lista aparece cuando ya
          hay cartera, con lo que queda (preferencias, explorar). */}
      {!isEmptyPortfolio && (
        <OnboardingChecklist
          hasPositions={portfolioData.positions.some(p => p.quantity > 0.0001)}
          hasWealth={portfolioData.totalWealth > 0}
        />
      )}

      <DashboardCustomizer
        open={isCustomizerOpen}
        onOpenChange={setIsCustomizerOpen}
        layout={widgetLayout}
        pairs={widgetPairs}
        onChange={persistWidgetLayout}
        onReset={resetWidgetLayout}
      />

      {/* ── Widget grid — order/visibility come from widgetLayout ── */}
      {/* Retícula uniforme: dense rellena los huecos que deja ocultar/reordenar
          (los spans de una fila pueden no sumar 3), el suelo de fila evita
          widgets enanos, y cada celda estira su card (h-full) para que los
          bordes de una misma fila queden SIEMPRE alineados. */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6 items-stretch grid-flow-row-dense lg:auto-rows-[minmax(280px,auto)]">

      {isEmptyPortfolio && <EmptyPortfolioHero />}

      {/* ── Widgets emparejables (mitad y mitad) ──
          invested / allocation / score / watchlist / dividends / earnings /
          exp_summary se renderizan por GRUPOS (widgetGroups): una pareja
          enlazada comparte UNA celda apilada en vertical; un widget suelto
          ocupa su celda completa. Enlazar/separar vive en el personalizador. */}
      {(() => {
        const renderInvested = () => {
          // "N pos." cuenta SOLO activos invertidos: la liquidez no es una posición.
          // Misma función que usa la valoración (lib/positionKind) — cuando el conteo
          // se re-filtraba aquí a mano, una fila de liquidez con `asset_class` en otra
          // caja ('cash'/'CASH') se colaba en el número aunque el reparto
          // Invertido/Cash sí la tratara como efectivo.
          const nPositions = portfolioData.positions.filter(isHeldInvestedPosition).length;
          const investedPct = portfolioData.totalWealth > 0
            ? ((portfolioData.totalWealth - portfolioData.cashPosition) / portfolioData.totalWealth * 100)
            : 0;
          const liveInvested = portfolioData.totalWealth - portfolioData.cashPosition;
          const roiActual = portfolioData.totalInvested > 0
            ? (liveInvested - portfolioData.totalInvested) / portfolioData.totalInvested * 100
            : 0;
          // El % del día solo dice cuánto se movió; el importe dice CUÁNTO dinero
          // es, que es la pregunta que se hace de verdad al mirar la cifra grande.
          const dailyAbs = portfolioData.dailyChangeAbs;
          const dailyAbsLabel = privacyMode
            ? formatCurrency(dailyAbs)
            : `${dailyAbs > 0 ? '+' : ''}${formatCurrency(dailyAbs)}`;
          return (
            <div className="relative overflow-hidden bg-blue-600 rounded-2xl p-4 shadow-lg shadow-blue-500/20 h-full">
              <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.12),transparent)] pointer-events-none" />
              <div className="relative">
                {/* Header */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <div className="p-1.5 bg-white/20 rounded-lg"><DollarSign className="w-4 h-4 text-white" /></div>
                    <span className="text-xs font-semibold text-blue-100 uppercase tracking-widest">{t('dashboard.invested')}</span>
                  </div>
                  <span className="text-[10px] font-bold text-blue-200 bg-white/10 px-2 py-0.5 rounded-full">{nPositions} {t('dashboard.positions')}</span>
                </div>
                {/* Main value + key metrics side by side */}
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="font-ledger text-3xl font-bold text-white tabular-nums tracking-tight">{formatCurrency(liveInvested)}</div>
                    {portfolioData.dailyChangePct !== 0 && (
                      <div className={`mt-1.5 inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full ${portfolioData.dailyChangePct >= 0 ? 'bg-emerald-400/20 text-emerald-200' : 'bg-rose-400/20 text-rose-200'}`}>
                        {portfolioData.dailyChangePct >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                        {formatShare(portfolioData.dailyChangePct, 2, { sign: true })}
                        <span className="opacity-60">·</span>
                        {dailyAbsLabel} {t('dashboard.today')}
                      </div>
                    )}
                  </div>
                  {/* Portfolio Value · Cash · % Invertido — en fila, a la derecha del valor INVERTIDO */}
                  <div className="flex items-start gap-x-4 gap-y-2 flex-wrap shrink-0">
                    <div>
                      <p className="text-[10px] text-blue-200 uppercase tracking-wider whitespace-nowrap">{t('dashboard.portfolio_value')}</p>
                      <p className="font-ledger text-sm font-bold text-white tabular-nums">{formatCurrency(portfolioData.totalWealth)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-blue-200 uppercase tracking-wider whitespace-nowrap">{t('dashboard.cash')}</p>
                      <p className="font-ledger text-sm font-bold text-white tabular-nums">{formatCurrency(portfolioData.cashPosition)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-blue-200 uppercase tracking-wider whitespace-nowrap">{t('dashboard.invested_pct')}</p>
                      <p className="font-ledger text-sm font-bold text-white tabular-nums">{formatShare(investedPct, 1)}</p>
                    </div>
                  </div>
                </div>

                {/* La sección Profit/Loss (selector Hoy/Mes/Año + % del periodo) se
                    retiró el 2026-09-11: el dato del día ya está arriba, junto al
                    valor, y la tarjeta era más alta de lo necesario — en una pareja
                    el de arriba mide su contenido, así que cada píxel que sobra aquí
                    se lo lleva el widget de abajo. Los "day movers" NO se tocaron:
                    vivían dentro de aquella sección y ahora tienen la suya, que solo
                    existe cuando hay filas que enseñar (si no, quedaría un separador
                    suelto con el mercado cerrado). */}
                {/* Day movers — only when market is open */}
                  {/* Day movers — only when market is open */}
                  {portfolioData.isMarketOpen && (() => {
                    const valid = (portfolioData.treemapData || []).filter(d =>
                      d.marketState === 'REGULAR' && typeof d.change === 'number' && Number.isFinite(d.change)
                    );
                    const gainers = [...valid].filter(d => d.change >= 0).sort((a, b) => b.change - a.change).slice(0, 2);
                    const losers  = [...valid].filter(d => d.change <  0).sort((a, b) => a.change - b.change).slice(0, 2);
                    const rows = [...gainers, ...losers];
                    if (!rows.length) return null;
                    return (
                      <div className="mt-2.5 pt-2.5 border-t border-white/15">
                        <span className="text-[9px] font-bold text-blue-300 uppercase tracking-wider">{t('dashboard.day_movers')}</span>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {rows.map(d => (
                            <div
                              key={d.ticker}
                              className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md ${
                                d.change >= 0 ? 'bg-emerald-400/15' : 'bg-rose-400/15'
                              }`}
                            >
                              <span className="font-mono font-bold text-[10px] text-blue-100">{d.ticker}</span>
                              <span className={`text-[10px] font-bold tabular-nums ${d.change >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                                {formatPercent(d.change, 2, { sign: true })}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
              </div>
            </div>
          );
        };

        const renderAllocation = () => {
          const DONUT_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#475569'];
          const investedAssets = portfolioData.positions.filter(isHeldInvestedPosition);
          const totalVal = investedAssets.reduce((s, p) => {
            const cur = p.assets?.currency || 'USD';
            const rate = cur === currency ? 1 : (exchangeRatesDB[cur] || 1);
            return s + parseFloat(p.quantity) * parseFloat(p.assets?.current_price ?? p.entry_price ?? 0) * rate;
          }, 0);
          // keyFn returns a string (whole position → one slice) OR an array of
          // { key, weight } portions (fund look-through: value split across
          // its real sector weights).
          const toSlices = (res) => (Array.isArray(res) ? res : [{ key: res, weight: 1 }]);
          const buildDonut = (keyFn) => {
            const map = {};
            investedAssets.forEach(p => {
              const res = keyFn(p);
              if (!res) return;
              const cur = p.assets?.currency || 'USD';
              const rate = cur === currency ? 1 : (exchangeRatesDB[cur] || 1);
              const val = parseFloat(p.quantity) * parseFloat(p.assets?.current_price ?? p.entry_price ?? 0) * rate;
              if (val <= 0.01) return;
              toSlices(res).forEach(({ key, weight }) => {
                if (key && weight > 0) map[key] = (map[key] || 0) + val * weight;
              });
            });
            return Object.entries(map).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
          };
          // Etiquetas traducidas (antes eran literales en español y la app en
          // inglés enseñaba "Norteamérica", "Criptomoneda"…). Los fondos usan las
          // MISMAS etiquetas para que sus porciones se fundan con las de acciones.
          const NA = t('dashboard.region_north_america'), EU = t('dashboard.region_europe'),
                APAC = t('dashboard.region_asia_pacific'), LATAM = t('dashboard.region_latam'),
                ME = t('dashboard.region_middle_east');
          const REGION_MAP = {
            // Alias: Yahoo dice "United States", pero hay activos guardados como
            // "USA"/"US" (la demo entera) y salían como una porción "USA" aparte de
            // "Norteamérica". Lo mismo con "Europe" y "UK".
            'United States':NA,'United States of America':NA,'USA':NA,'US':NA,'Canada':NA,'Mexico':NA,
            'Europe':EU,'UK':EU,
            'United Kingdom':EU,'Germany':EU,'France':EU,'Spain':EU,'Italy':EU,
            'Netherlands':EU,'Switzerland':EU,'Sweden':EU,'Norway':EU,'Denmark':EU,
            'Finland':EU,'Belgium':EU,'Ireland':EU,
            'Japan':APAC,'China':APAC,'South Korea':APAC,
            'Australia':APAC,'India':APAC,'Hong Kong':APAC,
            'Taiwan':APAC,'Singapore':APAC,
            'Brazil':LATAM,'Argentina':LATAM,'Chile':LATAM,
            'Saudi Arabia':ME,'UAE':ME,'Israel':ME,
          };
          // Los 11 sectores de Yahoo llegan en inglés: se traducen al pintar.
          const SECTOR_SLUG = {
            'Technology': 'technology', 'Financial Services': 'financial_services',
            'Consumer Cyclical': 'consumer_cyclical', 'Consumer Defensive': 'consumer_defensive',
            'Communication Services': 'communication_services', 'Industrials': 'industrials',
            'Healthcare': 'healthcare', 'Energy': 'energy', 'Basic Materials': 'basic_materials',
            'Utilities': 'utilities', 'Real Estate': 'real_estate',
          };
          const sectorLabel = (s) => (SECTOR_SLUG[s] ? t(`sector_names.${SECTOR_SLUG[s]}`) : s);
          const CRYPTO_LABEL = t('dashboard.region_crypto');
          const isCryptoAsset = (p) => {
            // Ticker format BTC-USD / ETH-EUR is unambiguously crypto — check first
            // so existing DB rows with wrong asset_class='Stock' still resolve correctly
            const ticker = p.assets?.ticker || '';
            if (/^[A-Z0-9]+-[A-Z]{3}$/.test(ticker)) return true;
            const cls = (p.assets?.asset_class || '').toLowerCase();
            return cls === 'crypto' || cls === 'cryptocurrency';
          };
          const buildCompanyMap = (keyFn) => {
            const map = {};
            investedAssets.forEach(p => {
              const res = keyFn(p);
              if (!res) return;
              const name = assetDisplayName(p.assets);
              if (!name) return;
              toSlices(res).forEach(({ key, weight }) => {
                if (!key || !(weight > 0)) return;
                if (!map[key]) map[key] = [];
                if (!map[key].includes(name)) map[key].push(name);
              });
            });
            return map;
          };
          // Index funds: classify by the UNDERLYING index exposure (fundExposure
          // look-through), never by share class (EUR) or legal domicile (IE/LU).
          // Region labels for shared buckets must match REGION_MAP values so
          // fund slices merge with stock-derived slices.
          const EXPOSURE_REGION_LABEL = {
            NORTH_AMERICA: NA, EUROPE: EU, ASIA_PACIFIC: APAC,
            EMERGING: t('dashboard.region_emerging'), GLOBAL: t('dashboard.region_global'),
          };
          const EXPOSURE_SECTOR_LABEL = {
            FUND_EQUITY: t('dashboard.sector_fund_equity'),
            FUND_BOND_GOVT: t('dashboard.sector_fund_bond_govt'),
            FUND_BOND_CORP: t('dashboard.sector_fund_bond_corp'),
            FUND_BOND: t('dashboard.sector_fund_bond'),
          };
          const divisaKey = (p) => {
            if (isCryptoAsset(p)) return t('dashboard.currency_crypto');
            const exposure = getFundExposure(p.assets);
            if (exposure) {
              return exposure.currency === MULTI_CURRENCY ? t('dashboard.currency_multi') : exposure.currency;
            }
            return p.assets?.currency || null;
          };
          const sectorKey = (p) => {
            if (isCryptoAsset(p)) return CRYPTO_LABEL;
            // Yahoo's real sector wins when it exists; funds have none in DB
            if (p.assets?.sector) return sectorLabel(p.assets.sector);
            // Fund look-through: split the position across its REAL sector
            // weights (topHoldings) when available…
            const weights = fundSectorWeights[p.assets?.ticker];
            if (weights) return weights.map(w => ({ key: sectorLabel(w.sector), weight: w.weight }));
            // …otherwise the single asset-class bucket from the name/ISIN rules
            const exposure = getFundExposure(p.assets);
            return exposure ? EXPOSURE_SECTOR_LABEL[exposure.sector] : null;
          };
          const regionKey = (p) => {
            if (isCryptoAsset(p)) return t('dashboard.region_crypto');
            const exposure = getFundExposure(p.assets);
            if (exposure) return EXPOSURE_REGION_LABEL[exposure.region];
            // Priority: DB country → ISIN prefix (most reliable) → ticker suffix
            let country = (p.assets?.country && p.assets.country !== 'Global') ? p.assets.country : null;
            if (!country) country = countryFromIsin(p.assets?.isin);
            if (!country) country = countryFromTicker(p.assets?.ticker || '');
            if (!country || country === 'Global') return t('dashboard.region_other');
            return REGION_MAP[country] || country;
          };
          const industriaKey = (p) => {
            if (isCryptoAsset(p)) return CRYPTO_LABEL;
            return p.assets?.industry || null;
          };
          const sectorCompaniesMap = buildCompanyMap(sectorKey);
          const divisaCompaniesMap = buildCompanyMap(divisaKey);
          const regionCompaniesMap = buildCompanyMap(regionKey);
          const industriaCompaniesMap = buildCompanyMap(industriaKey);
          // Positions keep the top-8 cap inline (tiny chart), but the expanded
          // popup shows the FULL list — fullData feeds both chart and legend there.
          const positionsData = buildDonut(p => assetDisplayName(p.assets));
          const allTabs = [
            { id: 'divisa',     label: t('dashboard.tab_currency'),   data: buildDonut(divisaKey) },
            { id: 'posiciones', label: t('dashboard.tab_positions'),  data: positionsData.slice(0, 8), fullData: positionsData },
            { id: 'sectores',   label: t('dashboard.tab_sectors'),    data: buildDonut(sectorKey) },
            { id: 'regiones',   label: t('dashboard.tab_regions'),    data: buildDonut(regionKey) },
            { id: 'industrias', label: t('dashboard.tab_industries'), data: buildDonut(industriaKey) },
          ].filter(t => t.data && t.data.length > 0);
          if (allTabs.length === 0) return null;
          const safeTab = Math.min(donutTab, allTabs.length - 1);
          const active = allTabs[safeTab];
          const donutDataFor = (expanded) => (expanded && active.fullData ? active.fullData : active.data);

          const LEGEND_MAX = 5;
          const hiddenItems = active.data.slice(LEGEND_MAX);
          const hiddenPct = totalVal > 0
            ? hiddenItems.reduce((s, d) => s + d.value, 0) / totalVal * 100
            : 0;

          return (
            <ExpandableWidget title={t('dashboard.distribution')}>
            <div className="bg-white dark:bg-slate-800/80 border border-slate-200/80 dark:border-slate-700/40 rounded-2xl shadow-xs overflow-hidden flex flex-col h-full">
              {/* Tabs */}
              <div className="flex items-center gap-1 px-3 pt-3 overflow-x-auto no-scrollbar shrink-0">
                {allTabs.map((tab, idx) => (
                  <button
                    key={tab.id}
                    onClick={() => { setDonutTab(idx); setDonutHover(null); }}
                    className={`px-2.5 py-1 rounded-lg text-[10px] font-bold whitespace-nowrap transition-all ${
                      safeTab === idx
                        ? 'bg-blue-600 text-white shadow-xs'
                        : 'text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700/50'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              {/* Donut — thinner ring + live center label (grows when the widget is expanded) */}
              <ExpandAware>
                {(expanded) => {
                const chartData = donutDataFor(expanded);
                // Center label: hovered slice wins; otherwise the dominant category.
                // The donut hole is the widget's prime visual real estate — never empty.
                const centerIdx = donutHover != null && donutHover < chartData.length ? donutHover : 0;
                const centerItem = chartData[centerIdx];
                const centerPct = totalVal > 0 && centerItem ? (centerItem.value / totalVal * 100) : 0;
                return (
                <div
                  className="relative shrink-0 px-2"
                  style={{ height: expanded ? 480 : 170 }}
                  onMouseEnter={() => setIsPointerOverDonut(true)}
                  onMouseLeave={() => { setIsPointerOverDonut(false); setDonutHover(null); }}
                >
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={chartData}
                      innerRadius="58%" outerRadius="82%"
                      paddingAngle={2.5} dataKey="value" labelLine={false}
                      animationBegin={0} animationDuration={400}
                      onMouseEnter={(_, i) => setDonutHover(i)}
                      onMouseLeave={() => setDonutHover(null)}
                    >
                      {chartData.map((_, i) => (
                        <Cell
                          key={i}
                          fill={DONUT_COLORS[i % DONUT_COLORS.length]}
                          fillOpacity={donutHover != null && donutHover !== i ? 0.3 : 1}
                          stroke="rgba(255,255,255,0.08)" strokeWidth={1}
                          style={{ transition: 'fill-opacity 200ms ease', outline: 'none' }}
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      // El tooltip se pinta ANTES que la etiqueta central en el
                      // DOM, así que sin z-index el % del centro del quesito lo
                      // tapaba justo donde se listan los activos de la porción.
                      wrapperStyle={{ zIndex: 40, pointerEvents: 'none' }}
                      content={(props) => {
                        if (!props.active || !props.payload?.length || !isPointerOverDonut) return null;
                        const entry = props.payload[0];
                        const pct = formatShare(totalVal > 0 ? entry.value / totalVal * 100 : 0, 1);
                        const companiesMap = { sectores: sectorCompaniesMap, divisa: divisaCompaniesMap, regiones: regionCompaniesMap, industrias: industriaCompaniesMap };
                        const companies = (companiesMap[active.id] || {})[entry.name] || [];
                        return (
                          <div style={{ borderRadius: 10, backgroundColor: '#1e293b', color: '#f1f5f9', fontSize: 11, padding: '8px 12px', maxWidth: 200, boxShadow: '0 8px 24px rgba(0,0,0,0.35)' }}>
                            <div style={{ fontWeight: 700, marginBottom: companies.length ? 4 : 0 }}>{entry.name}</div>
                            <div style={{ color: '#93c5fd', fontWeight: 700, marginBottom: companies.length ? 6 : 0 }}>{pct}</div>
                            {companies.map(c => (
                              <div key={c} style={{ color: '#94a3b8', fontSize: 10, paddingLeft: 4 }}>· {c}</div>
                            ))}
                          </div>
                        );
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
                {/* Center label — hovered slice, or the dominant one by default.
                    The inner box is capped at the donut hole's real diameter (~90px
                    with innerRadius 58% on a 170px chart) so long names truncate
                    inside the hole instead of overflowing onto the ring. */}
                {centerItem && (
                  <div className="absolute inset-0 z-0 flex items-center justify-center pointer-events-none">
                    <div className={`${expanded ? 'w-[260px]' : 'w-[84px]'} flex flex-col items-center text-center`}>
                      <span className={`font-ledger ${expanded ? 'text-5xl' : 'text-lg'} font-extrabold tabular-nums leading-none text-slate-900 dark:text-white`}>
                        {formatShare(centerPct, 1)}
                      </span>
                      <span className={`mt-1 w-full ${expanded ? 'text-sm' : 'text-[9px]'} font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wide truncate`}>
                        {centerItem.name}
                      </span>
                    </div>
                  </div>
                )}
                </div>
                );
                }}
              </ExpandAware>
              {/* Legend — neutral % (color lives only in the dot), hover syncs the donut.
                  Expanded: every asset is listed (multi-column), no "+N more" bucket. */}
              <ExpandAware>
                {(expanded) => (
              <div className={`flex-1 px-3 pb-3 grid gap-y-1 ${expanded ? 'grid-cols-2 md:grid-cols-3 gap-x-8 content-start overflow-y-auto' : 'grid-cols-1 overflow-hidden'}`}>
                {(expanded ? donutDataFor(true) : active.data.slice(0, LEGEND_MAX)).map((d, i) => {
                  const pct = totalVal > 0 ? (d.value / totalVal * 100) : 0;
                  const color = DONUT_COLORS[i % DONUT_COLORS.length];
                  const dimmed = donutHover != null && donutHover !== i;
                  return (
                    <div
                      key={d.name}
                      onMouseEnter={() => setDonutHover(i)}
                      onMouseLeave={() => setDonutHover(null)}
                      className={`flex items-center gap-2 min-w-0 px-1.5 py-0.5 -mx-1.5 rounded-lg cursor-default transition-all duration-200 ${
                        dimmed ? 'opacity-40' : ''
                      } ${donutHover === i ? 'bg-slate-50 dark:bg-slate-700/40' : ''}`}
                    >
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
                      <span className="text-[11px] text-slate-600 dark:text-slate-300 truncate flex-1 font-medium">{d.name}</span>
                      <span className="text-xs font-extrabold tabular-nums shrink-0 text-slate-900 dark:text-white">{formatShare(pct, 1)}</span>
                    </div>
                  );
                })}
                {!expanded && hiddenItems.length > 0 && (
                  <div className="flex items-center gap-2 min-w-0 px-1.5 -mx-1.5">
                    <span className="w-2 h-2 rounded-full shrink-0 bg-slate-300 dark:bg-slate-600" />
                    <span className="text-[11px] text-slate-400 dark:text-slate-500 truncate flex-1 font-medium">
                      +{hiddenItems.length} {t('dashboard.donut_others')}
                    </span>
                    <span className="text-xs font-bold tabular-nums shrink-0 text-slate-400 dark:text-slate-500">{formatShare(hiddenPct, 1)}</span>
                  </div>
                )}
              </div>
                )}
              </ExpandAware>
            </div>
            </ExpandableWidget>
          );
        };

        // Contenido interno de cada widget emparejable (la celda la pone el map)
        const renderHalfWidget = (id) => {
          switch (id) {
            case 'invested':
              return renderInvested();
            case 'allocation':
              return renderAllocation();
            case 'score':
              return (
                <ErrorBoundary title={t('dashboard.error_portfolio_score')}>
                  <ExpandableWidget title={t('portfolio_score.title')}>
                    <PortfolioScoreWidget
                      positions={portfolioData.positions}
                      brokers={selectedBrokerId === 'general' ? brokers : brokers.filter(b => b.id === selectedBrokerId)}
                      totalWealth={portfolioData.totalWealth}
                      totalInvested={portfolioData.totalInvested}
                      totalBuyCost={portfolioData.totalBuyCost}
                      cashPosition={portfolioData.cashPosition}
                      totalDividends={portfolioData.totalDividends}
                      totalFees={portfolioData.totalFees}
                      totalGainPct={portfolioData.totalGainPct}
                      portfolioStartDate={portfolioData.portfolioStartDate}
                      exchangeRates={exchangeRatesDB}
                      currency={currency}
                    />
                  </ExpandableWidget>
                </ErrorBoundary>
              );
            case 'watchlist':
              return (
                <ErrorBoundary title={t('dashboard.error_favorites')}>
                  <ExpandableWidget title={t('watchlist_tracker.title')}>
                    <WatchlistTracker userId={user?.id} />
                  </ExpandableWidget>
                </ErrorBoundary>
              );
            case 'dividends':
              return (
                <ErrorBoundary title={t('dashboard.error_dividend_calendar')}>
                  <ExpandableWidget title={t('analytics.dividend_calendar.title')}>
                    <DividendCalendar positions={portfolioData.positions} currency={currency} exchangeRates={exchangeRatesDB} />
                  </ExpandableWidget>
                </ErrorBoundary>
              );
            case 'earnings':
              return (
                <ErrorBoundary title={t('dashboard.error_earnings_calendar')}>
                  <ExpandableWidget title={t('analytics.earnings_calendar.title')}>
                    <EarningsCalendar positions={portfolioData.positions} />
                  </ExpandableWidget>
                </ErrorBoundary>
              );
            default:
              return null;
          }
        };

        const pairableIds = new Set(widgetRegistry.filter((w) => w.half).map((w) => w.id));
        return widgetGroups
          .filter((g) => pairableIds.has(g.ids[0]))
          .map((g) => (g.ids.length === 2 ? (
            <motion.div
              key={g.ids.join('-')}
              variants={fadeUp}
              className="flex flex-col gap-4 lg:gap-6"
              style={{ order: g.order }}
            >
              {/* El de ARRIBA mide su contenido (flex-initial) y el de ABAJO
                  absorbe el sobrante de la celda: partir la celda en dos
                  mitades exactas dejaba a la card corta con una banda vacía
                  debajo. La celda sigue estirando, así que los bordes de la
                  fila siguen alineados. */}
              <div className="flex-initial min-h-0 *:h-full">{renderHalfWidget(g.ids[0])}</div>
              <div className="flex-1 min-h-0 *:h-full">{renderHalfWidget(g.ids[1])}</div>
            </motion.div>
          ) : (
            <motion.div
              key={g.ids[0]}
              variants={fadeUp}
              className="*:h-full"
              style={{ order: g.order }}
            >
              {renderHalfWidget(g.ids[0])}
            </motion.div>
          )));
      })()}

      {/* ── Rendimiento de Cartera ── */}
      {isWidgetVisible('growth') && (
      <div className="lg:col-span-2 [&>div]:h-full" style={{ order: widgetOrder('growth') }}>
        <ErrorBoundary title={t('dashboard.error_growth_chart')}>
          <ExpandableWidget title={t('portfolio_growth.title')}>
          <PortfolioGrowthChart
            currency={currency}
            brokerId={selectedBrokerId}
            onPerformanceCalculated={setPortfolioPerformance}
            totalReturnPct={portfolioData?.totalGainPct}
            breakdownStats={{
              capitalInvertido: portfolioData.totalInvested,
              gananciaPrecio: portfolioData.totalGainAbs - portfolioData.realizedGain - portfolioData.totalDividends + portfolioData.totalFees,
              dividendos: portfolioData.totalDividends,
              gananciaRealizada: portfolioData.realizedGain,
              costosTransaccion: portfolioData.totalFees,
              impuestos: 0,
              retornoTotal: portfolioData.totalGainAbs,
              liveInvested: portfolioData.totalWealth - portfolioData.cashPosition
            }}
          />
          </ExpandableWidget>
        </ErrorBoundary>
      </div>
      )}

      {/* Puntuación de cartera */}
      {/* ── WalletMap ── */}
      {isWidgetVisible('treemap') && (
      <div className="lg:col-span-2 [&>div]:h-full" style={{ order: widgetOrder('treemap') }}>
        <ErrorBoundary title={t('dashboard.error_treemap')}>
          <ExpandableWidget title={t('portfolio_treemap.title')}>
            <PortfolioTreemap data={portfolioData.treemapData} formatMoney={formatCurrency} />
          </ExpandableWidget>
        </ErrorBoundary>
      </div>
      )}

      {/* ── Noticias — ancho completo ── */}
      {isWidgetVisible('news') && portfolioData.positions.length > 0 && (
        <div className="[&>div]:h-full" style={{ order: widgetOrder('news') }}>
          <ErrorBoundary title={t('dashboard.error_news')}>
            <ExpandableWidget title={t('portfolio_news.title')}>
              <PortfolioNewsWidget positions={portfolioData.positions} />
            </ExpandableWidget>
          </ErrorBoundary>
        </div>
      )}

      {/* ── end two-column dashboard ── */}
      </div>

    </div>
  );
};

export default Dashboard;