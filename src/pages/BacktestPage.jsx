import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { Loader2, Search, X, History, TrendingUp, Info, Scale, Wallet } from 'lucide-react';
import { yahooFinanceService } from '@/services/yahooFinance';
import { computeBacktest, scaleWeightsToHundred } from '@/services/backtestService';
import { ErrorBoundary } from '@/components/ErrorBoundary';

// Portfolio line is always blue; asset lines cycle through this palette.
const PORTFOLIO_COLOR = '#3b82f6';
const ASSET_COLORS = ['#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16', '#f97316'];

const RANGES = [
  { key: '1y',  interval: '1d'  },
  { key: '3y',  interval: '1wk' },
  { key: '5y',  interval: '1wk' },
  { key: '10y', interval: '1mo' },
  { key: 'max', interval: '1mo' },
];

const MAX_ASSETS = ASSET_COLORS.length;

const REBALANCE_MODES = ['none', 'quarterly', 'annual'];

// Data-point resolution for a custom window: daily up to ~14 months, weekly up
// to ~5 years, monthly beyond — mirrors the presets' interval density.
const intervalForSpanDays = (days) => (days <= 430 ? '1d' : days <= 1900 ? '1wk' : '1mo');
const toISODate = (d) => d.toISOString().split('T')[0];
const DEFAULT_CUSTOM_FROM = toISODate(new Date(Date.now() - 3 * 365.25 * 24 * 3600 * 1000));
const DEFAULT_CUSTOM_TO = toISODate(new Date());

// Última configuración usada (activos, rango y opciones) — persiste entre visitas.
const LS_KEY = 'wf_backtest';
const loadSaved = () => {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; }
};

