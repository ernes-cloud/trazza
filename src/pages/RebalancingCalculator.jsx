import React, { useState, useEffect, useMemo, useRef } from 'react';
import { motion } from 'framer-motion';
import { Helmet } from 'react-helmet';
import { useSearchParams, Link, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { TrendingUp, TrendingDown, Minus, Scale, PiggyBank, Search, Loader2, Sparkles, X, Info } from 'lucide-react';
import { supabase } from '@/lib/customSupabaseClient';
import { useSupabaseAuth } from '@/contexts/SupabaseAuthContext';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { preferredCurrencyOf } from '@/lib/preferredCurrency';
import { useBrokers } from '@/hooks/useBrokers';
import { useTickerSearch } from '@/hooks/useTickerSearch';
import { useToast } from '@/components/ui/use-toast';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { currencyService } from '@/services/currencyService';
import { marketDataService } from '@/services/marketDataService';
import { buildRebalancePlan, BAND_MODES } from '@/services/rebalanceService';
import { computeHistoryTotals, computeInvestedHybrid } from '@/services/portfolioHistory';
import { formatNumber, getCurrencySymbol } from '@/lib/formatters';

// Target editable en línea: guarda al salir del campo o con Enter; Escape descarta.
const TargetInput = ({ row, label, onSave }) => {
  const [draft, setDraft] = useState(null); // null → sin editar, muestra el valor real
  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="number"
        min="0"
        max="100"
        step="0.5"
        value={draft ?? String(row.target)}
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null) onSave(row, draft);
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setDraft(null);
        }}
        className="w-20 text-right rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white text-sm px-2 py-1.5 focus:outline-hidden focus:ring-2 focus:ring-blue-500"
      />
      <span className="text-sm text-slate-500 dark:text-slate-400">%</span>
    </span>
  );
};

