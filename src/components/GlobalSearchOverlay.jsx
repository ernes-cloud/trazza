import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { X, Plus, Newspaper, Activity, Loader2, Check, ChevronDown, TrendingUp, TrendingDown, Target, Ruler } from 'lucide-react';
import {
  ComposedChart, Area, Bar, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { yahooFinanceService } from '@/services/yahooFinance';
import { marketDataService } from '@/services/marketDataService';
import { insertWatchlistItem } from '@/lib/watchlistItems';
import { useToast } from '@/components/ui/use-toast';
import { supabase } from '@/lib/customSupabaseClient';
import { resolveTicker } from '@/lib/tickerMap';
import { isOpaqueTicker } from '@/lib/tickerLabel';
import { curatedFundForSymbol } from '@/services/import/fundNavEnricher';
import { formatNumber, formatPercent, appLocale } from '@/lib/formatters';

const PERIODS = ['1D', '1W', '1M', '3M', '6M', '1Y', '2Y', '5Y', 'MAX'];

const CtrlBtn = ({ active, activeClass, onClick, children }) => (
  <button
    onClick={onClick}
    className={`px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider border transition-all flex items-center gap-1 ${
      active
        ? activeClass
        : 'bg-slate-50 dark:bg-slate-800/80 border-slate-200 dark:border-slate-700 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
    }`}
  >
    {children}
  </button>
);
const PERIOD_MAP = {
  '1D':  { range: '1d',  interval: '5m' },
  '1W':  { range: '5d',  interval: '15m' },
  '1M':  { range: '1mo', interval: '1d' },
  '3M':  { range: '3mo', interval: '1d' },
  '6M':  { range: '6mo', interval: '1d' },
  '1Y':  { range: '1y',  interval: '1wk' },
  '2Y':  { range: '2y',  interval: '1wk' },
  '5Y':  { range: '5y',  interval: '1mo' },
  'MAX': { range: 'max', interval: '1mo' },
};

const GlobalSearchOverlay = ({ ticker, onClose, userId }) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  // La carga falló o no trajo datos: se enseña un error con "Reintentar". Antes
  // el overlay devolvía null y dejaba el ticker "abierto" — volver a elegir el
  // mismo activo en el buscador no hacía nada.
  const [loadFailed, setLoadFailed] = useState(false);
  // Símbolo REAL con el que se cotiza (un ISIN se resuelve buscando en Yahoo).
  // El gráfico lo necesita al cambiar de periodo: con resolveTicker(ticker) un
  // ISIN sin mapear pedía el histórico del ISIN y el gráfico salía vacío.
  const quoteSymbolRef = useRef(null);
  // Solo pinta la ÚLTIMA petición de gráfico: periodos pulsados seguidos no se pisan.
  const chartRequestRef = useRef(0);
  const [chartPeriod, setChartPeriod] = useState('1M');
  const [enriched, setEnriched] = useState(null);
  const [chartData, setChartData] = useState([]);
  const [userWatchlists, setUserWatchlists] = useState([]);
  const [isSaved, setIsSaved] = useState(false);
  const [savedLists, setSavedLists] = useState([]);
  const [hoverData, setHoverData] = useState(null);
  const [startPoint, setStartPoint] = useState(null);

  // Chart controls
  const [chartType, setChartType] = useState('area');   // 'area' | 'line'
  const [rulerMode, setRulerMode] = useState(false);

  useEffect(() => {
    if (ticker && userId) {
      loadData();
      checkSavedStatus();
      fetchWatchlists();
    }
  }, [ticker, userId]);

  useEffect(() => {
    if (ticker && enriched) {
      loadChart(chartPeriod);
    }
  }, [chartPeriod]);

  // Escape cierra la ficha (es una capa a pantalla completa: sin esto solo se
  // salía con el botón de la esquina).
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // Con el desplegable de watchlists abierto, Escape es SUYO: cierra el menú, no la ficha.
      if (document.querySelector('[data-radix-popper-content-wrapper]')) return;
      onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  useEffect(() => {
    const handleUrlChange = () => onClose();
    window.addEventListener('popstate', handleUrlChange);
    return () => window.removeEventListener('popstate', handleUrlChange);
  }, [onClose]);

  const fetchWatchlists = async () => {
    const { data } = await supabase.from('watchlists').select('*').eq('user_id', userId);
    setUserWatchlists(data || []);
  };

  const toggleWatchlist = async (watchlistId) => {
    if (!watchlistId) return;
    const { data: existing } = await supabase
      .from('watchlist_items').select('id')
      .eq('watchlist_id', watchlistId).eq('ticker', ticker).maybeSingle();

    if (existing) {
      try {
        const { error } = await supabase.from('watchlist_items').delete().eq('id', existing.id);
        if (error) throw error;
        checkSavedStatus();
        toast({ title: t('search.toast_watchlist_removed', { ticker }) });
      } catch {
        toast({ title: t('search.toast_watchlist_remove_error'), variant: "destructive" });
      }
    } else {
      try {
        // Persist the asset name too: quote responses for fund symbols carry
        // no name, so a name-less row would render the raw ticker forever.
        const displayName = enriched?.header?.name && enriched.header.name !== ticker ? enriched.header.name : null;
        const { error } = await insertWatchlistItem(supabase, { watchlistId, ticker, displayName });
        if (error) throw error;
        checkSavedStatus();
        toast({ title: t('search.toast_watchlist_saved', { ticker }) });
      } catch {
        toast({ title: t('search.toast_watchlist_save_error'), variant: "destructive" });
      }
    }
  };

  const checkSavedStatus = async () => {
    const { data } = await supabase
      .from('watchlist_items')
      .select('id, watchlist_id, watchlists!inner(id, name, user_id)')
      .eq('ticker', ticker).eq('watchlists.user_id', userId);
    if (data && data.length > 0) {
      setIsSaved(true);
      setSavedLists(data.map(d => d.watchlist_id));
    } else {
      setIsSaved(false);
      setSavedLists([]);
    }
  };

  const loadData = async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const rawIsin = ticker.replace(/\s*\([A-Z]{3}\)$/i, '').trim();
      let tickerToUse = resolveTicker(ticker);

      // If resolveTicker returned the ISIN unchanged (not in static map),
      // search Yahoo Finance by ISIN to find the real ticker symbol dynamically.
      const isUnmappedIsin = tickerToUse === rawIsin && /^[A-Z]{2}[A-Z0-9]{10}$/i.test(rawIsin);
      if (isUnmappedIsin) {
        try {
          const results = await yahooFinanceService.searchTickers(rawIsin);
          if (results && results.length > 0) {
            const best = results.find(r =>
              ['EQUITY', 'ETF', 'MUTUALFUND', 'ETC'].includes((r.type || '').toUpperCase())
            ) || results[0];
            if (best?.symbol) tickerToUse = best.symbol;
          }
        } catch (searchErr) {
          console.warn('ISIN dynamic search failed:', searchErr);
        }
      }

      // marketDataService: Yahoo first, EODHD fallback — .EUFUND fund symbols
      // (MyInvestor NAV enricher) only resolve via EODHD.
      quoteSymbolRef.current = tickerToUse;
      const data = await marketDataService.getEnrichedData(tickerToUse);
      if (!data?.header) throw new Error(`No data for ${tickerToUse}`);
      setEnriched(data);
      await loadChart(chartPeriod, tickerToUse);
    } catch (e) {
      console.error("Error loading enriched data:", e);
      setEnriched(null);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  };

  const loadChart = async (period, tickerToUse = quoteSymbolRef.current || resolveTicker(ticker)) => {
    const requestId = ++chartRequestRef.current;
    try {
      const config = PERIOD_MAP[period] || PERIOD_MAP['1M'];
      const data = await marketDataService.getHistoricalData(tickerToUse, config.range, config.interval);
      if (requestId !== chartRequestRef.current) return;
      setChartData(data);
      setStartPoint(null);
    } catch (error) {
      console.error("Error loading chart data:", error);
    }
  };

  const enrichedData = useMemo(() => chartData, [chartData]);


  const handleChartMouseMove = (state) => {
    if (state && state.activePayload) {
      const closePayload = state.activePayload.find(p => p.dataKey === 'close');
      setHoverData(closePayload?.payload ?? null);
    } else {
      setHoverData(null);
    }
  };

  const handleChartClick = (state) => {
    if (!rulerMode) return;
    if (state && state.activePayload) {
      const closePayload = state.activePayload.find(p => p.dataKey === 'close');
      const clickedData = closePayload?.payload;
      if (!clickedData?.close) return;
      if (startPoint && startPoint.time === clickedData.time) {
        setStartPoint(null);
      } else {
        setStartPoint(clickedData);
      }
    }
  };

  const toggleRulerMode = () => {
    if (rulerMode) setStartPoint(null);
    setRulerMode(v => !v);
  };

  const measurement = useMemo(() => {
    if (!startPoint || !hoverData || !hoverData.close) return null;
    const diff = hoverData.close - startPoint.close;
    const percent = (diff / startPoint.close) * 100;
    return { diff, percent };
  }, [startPoint, hoverData]);

  // Portal to document.body + inset-0 + z-100: rendered inline at top-14/z-[69]
  // the overlay sat UNDER the app header (z-[70]) and left a strip of the page
  // (stat cards + floating action pills, z-40 at top-16) bleeding through above
  // its own title bar. Full-screen with its own close bar is the correct overlay
  // model — nothing of the underlying screen competes for attention.
  const closeButton = (
    <button
      onClick={onClose}
      className="absolute top-3 left-3 p-2 rounded-xl text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
      aria-label={t('common.close')}
    >
      <X className="w-5 h-5" />
    </button>
  );

  // Cargando: también se puede cerrar (si Yahoo tarda, el usuario no queda atrapado).
  if (loading) {
    return createPortal(
      <div className="fixed inset-0 z-100 bg-slate-50 dark:bg-slate-900 flex items-center justify-center" role="dialog" aria-modal="true" aria-busy="true">
        {closeButton}
        <Loader2 className="w-12 h-12 animate-spin text-blue-600" />
      </div>,
      document.body
    );
  }

  if (loadFailed || !enriched) {
    return createPortal(
      <div className="fixed inset-0 z-100 bg-slate-50 dark:bg-slate-900 flex items-center justify-center px-6" role="dialog" aria-modal="true">
        {closeButton}
        <div className="max-w-sm text-center">
          <p className="text-base font-bold text-slate-900 dark:text-white">{t('search.load_error_title', { ticker })}</p>
          <p className="mt-1 text-sm text-slate-500">{t('search.load_error_hint')}</p>
          <div className="mt-5 flex justify-center gap-2">
            <Button variant="outline" onClick={onClose}>{t('common.close')}</Button>
            <Button onClick={loadData}>{t('common.retry')}</Button>
          </div>
        </div>
      </div>,
      document.body
    );
  }

  // Un fondo con símbolo opaco (0P…, ISIN) se titula con su NOMBRE, como en el buscador.
  // Fondo curado de MyInvestor: su nombre legible (Yahoo lo recorta: "iShares
  // Emerging Markets Govern") y, si se cotiza su clase USD, el aviso.
  const curatedFund = curatedFundForSymbol(enriched.header.symbol) || curatedFundForSymbol(quoteSymbolRef.current);
  const displayName = curatedFund?.name || enriched.header.name;
  const leadsWithName = isOpaqueTicker(enriched.header.symbol) && !!displayName && displayName !== enriched.header.symbol;
  const headline = leadsWithName ? displayName : enriched.header.symbol;
  const subline = leadsWithName ? enriched.header.symbol : displayName;

  const color = enriched.header.isPositive ? '#10b981' : '#f43f5e';
  const currSym = enriched.header.currencySymbol;

  return createPortal(
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 16 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        className="fixed inset-0 z-100 bg-slate-50 dark:bg-slate-900 flex flex-col overflow-hidden shadow-2xl"
      >
        {/* ── Sticky top bar (always visible) ── */}
        <div className="shrink-0 flex items-center gap-3 px-4 h-14 bg-white/95 dark:bg-slate-950/95 backdrop-blur-md border-b border-slate-200/80 dark:border-slate-800">
          <button
            onClick={onClose}
            className="p-2 -ml-1 rounded-xl text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0"
            aria-label={t('common.close')}
          >
            <X className="w-5 h-5" />
          </button>
          <div className="flex-1 min-w-0">
            <span className="font-extrabold text-slate-900 dark:text-white text-sm tracking-tight truncate">
              {headline}
            </span>
            <span className="ml-2 text-slate-400 text-xs font-medium truncate hidden sm:inline">
              {subline}
            </span>
          </div>
          <div className={`shrink-0 text-right ${enriched.header.isPositive ? 'text-emerald-500' : 'text-rose-500'}`}>
            <div className="text-sm font-extrabold tabular-nums">
              {currSym}{formatNumber(enriched.header.price, 2, 2)}
            </div>
            <div className="text-[10px] font-bold">{enriched.header.change}</div>
          </div>
        </div>

        {/* ── Scrollable content ── */}
        <div className="flex-1 overflow-y-auto custom-scrollbar">
        <div className="max-w-7xl mx-auto p-4 md:p-8 space-y-8">
          {/* Header */}
          <div className="flex flex-col md:flex-row justify-between items-start gap-6">
            <div className="flex-1">
              <div className="flex flex-wrap items-center gap-4 mb-2">
                <h1 className={`font-black text-slate-900 dark:text-white tracking-tighter ${leadsWithName ? 'text-3xl md:text-4xl' : 'text-5xl'}`}>{headline}</h1>
                <div className="flex gap-2">
                  <span className="px-3 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-full text-[10px] font-black uppercase tracking-widest border border-blue-200 dark:border-blue-800">
                    {enriched.header.pillar}
                  </span>
                  <span className="px-3 py-1 bg-slate-100 dark:bg-slate-800 text-slate-500 rounded-full text-[10px] font-bold uppercase tracking-widest border border-slate-200 dark:border-slate-700">
                    {enriched.about.details.exchange}
                  </span>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <span className={`text-lg text-slate-500 font-medium line-clamp-1 ${leadsWithName ? 'font-mono text-base' : ''}`}>{subline}</span>
                <div className={`text-4xl font-black flex items-center gap-3 ${enriched.header.isPositive ? 'text-emerald-500' : 'text-rose-500'}`}>
                  {currSym}{formatNumber(enriched.header.price, 2, 2)}
                  <div className="flex items-center text-xl font-bold opacity-90">
                    {enriched.header.isPositive ? <TrendingUp className="w-6 h-6 mr-1" /> : <TrendingDown className="w-6 h-6 mr-1" />}
                    {enriched.header.change}
                  </div>
                </div>
                {curatedFund?.isUsdProxy && (
                  <p className="mt-2 max-w-xl text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10 border border-amber-200/70 dark:border-amber-500/20 rounded-lg px-3 py-2">
                    {t('search.usd_proxy_notice')}
                  </p>
                )}
              </div>
            </div>

            <div className="flex gap-2 w-full md:w-auto">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button className={`flex-1 md:flex-none gap-2 px-6 h-12 transition-all font-bold ${isSaved ? 'bg-emerald-500 hover:bg-emerald-600' : 'bg-blue-600 hover:bg-blue-700'}`}>
                    {isSaved ? <Check className="w-5 h-5" /> : <Plus className="w-5 h-5" />}
                    {isSaved ? 'Saved' : 'Watchlist'}
                    <ChevronDown className="w-4 h-4 ml-1 opacity-50" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="z-110 w-64 bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 p-2 shadow-2xl">
                  <div className="px-2 py-1.5 text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100 dark:border-slate-700 mb-1">{t('search.manage_watchlists')}</div>
                  {userWatchlists.map(wl => {
                    const isItemInList = savedLists.includes(wl.id);
                    return (
                      <DropdownMenuItem key={wl.id} onClick={() => toggleWatchlist(wl.id)}
                        className="cursor-pointer font-bold px-3 py-2.5 rounded-lg focus:bg-blue-50 dark:focus:bg-blue-900/20 flex items-center justify-between group"
                      >
                        <span className={isItemInList ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-700 dark:text-slate-200'}>{wl.name}</span>
                        {isItemInList ? (
                          <div className="flex items-center gap-1.5 text-[10px] bg-emerald-100 dark:bg-emerald-900/40 px-2 py-0.5 rounded-md text-emerald-600 font-black">
                            <Check className="w-3 h-3" /> IN LIST
                          </div>
                        ) : (
                          <Plus className="w-4 h-4 text-slate-300 group-hover:text-blue-500 transition-colors" />
                        )}
                      </DropdownMenuItem>
                    );
                  })}
                  {userWatchlists.length === 0 && (
                    <div className="px-2 py-3 text-xs text-slate-500 text-center italic">{t('search.no_lists_found')}</div>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-8">
              {/* Professional Chart */}
              <div className="bg-white dark:bg-slate-800 p-6 md:p-8 rounded-4xl border border-slate-200 dark:border-slate-700 shadow-2xl shadow-slate-200/50 dark:shadow-none transition-all">

                {/* Period selector */}
                <div className="flex flex-wrap gap-0.5 p-1 bg-slate-100 dark:bg-slate-900/50 rounded-2xl mb-4 w-fit">
                  {PERIODS.map(p => (
                    <button key={p}
                      onClick={() => setChartPeriod(p)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-black transition-all ${chartPeriod === p
                        ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-md scale-105'
                        : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>

                {/* Chart controls row */}
                <div className="flex flex-wrap items-center gap-2 mb-5">
                  <CtrlBtn active={chartType === 'area'}
                    activeClass="bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400"
                    onClick={() => setChartType(t => t === 'area' ? 'line' : 'area')}
                  >
                    {chartType === 'area' ? 'AREA' : 'LINE'}
                  </CtrlBtn>

                  <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1" />

                  <CtrlBtn active={rulerMode}
                    activeClass="bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800 text-emerald-600 dark:text-emerald-400"
                    onClick={toggleRulerMode}
                  >
                    <Ruler className="w-3 h-3" />
                    RULER
                  </CtrlBtn>

                  {/* Ruler state display */}
                  {rulerMode && (
                    <div className="flex items-center gap-2 ml-1">
                      {!startPoint ? (
                        <span className="text-[10px] text-slate-400 font-medium italic">{t('search.click_to_measure')}</span>
                      ) : (
                        <div className="flex items-center gap-2 bg-emerald-50 dark:bg-emerald-900/20 px-2.5 py-1 rounded-lg border border-emerald-100 dark:border-emerald-800/50">
                          <Target className="w-3 h-3 text-emerald-500" />
                          <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
                            {t('search.measuring_from', { price: formatNumber(startPoint.close, 2, 2) })}
                          </span>
                          <button onClick={() => setStartPoint(null)} className="text-emerald-400 hover:text-emerald-600 ml-0.5">
                            <X className="w-2.5 h-2.5" />
                          </button>
                        </div>
                      )}
                      {measurement && (
                        <span className={`text-sm font-black ${measurement.diff >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                          {formatPercent(measurement.percent, 2, { sign: measurement.diff >= 0 })}
                          <span className="text-[10px] font-normal opacity-60 ml-1">
                            ({currSym}{formatNumber(Math.abs(measurement.diff), 2, 2)})
                          </span>
                        </span>
                      )}
                    </div>
                  )}
                </div>

                <div className={`w-full relative ${rulerMode ? 'cursor-crosshair' : ''}`} style={{ height: 380 }}>
                  {enrichedData.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart
                        data={enrichedData}
                        onMouseMove={handleChartMouseMove}
                        onMouseLeave={() => setHoverData(null)}
                        onClick={handleChartClick}
                        margin={{ top: 10, right: 4, left: 0, bottom: 0 }}
                      >
                        <defs>
                          <linearGradient id="colorPrice" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={color} stopOpacity={0.25} />
                            <stop offset="95%" stopColor={color} stopOpacity={0} />
                          </linearGradient>
                        </defs>

                        <XAxis dataKey="time" hide />
                        <YAxis
                          yAxisId="price"
                          hide
                          domain={[d => d * 0.99, d => d * 1.01]}
                        />

                        <Tooltip
                          cursor={{ stroke: '#94a3b8', strokeWidth: 1, strokeDasharray: '4 4' }}
                          content={({ active, payload }) => {
                            if (!active || !payload?.length) return null;
                            const p = payload.find(pl => pl.dataKey === 'close')?.payload;
                            if (!p) return null;
                            return (
                              <div className="bg-slate-900/95 dark:bg-black/95 backdrop-blur-md p-4 rounded-2xl shadow-2xl border border-white/10 text-white min-w-[160px]">
                                <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">{p.time}</div>
                                <div className="text-2xl font-black mb-1">
                                  {currSym}{p.close?.toLocaleString(appLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </div>
                                {(p.open != null || p.high != null || p.low != null) && (
                                  <div className="grid grid-cols-3 gap-2 text-[10px] text-slate-400 mt-2 pt-2 border-t border-white/10">
                                    <div>
                                      <div className="font-black text-white">{p.open != null ? `${currSym}${formatNumber(p.open, 2, 2)}` : '—'}</div>
                                      <div>O</div>
                                    </div>
                                    <div>
                                      <div className="font-black text-emerald-400">{p.high != null ? `${currSym}${formatNumber(p.high, 2, 2)}` : '—'}</div>
                                      <div>H</div>
                                    </div>
                                    <div>
                                      <div className="font-black text-rose-400">{p.low != null ? `${currSym}${formatNumber(p.low, 2, 2)}` : '—'}</div>
                                      <div>L</div>
                                    </div>
                                  </div>
                                )}
                                {p.volume > 0 && (
                                  <div className="text-[10px] text-slate-400 mt-1.5">
                                    Vol: {p.volume >= 1e6
                                      ? `${formatNumber(p.volume / 1e6, 2, 2)}M`
                                      : p.volume >= 1e3
                                      ? `${formatNumber(p.volume / 1e3, 1, 1)}K`
                                      : p.volume}
                                  </div>
                                )}
                                {startPoint && p.close && (
                                  <div className={`text-xs font-bold mt-2 py-1 px-2 rounded-lg flex items-center gap-1.5 ${p.close >= startPoint.close ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`}>
                                    {p.close >= startPoint.close
                                      ? <TrendingUp className="w-3 h-3" />
                                      : <TrendingDown className="w-3 h-3" />}
                                    {formatPercent(((p.close - startPoint.close) / startPoint.close) * 100, 2, { sign: true })}
                                  </div>
                                )}
                              </div>
                            );
                          }}
                        />

                        {/* Start point reference line */}
                        {startPoint && (
                          <ReferenceLine
                            yAxisId="price"
                            y={startPoint.close}
                            stroke="#6366f1"
                            strokeDasharray="4 3"
                            strokeWidth={1.5}
                          />
                        )}

                        {/* Price area or line */}
                        {chartType === 'area' ? (
                          <Area
                            yAxisId="price"
                            type="monotone"
                            dataKey="close"
                            stroke={color}
                            strokeWidth={2}
                            fillOpacity={1}
                            fill="url(#colorPrice)"
                            animationDuration={800}
                            connectNulls
                            dot={false}
                          />
                        ) : (
                          <Line
                            yAxisId="price"
                            type="monotone"
                            dataKey="close"
                            stroke={color}
                            strokeWidth={2}
                            dot={false}
                            animationDuration={800}
                            connectNulls
                          />
                        )}

                      </ComposedChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="h-full flex flex-col items-center justify-center text-slate-400 gap-3">
                      <Activity className="w-10 h-10 opacity-20" />
                      <span className="font-medium">{t('search.no_historical_data')}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Metrics Grid — only price-action metrics, no fundamental ratios */}
              {enriched.metrics.filter(m => !['MARKET CAP', 'P/E RATIO', 'DIV YIELD', 'BETA'].includes(m.label)).length > 0 && (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  {enriched.metrics
                    .filter(m => !['MARKET CAP', 'P/E RATIO', 'DIV YIELD', 'BETA'].includes(m.label))
                    .map((m, i) => (
                    <div key={i} className="bg-white dark:bg-slate-800 p-6 rounded-3xl border border-slate-200 dark:border-slate-700 hover:border-blue-400 transition-all group">
                      <div className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2 group-hover:text-blue-500 transition-colors">{m.label}</div>
                      <div className={`text-xl font-black ${m.value === 'N/A' ? 'text-slate-300 dark:text-slate-600' : 'text-slate-900 dark:text-white'}`}>
                        {m.value}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* News Feed */}
              <div className="space-y-6">
                <h3 className="text-2xl font-black flex items-center gap-3 text-slate-900 dark:text-white pl-1">
                  <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-xl">
                    <Newspaper className="w-6 h-6 text-blue-500" />
                  </div>
                  Latest Insights
                </h3>
                <div className="grid grid-cols-1 gap-4">
                  {enriched.news.slice(0, 6).map((item) => (
                    <a href={item.url} target="_blank" rel="noopener noreferrer" key={item.url || item.title}
                      className="group bg-white dark:bg-slate-800 p-5 rounded-3xl border border-slate-200 dark:border-slate-700 hover:border-blue-500 hover:shadow-xl transition-all flex gap-6"
                    >
                      {item.image && (
                        <div className="w-32 h-32 shrink-0 overflow-hidden rounded-2xl">
                          <img src={item.image} alt="" className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0 flex flex-col justify-center">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="px-2 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-[10px] font-black text-blue-600 dark:text-blue-400 uppercase tracking-widest">{item.source}</span>
                          <span className="text-xs text-slate-400 font-medium">• {item.formattedDate}</span>
                        </div>
                        <h4 className="font-extrabold text-slate-900 dark:text-white leading-tight group-hover:text-blue-600 transition-colors line-clamp-2 text-xl">{item.title}</h4>
                      </div>
                    </a>
                  ))}
                  {enriched.news.length === 0 && (
                    <div className="text-center py-20 text-slate-400 font-bold bg-slate-100/50 dark:bg-slate-800/50 rounded-[2.5rem] border-2 border-dashed border-slate-200 dark:border-slate-700">
                      {t('search.no_insights')}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-8">
              {/* About Section */}
              <div className="bg-white dark:bg-slate-800 p-8 rounded-4xl border border-slate-200 dark:border-slate-700 shadow-xs relative overflow-hidden group">
                <div className="absolute -top-10 -right-10 opacity-[0.03] group-hover:opacity-[0.07] transition-opacity">
                  <TrendingUp className="w-64 h-64" />
                </div>
                <h3 className="text-2xl font-black mb-6 text-slate-900 dark:text-white flex items-center gap-2">
                  Business Profile
                </h3>
                {enriched.about.description && !enriched.about.description.startsWith('No description') && (
                  <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed mb-8 font-medium italic">
                    "{enriched.about.description}"
                  </p>
                )}
                <div className="grid grid-cols-1 gap-4 pt-6 border-t border-slate-100 dark:border-slate-700">
                  {Object.entries(enriched.about.details).map(([key, val]) => (
                    <div key={key}>
                      <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">{key}</div>
                      {key === 'website' ? (
                        <a href={val} target="_blank" rel="noopener noreferrer"
                          className="font-bold text-blue-500 hover:text-blue-700 text-sm tracking-tight truncate block hover:underline"
                          title={val}>
                          {val.replace(/^https?:\/\//, '')}
                        </a>
                      ) : (
                        <div className="font-extrabold text-slate-900 dark:text-white text-base tracking-tight truncate" title={val}>{val}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
        </div>
      </motion.div>
    </AnimatePresence>,
    document.body
  );
};

export default GlobalSearchOverlay;