const fmtMoney = (n) => Number(n).toLocaleString('es-ES', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

/**
 * Backtest / "time machine": pick any assets, assign weights and see how that
 * portfolio would have performed over the chosen range. Pure math lives in
 * services/backtestService.js (unit-tested); this page only fetches series
 * (yahooFinanceService.getHistoricalData → adjusted close) and renders.
 */
const BacktestPage = () => {
  const { t } = useTranslation();

  const saved = useMemo(() => loadSaved(), []);

  // Selected assets: [{ ticker, name, weight }]
  const [assets, setAssets] = useState(Array.isArray(saved.assets) ? saved.assets : []);
  const [range, setRange] = useState(saved.range ?? '5y');
  const [customFrom, setCustomFrom] = useState(saved.customFrom || DEFAULT_CUSTOM_FROM);
  const [customTo, setCustomTo] = useState(saved.customTo || DEFAULT_CUSTOM_TO);
  const [rebalance, setRebalance] = useState(saved.rebalance ?? 'none');
  const [initial, setInitial] = useState(saved.initial ?? 10000);
  const [monthly, setMonthly] = useState(saved.monthly ?? 0);
  const [cash, setCash] = useState(saved.cash ?? 0); // liquidez (mismo escalar de peso)

  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ assets, range, customFrom, customTo, rebalance, initial, monthly, cash })); } catch {}
  }, [assets, range, customFrom, customTo, rebalance, initial, monthly, cash]);

  const isCustomRange = range === 'custom';
  const customValid = !!(customFrom && customTo && customFrom < customTo);

  // Search box
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const searchRef = useRef(null);

  // Historical series per ticker
  const [seriesByTicker, setSeriesByTicker] = useState({});
  const [loadingSeries, setLoadingSeries] = useState(false);
  const [failedTickers, setFailedTickers] = useState([]);

  // ── Debounced ticker search ────────────────────────────────────────────────
  useEffect(() => {
    if (!query || query.trim().length < 2) { setResults([]); return; }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const found = await yahooFinanceService.searchTickers(query.trim(), controller.signal);
        setResults(found.slice(0, 8));
      } catch (err) {
        if (err.name !== 'AbortError') console.error('Backtest search error:', err);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);

  // Close the results dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (searchRef.current && !searchRef.current.contains(e.target)) setResults([]);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ── Fetch historical series when assets or range change ───────────────────
  useEffect(() => {
    if (assets.length === 0) { setSeriesByTicker({}); setFailedTickers([]); return; }
    // A custom window needs both ends and from < to before it can fetch.
    if (isCustomRange && !customValid) { setSeriesByTicker({}); setFailedTickers([]); return; }
    let cancelled = false;
    const load = async () => {
      setLoadingSeries(true);
      // Preset ranges use Yahoo's named range; a custom window uses period1/period2
      // (getHistoricalRange) with an interval chosen by its span.
      const fetchOne = isCustomRange
        ? (ticker) => yahooFinanceService.getHistoricalRange(
            ticker, customFrom, customTo,
            intervalForSpanDays((Date.parse(customTo) - Date.parse(customFrom)) / 86400000),
          )
        : (ticker) => yahooFinanceService.getHistoricalData(ticker, range, RANGES.find(r => r.key === range)?.interval || '1wk');
      const entries = await Promise.all(assets.map(async ({ ticker }) => {
        try {
          const data = await fetchOne(ticker);
          return [ticker, data];
        } catch (err) {
          console.error(`Backtest history error for ${ticker}:`, err);
          return [ticker, []];
        }
      }));
      if (cancelled) return;
      const ok = {};
      const failed = [];
      for (const [ticker, data] of entries) {
        if (data && data.length > 0) ok[ticker] = data;
        else failed.push(ticker);
      }
      setSeriesByTicker(ok);
      setFailedTickers(failed);
      setLoadingSeries(false);
    };
    load();
    return () => { cancelled = true; };
  }, [assets, range, customFrom, customTo]);

  // ── Simulation (pure, memoized) ────────────────────────────────────────────
  const weights = useMemo(() => Object.fromEntries(assets.map(a => [a.ticker, a.weight])), [assets]);
  const backtest = useMemo(
    () => computeBacktest(seriesByTicker, weights, { rebalance, initial, monthly, cash }),
    [seriesByTicker, weights, rebalance, initial, monthly, cash]
  );

  const addAsset = (item) => {
    setQuery('');
    setResults([]);
    if (!item?.symbol) return;
    setAssets(prev => {
      if (prev.some(a => a.ticker === item.symbol) || prev.length >= MAX_ASSETS) return prev;
      return [...prev, { ticker: item.symbol, name: item.description || item.symbol, weight: 10 }];
    });
  };

  const removeAsset = (ticker) => setAssets(prev => prev.filter(a => a.ticker !== ticker));

  const setWeight = (ticker, value) => {
    const parsed = parseFloat(value);
    setAssets(prev => prev.map(a => a.ticker === ticker
      ? { ...a, weight: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0 }
      : a));
  };

  // Sum of the entered weights — assets + liquidity. Informational: the
  // simulation always normalizes, but the user wants to see whether their
  // intended allocation (including cash) hits 100%.
  const cashWeight = Number.isFinite(+cash) && +cash > 0 ? +cash : 0;
  const weightSum = useMemo(
    () => assets.reduce((s, a) => s + (Number.isFinite(+a.weight) && +a.weight > 0 ? +a.weight : 0), 0) + cashWeight,
    [assets, cashWeight]
  );
  const weightIs100 = Math.abs(weightSum - 100) < 0.05;

  // One click → rewrite ALL weights (assets + liquidity) to sum exactly 100,
  // keeping proportions. Cash is the last slot in the vector.
  const normalizeWeights = () => {
    const scaled = scaleWeightsToHundred([...assets.map(a => a.weight), cashWeight]);
    setAssets(prev => prev.map((a, i) => ({ ...a, weight: scaled[i] })));
    setCash(scaled[scaled.length - 1]);
  };

  const hasChart = backtest.points.length > 1;
  const activeTickers = Object.keys(seriesByTicker);

  // Human name for a symbol ('^IBEX' → 'IBEX 35'): what the rows, the legend and
  // the tooltip show. The ticker stays visible as the secondary line — it is the
  // identifier, not the label.
  const nameOf = (ticker) => assets.find(a => a.ticker === ticker)?.name || ticker;

  // Series loaded but no common dates: with mixed exchanges the histories can
  // simply not overlap (a young ETF vs an old index). Say so instead of showing
  // the "pick some assets" empty state, which reads as if nothing happened.
  const noOverlap = !loadingSeries && activeTickers.length > 1 && backtest.points.length === 0;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-2xl bg-blue-600 flex items-center justify-center shrink-0">
          <History className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1 className="text-xl font-black text-gray-900 dark:text-white">{t('backtest.page_title')}</h1>
          <p className="text-xs text-slate-400 dark:text-slate-500">{t('backtest.page_subtitle')}</p>
        </div>
      </div>

      {/* Asset picker + weights */}
      <div className="bg-white dark:bg-slate-800/80 p-5 rounded-2xl border border-slate-200/80 dark:border-slate-700/40 shadow-xs space-y-4">

        {/* Search */}
        <div className="relative" ref={searchRef}>
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('backtest.search_placeholder')}
            disabled={assets.length >= MAX_ASSETS}
            className="w-full pl-9 pr-9 py-2.5 rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-transparent text-sm text-gray-900 dark:text-white placeholder:text-slate-400 focus:border-blue-500 focus:outline-hidden disabled:opacity-50"
          />
          {searching && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-blue-500" />}

          {results.length > 0 && (
            <div className="absolute z-20 mt-2 w-full bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 shadow-2xl overflow-hidden">
              {results.map(item => (
                <button
                  key={`${item.symbol}-${item.exchange}`}
                  onClick={() => addAsset(item)}
                  className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-gray-900 dark:text-white truncate">{item.description || item.symbol}</p>
                    <p className="text-[11px] text-slate-400 truncate">{item.symbol}</p>
                  </div>
                  <span className="text-[10px] font-semibold text-slate-400 shrink-0 ml-3">{item.exchange}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Selected assets with weights */}
        {assets.length === 0 ? (
          <p className="text-xs text-slate-400 italic">{t('backtest.empty_hint')}</p>
        ) : (
          <div className="space-y-2">
            {assets.map((asset, idx) => {
              const effective = backtest.stats.perAsset[asset.ticker]?.weightPct;
              const assetReturn = backtest.stats.perAsset[asset.ticker]?.totalReturn;
              return (
                <div key={asset.ticker} className="flex items-center gap-3 px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-900/40 border border-slate-100 dark:border-slate-800">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: ASSET_COLORS[idx % ASSET_COLORS.length] }} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-gray-900 dark:text-white truncate">{asset.name || asset.ticker}</p>
                    <p className="text-[11px] text-slate-400 truncate">{asset.ticker}</p>
                  </div>
                  <label className="flex items-center gap-1.5 text-[11px] text-slate-400 shrink-0">
                    {t('backtest.weight_label')}
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={asset.weight}
                      onChange={(e) => setWeight(asset.ticker, e.target.value)}
                      className="w-16 px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-right text-xs font-bold text-gray-900 dark:text-white focus:border-blue-500 focus:outline-hidden"
                    />
                  </label>
                  {assetReturn != null && (
                    <span className={`text-[11px] font-bold w-16 text-right shrink-0 ${assetReturn >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'}`}>
                      {assetReturn >= 0 ? '+' : ''}{assetReturn.toFixed(1)}%
                    </span>
                  )}
                  {effective != null && (
                    <span className="text-[11px] font-bold text-blue-600 dark:text-blue-400 w-12 text-right shrink-0">
                      {effective.toFixed(1)}%
                    </span>
                  )}
                  <button
                    onClick={() => removeAsset(asset.ticker)}
                    aria-label={t('common.delete')}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Liquidez (cash sleeve) — a flat allocation that dilutes the result */}
        {assets.length > 0 && (
          <div className="flex items-center gap-3 px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-900/40 border border-slate-100 dark:border-slate-800">
            <span className="w-2.5 h-2.5 rounded-full shrink-0 bg-slate-400 dark:bg-slate-500" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-gray-900 dark:text-white flex items-center gap-1.5">
                <Wallet className="w-3.5 h-3.5 text-slate-400" />
                {t('backtest.cash_label')}
              </p>
              <p className="text-[11px] text-slate-400 truncate">{t('backtest.cash_hint')}</p>
            </div>
            <label className="flex items-center gap-1.5 text-[11px] text-slate-400 shrink-0">
              {t('backtest.weight_label')}
              <input
                type="number" min="0" step="1" value={cash}
                onChange={(e) => { const v = parseFloat(e.target.value); setCash(Number.isFinite(v) && v >= 0 ? v : 0); }}
                className="w-16 px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-right text-xs font-bold text-gray-900 dark:text-white focus:border-blue-500 focus:outline-hidden"
              />
            </label>
            {backtest.stats.cashWeightPct > 0 && (
              <span className="text-[11px] font-bold text-blue-600 dark:text-blue-400 w-12 text-right shrink-0">
                {backtest.stats.cashWeightPct.toFixed(1)}%
              </span>
            )}
          </div>
        )}

        {/* Weight sum indicator (informational — the sim always normalizes) */}
        {assets.length > 0 && (
          <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-900/40 border border-slate-100 dark:border-slate-800">
            <span className="flex items-center gap-2 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
              <Scale className="w-3.5 h-3.5 shrink-0" />
              {t('backtest.weight_sum')}
              <span className={`font-black tabular-nums ${weightIs100 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                {weightSum.toFixed(weightSum % 1 === 0 ? 0 : 1)}%
              </span>
              {!weightIs100 && (
                <span className="text-[10px] text-slate-400">
                  {weightSum < 100
                    ? t('backtest.weight_sum_under', { pct: (100 - weightSum).toFixed(weightSum % 1 === 0 ? 0 : 1) })
                    : t('backtest.weight_sum_over', { pct: (weightSum - 100).toFixed(weightSum % 1 === 0 ? 0 : 1) })}
                </span>
              )}
            </span>
            {!weightIs100 && (
              <button
                onClick={normalizeWeights}
                className="shrink-0 text-[11px] font-bold text-blue-600 dark:text-blue-400 hover:underline"
              >
                {t('backtest.weight_normalize')}
              </button>
            )}
          </div>
        )}

        {/* Strategy options: rebalancing policy + money simulation */}
        <div className="flex flex-wrap items-end gap-4 pt-1 border-t border-slate-100 dark:border-slate-800">
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5 mt-3">
              {t('backtest.rebalance_label')}
            </label>
            <div className="flex bg-slate-100 dark:bg-slate-900/60 p-0.5 rounded-lg">
              {REBALANCE_MODES.map(m => (
                <button key={m} onClick={() => setRebalance(m)}
                  className={`px-3 py-1.5 text-[11px] font-bold rounded-md transition-colors ${
                    rebalance === m
                      ? 'bg-white dark:bg-slate-700 text-blue-600 shadow-xs'
                      : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                  }`}>
                  {t(`backtest.rebalance_${m}`)}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">
              {t('backtest.initial_label')}
            </label>
            <input
              type="number" min="0" step="500" value={initial}
              onChange={(e) => setInitial(Math.max(0, parseFloat(e.target.value) || 0))}
              className="w-28 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-right text-xs font-bold text-gray-900 dark:text-white focus:border-blue-500 focus:outline-hidden"
            />
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">
              {t('backtest.monthly_label')}
            </label>
            <input
              type="number" min="0" step="50" value={monthly}
              onChange={(e) => setMonthly(Math.max(0, parseFloat(e.target.value) || 0))}
              className="w-28 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-right text-xs font-bold text-gray-900 dark:text-white focus:border-blue-500 focus:outline-hidden"
            />
          </div>
        </div>

        {failedTickers.length > 0 && (
          <p className="text-[11px] text-amber-600 dark:text-amber-400">
            {t('backtest.error_fetch', { tickers: failedTickers.map(nameOf).join(', ') })}
          </p>
        )}
      </div>

      {/* Chart card */}
      <ErrorBoundary title={t('backtest.page_title')}>
        <div className="bg-white dark:bg-slate-800/80 p-5 rounded-2xl border border-slate-200/80 dark:border-slate-700/40 shadow-xs">

          {/* Range selector + headline stats */}
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div className="flex flex-wrap gap-1.5">
              {RANGES.map(r => (
                <button
                  key={r.key}
                  onClick={() => setRange(r.key)}
                  className={`px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase transition-colors ${
                    range === r.key
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-100 dark:bg-slate-900/60 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
                  }`}
                >
                  {t(`backtest.range_${r.key}`)}
                </button>
              ))}
              <button
                onClick={() => setRange('custom')}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase transition-colors ${
                  isCustomRange
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-100 dark:bg-slate-900/60 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
                }`}
              >
                {t('backtest.range_custom')}
              </button>
            </div>

            {hasChart && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="text-right">
                  <p className="text-[10px] uppercase tracking-wider text-slate-400">{t('backtest.total_return')}</p>
                  <p className={`text-sm font-black ${backtest.stats.portfolio.totalReturn >= 0 ? 'text-emerald-600' : 'text-rose-500'}`}>
                    {backtest.stats.portfolio.totalReturn >= 0 ? '+' : ''}{backtest.stats.portfolio.totalReturn.toFixed(2)}%
                  </p>
                </div>
                {backtest.stats.portfolio.cagr != null && (
                  <div className="text-right">
                    <p className="text-[10px] uppercase tracking-wider text-slate-400">{t('backtest.cagr')}</p>
                    <p className={`text-sm font-black ${backtest.stats.portfolio.cagr >= 0 ? 'text-emerald-600' : 'text-rose-500'}`}>
                      {backtest.stats.portfolio.cagr >= 0 ? '+' : ''}{backtest.stats.portfolio.cagr.toFixed(2)}%
                    </p>
                  </div>
                )}
                {backtest.stats.portfolio.maxDrawdown != null && (
                  <div className="text-right">
                    <p className="text-[10px] uppercase tracking-wider text-slate-400">{t('backtest.max_drawdown')}</p>
                    <p className="text-sm font-black text-rose-500">−{backtest.stats.portfolio.maxDrawdown.toFixed(1)}%</p>
                  </div>
                )}
                {backtest.stats.portfolio.volatility != null && (
                  <div className="text-right">
                    <p className="text-[10px] uppercase tracking-wider text-slate-400">{t('backtest.volatility')}</p>
                    <p className="text-sm font-black text-slate-600 dark:text-slate-300">{backtest.stats.portfolio.volatility.toFixed(1)}%</p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Custom window date pickers */}
          {isCustomRange && (
            <div className="flex flex-wrap items-center gap-2 mb-4 -mt-1">
              <label className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400">
                {t('backtest.custom_from')}
                <input
                  type="date" value={customFrom} max={customTo || undefined}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-bold text-gray-900 dark:text-white focus:border-blue-500 focus:outline-hidden"
                />
              </label>
              <span className="text-slate-400 text-xs">→</span>
              <label className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400">
                {t('backtest.custom_to')}
                <input
                  type="date" value={customTo} min={customFrom || undefined} max={DEFAULT_CUSTOM_TO}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-bold text-gray-900 dark:text-white focus:border-blue-500 focus:outline-hidden"
                />
              </label>
              {!customValid && (
                <span className="text-[11px] text-amber-600 dark:text-amber-400">{t('backtest.custom_invalid')}</span>
              )}
            </div>
          )}

          {/* Money outcome (initial + DCA) */}
          {hasChart && backtest.stats.money && (
            <div className="mb-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-3 border border-blue-100/80 dark:border-blue-800/30">
                  <p className="text-[9px] font-bold text-blue-500/70 uppercase tracking-wider mb-0.5">{t('backtest.kpi_final_value')}</p>
                  <p className="text-base font-black tabular-nums text-blue-700 dark:text-blue-300">{fmtMoney(backtest.stats.money.finalValue)}</p>
                </div>
                <div className="bg-slate-50 dark:bg-slate-900/40 rounded-xl p-3 border border-slate-200/60 dark:border-slate-700/30">
                  <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">{t('backtest.kpi_invested')}</p>
                  <p className="text-base font-extrabold tabular-nums text-slate-700 dark:text-slate-200">{fmtMoney(backtest.stats.money.invested)}</p>
                </div>
                <div className={`rounded-xl p-3 border ${backtest.stats.money.profit >= 0 ? 'bg-emerald-50 dark:bg-emerald-900/15 border-emerald-100/80 dark:border-emerald-800/30' : 'bg-rose-50 dark:bg-rose-900/15 border-rose-100/80 dark:border-rose-800/30'}`}>
                  <p className={`text-[9px] font-bold uppercase tracking-wider mb-0.5 ${backtest.stats.money.profit >= 0 ? 'text-emerald-500/70' : 'text-rose-500/70'}`}>{t('backtest.kpi_profit')}</p>
                  <p className={`text-base font-black tabular-nums ${backtest.stats.money.profit >= 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-600 dark:text-rose-400'}`}>
                    {backtest.stats.money.profit >= 0 ? '+' : ''}{fmtMoney(backtest.stats.money.profit)}
                  </p>
                </div>
                <div className="bg-slate-50 dark:bg-slate-900/40 rounded-xl p-3 border border-slate-200/60 dark:border-slate-700/30">
                  <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">{t('backtest.kpi_profit_pct')}</p>
                  <p className={`text-base font-black tabular-nums ${(backtest.stats.money.profitPct ?? 0) >= 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-600 dark:text-rose-400'}`}>
                    {backtest.stats.money.profitPct != null ? `${backtest.stats.money.profitPct >= 0 ? '+' : ''}${backtest.stats.money.profitPct.toFixed(1)}%` : '—'}
                  </p>
                </div>
              </div>
              {monthly > 0 && (
                <p className="mt-1.5 text-[10px] text-slate-400/80">{t('backtest.money_note')}</p>
              )}
            </div>
          )}

          {/* Chart / empty / loading states */}
          {loadingSeries ? (
            <div className="h-[360px] flex items-center justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
            </div>
          ) : !hasChart ? (
            <div className="h-[360px] flex flex-col items-center justify-center gap-2 text-center">
              <TrendingUp className="w-8 h-8 text-slate-300 dark:text-slate-600" />
              <p className="text-sm font-semibold text-slate-500 dark:text-slate-400">
                {noOverlap ? t('backtest.no_overlap_title') : t('backtest.chart_empty_title')}
              </p>
              <p className="text-xs text-slate-400 max-w-sm">
                {noOverlap ? t('backtest.no_overlap_hint') : t('backtest.chart_empty_hint')}
              </p>
            </div>
          ) : (
            <>
              <div className="h-[360px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={backtest.points}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" className="dark:stroke-slate-800" />
                    <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#94a3b8' }} minTickGap={40} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#94a3b8' }} tickFormatter={(v) => `${v}%`} />
                    <Tooltip
                      content={({ active, payload }) => {
                        if (!active || !payload || !payload.length) return null;
                        return (
                          <div className="bg-slate-900/95 border border-slate-800 p-3 rounded-xl shadow-2xl backdrop-blur-md text-xs">
                            <div className="text-white font-bold mb-2">{payload[0]?.payload?.date}</div>
                            {payload.map(p => (
                              <div key={p.dataKey} className="flex justify-between gap-4">
                                <span style={{ color: p.color }}>{p.name}</span>
                                <span className="text-white font-bold">{p.value >= 0 ? '+' : ''}{p.value.toFixed(2)}%</span>
                              </div>
                            ))}
                          </div>
                        );
                      }}
                    />
                    <Legend verticalAlign="top" height={30} wrapperStyle={{ fontSize: 11 }} />
                    <Line
                      type="monotone"
                      dataKey="portfolio"
                      name={t('backtest.portfolio_line')}
                      stroke={PORTFOLIO_COLOR}
                      strokeWidth={3}
                      dot={false}
                      activeDot={{ r: 5 }}
                    />
                    {activeTickers.map((ticker) => {
                      const idx = assets.findIndex(a => a.ticker === ticker);
                      return (
                        <Line
                          key={ticker}
                          type="monotone"
                          dataKey={ticker}
                          name={nameOf(ticker)}
                          stroke={ASSET_COLORS[(idx >= 0 ? idx : 0) % ASSET_COLORS.length]}
                          strokeWidth={1.5}
                          strokeDasharray="4 3"
                          dot={false}
                        />
                      );
                    })}
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Window + methodology notes */}
              <div className="mt-3 flex flex-col gap-1">
                {backtest.startDate && (
                  <p className="text-[11px] text-slate-400 flex items-center gap-1.5">
                    <Info className="w-3 h-3 shrink-0" />
                    {t('backtest.common_window', { date: backtest.startDate })}
                  </p>
                )}
                <p className="text-[10px] text-slate-400/80">{t('backtest.caveat')}</p>
              </div>
            </>
          )}
        </div>
      </ErrorBoundary>
    </div>
  );
};

export default BacktestPage;