// Ticker search to add an asset you don't hold yet as a virtual plan row.
// Only searches + emits the picked result; the parent fetches quote + FX rate.
const AddAssetControl = ({ onSelect }) => {
  const { t } = useTranslation();
  const { query, setQuery, results, isSearching, onKeyDown } = useTickerSearch({ limit: 8 });
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const pick = (r) => { setQuery(''); setOpen(false); onSelect(r); };

  return (
    <div ref={ref}>
      <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">
        {t('rebalancing.add_asset_label')}
      </label>
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-slate-400" />
        <input
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => onKeyDown(e, { onSelect: pick, onClose: () => setOpen(false) })}
          placeholder={t('rebalancing.add_asset_placeholder')}
          className="w-56 pl-9 pr-8 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white text-sm focus:outline-hidden focus:ring-2 focus:ring-blue-500"
        />
        {isSearching && <Loader2 className="absolute right-2.5 top-2.5 w-4 h-4 animate-spin text-slate-400" />}
        {open && results.length > 0 && (
          <div className="absolute z-50 mt-1 w-full max-h-64 overflow-y-auto bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl" role="listbox">
            {results.map((r, i) => (
              <button
                key={`${r.symbol}-${i}`}
                onClick={() => pick(r)}
                className="w-full text-left px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition"
              >
                <span className="font-semibold text-slate-900 dark:text-white text-sm">{r.symbol}</span>
                <span className="block text-xs text-slate-500 dark:text-slate-400 truncate">{r.name || r.shortname || ''}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// Small info (i) with a CSS-only hover/focus tooltip (no extra deps).
const InfoTip = ({ text }) => (
  <span className="group/tip relative inline-flex ml-1 align-middle">
    <Info
      className="w-3 h-3 text-slate-400 hover:text-blue-500"
      role="button"
      tabIndex={0}
      aria-label={text}
      onClick={(e) => e.stopPropagation()}
    />
    <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 z-50 rounded-lg bg-slate-900 text-white text-[11px] font-normal leading-snug px-3 py-2 shadow-xl opacity-0 group-hover/tip:opacity-100 group-focus-within/tip:opacity-100 transition-opacity normal-case tracking-normal text-left">
      {text}
    </span>
  </span>
);

const RebalancingCalculator = () => {
  const { t } = useTranslation();
  const { user } = useSupabaseAuth();
  const { preferences: userPreferences, loading: prefsLoading } = useUserPreferences();
  const { toast } = useToast();
  const { brokers } = useBrokers(user?.id);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();

  // Close → back to wherever the user came from. `key === 'default'` means this
  // was the first in-app entry (deep link), so there's nothing to go back to.
  const handleClose = () => {
    if (location.key === 'default') navigate('/app');
    else navigate(-1);
  };

  const [positions, setPositions] = useState([]);
  const [virtualAssets, setVirtualAssets] = useState([]); // what-if rows for assets not held
  const [exchangeRates, setExchangeRates] = useState({});
  const [preferredCurrency, setPreferredCurrency] = useState('EUR');
  const [invested, setInvested] = useState(null); // cost basis, synced with Dashboard/brokers
  const [loading, setLoading] = useState(true);

  // ── Plan controls ──────────────────────────────────────────────────────────
  const selectedBrokerId = searchParams.get('broker') || 'general';
  // ?contribution=<amount> (e.g. from the expenses screen's "unassigned savings"
  // CTA) opens directly in contribute mode with the amount pre-filled
  const initialContribution = (() => {
    const value = parseFloat(searchParams.get('contribution'));
    return Number.isFinite(value) && value > 0 ? String(Math.round(value * 100) / 100) : null;
  })();
  const [mode, setMode] = useState('contribute'); // default: contribute ('aportar') over 'trade'
  const [bandMode, setBandMode] = useState('swedroe');
  const [contribution, setContribution] = useState(initialContribution || '');
  const [pendingAsset, setPendingAsset] = useState(null); // asset awaiting broker choice (general scope)

  // Espera a las preferencias: sin ellas la divisa caería al defecto.
  useEffect(() => {
    if (user && !prefsLoading) loadData();
  }, [user, selectedBrokerId, prefsLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadData = async () => {
    try {
      setLoading(true);

      // Positions are owned via broker (imports/manual) — same loading rule as
      // the rest of the app, NOT via the first portfolio (the old page missed
      // every broker-owned position).
      const { data: userBrokers, error: brokersError } = await supabase
        .from('brokers').select('id').eq('user_id', user.id);
      if (brokersError) throw brokersError;
      const brokerIds = (userBrokers || [])
        .map(b => b.id)
        .filter(id => selectedBrokerId === 'general' || id === selectedBrokerId);
      if (brokerIds.length === 0) {
        setPositions([]);
        return;
      }

      const { data: positionsData, error: posError } = await supabase
        .from('positions')
        .select('id, quantity, entry_price, target_percentage, assets(ticker, isin, currency, current_price, company_name, asset_class)')
        .in('broker_id', brokerIds);
      if (posError) throw posError;

      // La divisa sale de la fila de preferencias compartida.
      const prefCur = preferredCurrencyOf(userPreferences);

      // Rates BEFORE computing anything that needs them (project rule)
      const currencies = [...new Set((positionsData || [])
        .map(p => p.assets?.currency)
        .filter(c => c && c !== prefCur))];
      const ratePairs = await Promise.all(
        currencies.map(async c => [c, await currencyService.getExchangeRate(c, prefCur)])
      );

      const ratesObj = Object.fromEntries(ratePairs);
      setPreferredCurrency(prefCur);
      setExchangeRates(ratesObj);
      setPositions(positionsData || []);

      // "Invertido" (cost basis) from the SAME source Dashboard/brokers use, so
      // the three screens show the identical figure. Fire-and-forget.
      loadInvested(brokerIds, prefCur, ratesObj, positionsData || []);
    } catch (error) {
      console.error('Error loading rebalance data:', error);
      toast({
        title: t('rebalancing.error_loading'),
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  // Invested = hybrid FIFO/entry cost basis. Fast path: the metrics cache the
  // brokers screen publishes per scope (read verbatim, same as Dashboard).
  // Fallback: recompute with the shared pipeline over the scope's transactions.
  const loadInvested = async (brokerIds, prefCur, ratesObj, heldPositions) => {
    setInvested(null);
    try {
      const { data: cacheRow } = await supabase
        .from('portfolio_metrics_cache')
        .select('currency, metrics')
        .eq('user_id', user.id)
        .eq('scope', selectedBrokerId)
        .maybeSingle();
      if (cacheRow?.currency === prefCur && cacheRow.metrics?.investedHybrid != null) {
        setInvested(cacheRow.metrics.investedHybrid);
        return;
      }
    } catch { /* cache table missing — recompute below */ }

    try {
      const { data: allPos } = await supabase
        .from('positions').select('id').in('broker_id', brokerIds);
      const ids = (allPos || []).map(p => p.id);
      if (ids.length === 0) { setInvested(0); return; }
      const { data: trans } = await supabase
        .from('transactions')
        .select('*, positions(broker_id, assets(currency, ticker, isin))')
        .in('position_id', ids);
      const history = await computeHistoryTotals(trans || [], prefCur, ratesObj);
      setInvested(computeInvestedHybrid(heldPositions || [], history, ratesObj));
    } catch (e) {
      console.warn('[rebalance] invested compute failed:', e.message);
      setInvested(null);
    }
  };

  // A new asset must belong to a broker. In a single-broker scope it's assigned
  // automatically; in "all brokers" scope we ask which broker it'll be bought in.
  const handleAddAsset = (result) => {
    const symbol = result?.symbol;
    if (!symbol) return;
    if (virtualAssets.some(v => v.assets.ticker === symbol)
        || positions.some(p => p.assets?.ticker === symbol)) {
      toast({ title: t('rebalancing.asset_already_added', { ticker: symbol }) });
      return;
    }
    if (selectedBrokerId === 'general') {
      setPendingAsset(result); // opens the broker picker
    } else {
      addVirtualAsset(result, selectedBrokerId);
    }
  };

  // Fetches the live quote for price/currency and the FX rate if needed, then
  // adds the virtual plan row tagged with the chosen broker.
  const addVirtualAsset = async (result, brokerId) => {
    const symbol = result.symbol;
    const brokerName = brokers.find(b => b.id === brokerId)?.name || '';
    try {
      const quote = await marketDataService.getQuote(symbol);
      const currency = quote?.currency || preferredCurrency;
      if (currency !== preferredCurrency && exchangeRates[currency] == null) {
        const rate = await currencyService.getExchangeRate(currency, preferredCurrency);
        setExchangeRates(prev => ({ ...prev, [currency]: rate }));
      }
      setVirtualAssets(prev => [...prev, {
        id: `virtual-${symbol}`,
        quantity: 0,
        entry_price: 0,
        target_percentage: 0,
        isVirtual: true,
        broker_id: brokerId,
        brokerName,
        assets: {
          ticker: symbol,
          isin: result.isin || '',
          currency,
          current_price: quote?.price || 0,
          company_name: quote?.companyName || result.name || symbol,
          asset_class: 'Stock',
        },
      }]);
    } catch (e) {
      toast({ title: t('rebalancing.asset_price_error', { ticker: symbol }), description: e.message, variant: 'destructive' });
    }
  };

  const removeVirtualRow = (row) =>
    setVirtualAssets(prev => prev.filter(v => !row.positionIds.includes(v.id)));

  const virtualBroker = (row) =>
    virtualAssets.find(v => row.positionIds.includes(v.id))?.brokerName;

  // Rebalancing is now the single place to edit the target. Real positions PERSIST
  // to the DB (every broker row of the asset at once) so the figure shows up in
  // Brokers (read-only) and the Dashboard. Virtual rows (assets not held yet) have
  // no DB row → their target stays local to the simulation.
  const saveTarget = async (row, rawValue) => {
    const val = Math.min(100, Math.max(0, parseFloat(String(rawValue).replace(',', '.')) || 0));
    if (val === row.target) return;
    if (row.positionIds.every(id => String(id).startsWith('virtual-'))) {
      setVirtualAssets(prev => prev.map(v =>
        row.positionIds.includes(v.id) ? { ...v, target_percentage: val } : v
      ));
      return;
    }
    setPositions(prev => prev.map(p =>
      row.positionIds.includes(p.id) ? { ...p, target_percentage: val } : p
    ));
    const { error } = await supabase
      .from('positions')
      .update({ target_percentage: val })
      .in('id', row.positionIds);
    if (error) {
      toast({ title: t('rebalancing.error_saving_target'), description: error.message, variant: 'destructive' });
      loadData(); // optimistic value drifted from the DB — reload the truth
    }
  };

  const scrollToUntargeted = () =>
    document.getElementById('rebalance-untargeted')?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  const plan = useMemo(() => buildRebalancePlan([...positions, ...virtualAssets], {
    preferredCurrency,
    exchangeRates,
    bandMode,
    mode,
    contribution: mode === 'contribute' ? parseFloat(contribution) || 0 : 0,
    // Liquidity becomes an editable asset only in the "all brokers" scope.
    cashAsAsset: selectedBrokerId === 'general',
  }), [positions, virtualAssets, preferredCurrency, exchangeRates, bandMode, mode, contribution, selectedBrokerId]);

  const sym = getCurrencySymbol(preferredCurrency);

  const actionBadge = (action) => {
    const styles = {
      BUY:  'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
      SELL: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
      HOLD: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300',
    };
    const Icon = action === 'BUY' ? TrendingUp : action === 'SELL' ? TrendingDown : Minus;
    return (
      <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold ${styles[action]}`}>
        <Icon className="w-3.5 h-3.5" />
        {t(`rebalancing.action_${action.toLowerCase()}`)}
      </span>
    );
  };

  const segBtn = (isActive) =>
    `px-3 py-1.5 rounded-lg text-sm font-medium transition ${
      isActive
        ? 'bg-blue-600 text-white shadow-xs'
        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
    }`;

  return (
    <div className="space-y-6">
      <Helmet>
        <title>{t('rebalancing.page_title')}</title>
        <meta name="description" content={t('rebalancing.meta_desc')} />
      </Helmet>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">{t('rebalancing.title')}</h1>
          <p className="text-slate-600 dark:text-slate-400 mt-1">{t('rebalancing.subtitle')}</p>
        </div>
        <button
          onClick={handleClose}
          className="shrink-0 p-2 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          aria-label={t('common.close')}
          title={t('common.close')}
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* ── Controls ── */}
      <div className="flex flex-wrap items-end gap-4">
        {/* Broker scope */}
        <div>
          <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">
            {t('rebalancing.scope_label')}
          </label>
          <select
            value={selectedBrokerId}
            onChange={(e) => {
              const v = e.target.value;
              setSearchParams(v === 'general' ? {} : { broker: v });
            }}
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white text-sm px-3 py-2"
          >
            <option value="general">{t('rebalancing.scope_all')}</option>
            {brokers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>

        {/* Mode */}
        <div>
          <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">
            {t('rebalancing.mode_label')}
          </label>
          <div className="inline-flex gap-1 p-1 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
            <button className={segBtn(mode === 'contribute')} onClick={() => setMode('contribute')}>
              <PiggyBank className="w-3.5 h-3.5 inline mr-1.5 -mt-0.5" />
              {t('rebalancing.mode_contribute')}
            </button>
            <button className={segBtn(mode === 'trade')} onClick={() => setMode('trade')}>
              <Scale className="w-3.5 h-3.5 inline mr-1.5 -mt-0.5" />
              {t('rebalancing.mode_trade')}
            </button>
          </div>
        </div>

        {/* Contribution amount */}
        {mode === 'contribute' && (
          <div>
            <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">
              {t('rebalancing.contribution_label', { currency: preferredCurrency })}
            </label>
            <input
              type="number"
              min="0"
              step="50"
              value={contribution}
              onChange={(e) => setContribution(e.target.value)}
              placeholder={t('rebalancing.contribution_placeholder')}
              className="w-36 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white text-sm px-3 py-2"
            />
          </div>
        )}

        {/* Tolerance band (trade mode only) — each option carries an (i) tooltip */}
        {mode === 'trade' && (
          <div>
            <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">
              {t('rebalancing.band_label')}
            </label>
            <div className="inline-flex gap-1 p-1 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
              {BAND_MODES.map(m => (
                <button key={m} onClick={() => setBandMode(m)} className={segBtn(bandMode === m)}>
                  {t(`rebalancing.band_${m}`)}
                  <InfoTip text={t(`rebalancing.band_${m}_info`)} />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Add a new asset (not held yet) to plan a first purchase */}
        <AddAssetControl onSelect={handleAddAsset} />
      </div>

      {/* ── Summary + warnings ── */}
      {!loading && (plan.rows.length > 0 || plan.untargetedRows.length > 0) && (
        <div className="flex flex-wrap gap-3 text-sm">
          <span className="px-3 py-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300">
            {t('rebalancing.total_value')}: <strong>{sym}{formatNumber(plan.totalCurrent, 2, 2)}</strong>
          </span>
          {invested != null && (
            <span className="px-3 py-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300">
              {t('rebalancing.invested')}: <strong>{sym}{formatNumber(invested, 2, 2)}</strong>
            </span>
          )}
          {plan.cashValue !== 0 && (
            <span className={`px-3 py-1.5 rounded-lg border ${plan.cashValue < 0
              ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800/40 text-amber-700 dark:text-amber-300'
              : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300'}`}>
              {plan.cashValue < 0 ? t('cartera.margin_used') : t('rebalancing.cash_value')}: <strong>{sym}{formatNumber(Math.abs(plan.cashValue), 2, 2)}</strong>
            </span>
          )}
          {plan.rows.length > 0 && (() => {
            const sum = plan.targetSum;
            const near100 = Math.abs(sum - 100) <= 1;
            const over = sum > 100;
            const cls = near100
              ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800/40 text-emerald-700 dark:text-emerald-300'
              : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800/40 text-amber-700 dark:text-amber-300';
            const state = near100 ? t('rebalancing.targets_sum_ok')
              : over ? t('rebalancing.targets_sum_over', { diff: formatNumber(sum - 100, 0, 1) })
              : t('rebalancing.targets_sum_under', { diff: formatNumber(100 - sum, 0, 1) });
            return (
              <span className={`px-3 py-1.5 rounded-lg border ${cls}`}>
                {t('rebalancing.targets_sum_total')}: <strong>{formatNumber(sum, 0, 1)}%</strong> · {state}
              </span>
            );
          })()}
          {plan.untargetedCount > 0 && (
            <span className="px-3 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400">
              {t('rebalancing.untargeted_hint', { count: plan.untargetedCount })}{' '}
              <button onClick={scrollToUntargeted} className="text-blue-600 dark:text-blue-400 hover:underline font-medium">
                {t('rebalancing.set_targets_link')}
              </button>
            </span>
          )}
        </div>
      )}

      <p className="text-xs text-slate-400 dark:text-slate-500">{t('rebalancing.sandbox_note')}</p>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600" />
        </div>
      ) : plan.rows.length === 0 && plan.untargetedRows.length === 0 ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="bg-white dark:bg-slate-800 rounded-xl shadow-xs border border-slate-200 dark:border-slate-700 p-12 text-center space-y-2"
        >
          <p className="text-slate-600 dark:text-slate-400">{t('rebalancing.empty')}</p>
          <p className="text-sm text-slate-500 dark:text-slate-500">
            {t('rebalancing.empty_hint')}{' '}
            <Link to="/app/brokers" className="text-blue-600 dark:text-blue-400 hover:underline font-medium">
              {t('rebalancing.set_targets_link')}
            </Link>
          </p>
        </motion.div>
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="bg-white dark:bg-slate-800 rounded-xl shadow-xs border border-slate-200 dark:border-slate-700 overflow-hidden"
        >
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 dark:bg-slate-900/50 border-b border-slate-200 dark:border-slate-700">
                <tr>
                  <th className="text-left px-6 py-4 text-sm font-semibold text-slate-700 dark:text-slate-300">{t('rebalancing.col_asset')}</th>
                  <th className="text-right px-6 py-4 text-sm font-semibold text-slate-700 dark:text-slate-300">{t('rebalancing.col_current')}</th>
                  <th className="text-right px-6 py-4 text-sm font-semibold text-slate-700 dark:text-slate-300">{t('rebalancing.col_target')}</th>
                  <th className="text-right px-6 py-4 text-sm font-semibold text-slate-700 dark:text-slate-300">{t('rebalancing.col_difference')}</th>
                  <th className="text-center px-6 py-4 text-sm font-semibold text-slate-700 dark:text-slate-300">{t('rebalancing.col_status')}</th>
                  <th className="text-right px-6 py-4 text-sm font-semibold text-slate-700 dark:text-slate-300">
                    {mode === 'contribute' ? t('rebalancing.col_contribute') : t('rebalancing.col_amount')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                {plan.rows.map((row) => (
                  <tr key={row.key} className="hover:bg-slate-50 dark:hover:bg-slate-700/50 transition">
                    <td className="px-6 py-4">
                      {/* Nombre en grande; ISIN/ticker debajo (sin repetir si son lo mismo) */}
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-slate-900 dark:text-white">{row.name || row.ticker}</p>
                        {row.isVirtual && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 rounded-full px-2 py-0.5">
                            <Sparkles className="w-2.5 h-2.5" />{t('rebalancing.new_asset_badge')}
                          </span>
                        )}
                        {row.isVirtual && (
                          <button
                            onClick={() => removeVirtualRow(row)}
                            className="p-1 rounded text-slate-400 hover:text-rose-500 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                            aria-label={t('rebalancing.remove_asset')}
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                      {(row.isin || row.ticker) && (row.isin || row.ticker) !== (row.name || row.ticker) && (
                        <p className="text-sm text-slate-600 dark:text-slate-400">{row.isin || row.ticker}</p>
                      )}
                      {row.isVirtual && virtualBroker(row) && (
                        <p className="text-xs text-blue-500 dark:text-blue-400">{t('rebalancing.asset_on_broker', { broker: virtualBroker(row) })}</p>
                      )}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <span className="font-medium text-slate-900 dark:text-white">{formatNumber(row.currentWeight, 2, 2)}%</span>
                      <p className="text-xs text-slate-500 dark:text-slate-500">{sym}{formatNumber(row.value, 2, 2)}</p>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <TargetInput row={row} label={t('rebalancing.col_target')} onSave={saveTarget} />
                    </td>
                    <td className="px-6 py-4 text-right">
                      <span className={`font-medium ${
                        row.drift > row.band ? 'text-red-600 dark:text-red-400' :
                        row.drift < -row.band ? 'text-green-600 dark:text-green-400' :
                        'text-slate-600 dark:text-slate-400'
                      }`}>
                        {row.drift > 0 ? '+' : ''}{formatNumber(row.drift, 2, 2)}pp
                      </span>
                    </td>
                    <td className="px-6 py-4 text-center">{actionBadge(row.action)}</td>
                    <td className="px-6 py-4 text-right">
                      {row.amount > 0.005 ? (
                        <>
                          <p className="font-semibold text-slate-900 dark:text-white">{sym}{formatNumber(row.amount, 2, 2)}</p>
                          {!row.isCash && (
                            <p className="text-xs text-slate-500 dark:text-slate-500">
                              {t('rebalancing.approx_qty', { qty: formatNumber(row.tradeQty, 2, 4), ticker: row.ticker })}
                            </p>
                          )}
                        </>
                      ) : (
                        <span className="text-slate-400 dark:text-slate-600">—</span>
                      )}
                    </td>
                  </tr>
                ))}

                {/* Activos sin target: fuera del plan, pero editables desde aquí */}
                {plan.untargetedRows.length > 0 && (
                  <>
                    <tr id="rebalance-untargeted" className="bg-slate-50 dark:bg-slate-900/40 scroll-mt-20">
                      <td colSpan={6} className="px-6 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                        {t('rebalancing.untargeted_section')}
                      </td>
                    </tr>
                    {plan.untargetedRows.map((row) => (
                      <tr key={row.key} className="hover:bg-slate-50 dark:hover:bg-slate-700/50 transition">
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2">
                            <p className="font-semibold text-slate-900 dark:text-white">{row.isCash ? t('rebalancing.cash_value') : (row.name || row.ticker)}</p>
                            {row.isVirtual && (
                              <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 rounded-full px-2 py-0.5">
                                <Sparkles className="w-2.5 h-2.5" />{t('rebalancing.new_asset_badge')}
                              </span>
                            )}
                            {row.isVirtual && (
                              <button
                                onClick={() => removeVirtualRow(row)}
                                className="p-1 rounded text-slate-400 hover:text-rose-500 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                                aria-label={t('rebalancing.remove_asset')}
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                          {(row.isin || row.ticker) && (row.isin || row.ticker) !== (row.name || row.ticker) && (
                            <p className="text-sm text-slate-600 dark:text-slate-400">{row.isin || row.ticker}</p>
                          )}
                          {row.isVirtual && virtualBroker(row) && (
                            <p className="text-xs text-blue-500 dark:text-blue-400">{t('rebalancing.asset_on_broker', { broker: virtualBroker(row) })}</p>
                          )}
                        </td>
                        <td className="px-6 py-4 text-right">
                          <span className="font-medium text-slate-900 dark:text-white">{formatNumber(row.currentWeight, 2, 2)}%</span>
                          <p className="text-xs text-slate-500 dark:text-slate-500">{sym}{formatNumber(row.value, 2, 2)}</p>
                        </td>
                        <td className="px-6 py-4 text-right">
                          <TargetInput row={row} label={t('rebalancing.col_target')} onSave={saveTarget} />
                        </td>
                        <td className="px-6 py-4 text-right"><span className="text-slate-400 dark:text-slate-600">—</span></td>
                        <td className="px-6 py-4 text-center"><span className="text-slate-400 dark:text-slate-600">—</span></td>
                        <td className="px-6 py-4 text-right"><span className="text-slate-400 dark:text-slate-600">—</span></td>
                      </tr>
                    ))}
                  </>
                )}
              </tbody>
            </table>
          </div>
          <p className="px-6 py-3 text-xs text-slate-500 dark:text-slate-500 border-t border-slate-200 dark:border-slate-700">
            {mode === 'contribute' ? t('rebalancing.contribute_footnote') : t('rebalancing.trade_footnote')}
          </p>
        </motion.div>
      )}

      {/* Broker picker — shown when adding an asset in "all brokers" scope */}
      <Dialog open={!!pendingAsset} onOpenChange={(open) => { if (!open) setPendingAsset(null); }}>
        <DialogContent className="max-w-sm dark:bg-slate-900 border-none">
          <DialogHeader>
            <DialogTitle className="dark:text-white">{t('rebalancing.pick_broker_title')}</DialogTitle>
            <DialogDescription>{t('rebalancing.pick_broker_desc', { ticker: pendingAsset?.symbol || '' })}</DialogDescription>
          </DialogHeader>
          <div className="py-2 space-y-2 max-h-[50vh] overflow-y-auto">
            {brokers.map(b => (
              <button
                key={b.id}
                onClick={() => { const a = pendingAsset; setPendingAsset(null); addVirtualAsset(a, b.id); }}
                className="w-full text-left px-4 py-3 rounded-lg border border-slate-200 dark:border-slate-700 hover:border-blue-400 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors text-sm font-semibold text-slate-900 dark:text-white"
              >
                {b.name}
              </button>
            ))}
            {brokers.length === 0 && (
              <p className="text-sm text-slate-500 dark:text-slate-400 px-1">{t('rebalancing.empty_hint')}</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default RebalancingCalculator;
