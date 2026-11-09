import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import {
  X, Share2, Copy, Check, Trash2, Link,
  Eye, EyeOff, ChevronDown, Plus, ExternalLink,
  MessageCircle, Twitter, Send, Instagram,
} from 'lucide-react';
import { supabase } from '@/lib/customSupabaseClient';
import { useSupabaseAuth } from '@/contexts/SupabaseAuthContext';
import { useToast } from '@/components/ui/use-toast';
import { samplePerformanceWeekly } from '@/lib/sharePerformance';
import { shareScopeMatches } from '@/lib/shareScope';
import { firstInvestedDate, annualizeReturn } from '@/services/performanceService';
import { isCashPosition } from '@/lib/positionKind';

const EXPIRY_OPTIONS = [
  { key: 'never', days: null },
  { key: '7d',    days: 7   },
  { key: '30d',   days: 30  },
  { key: '90d',   days: 90  },
  { key: '1y',    days: 365 },
];

const DEFAULT_CONFIG = {
  show_values:      true,
  show_pnl:         true,
  show_cost_basis:  false,
  show_chart:       true,
  // Ventas realizadas: opt-in y APAGADO por defecto. Es historial operativo
  // (qué vendiste, cuándo y a cuánto), bastante más revelador que una foto de
  // la cartera, así que se enseña solo si el dueño lo pide.
  show_realized_sales: false,
  show_broker_names: false,
};

// Compute snapshot data from current Dashboard state
export function buildSnapshotData(positions, exchangeRates, config, selectedBrokerIds) {
  const brokerFilter = selectedBrokerIds.length > 0
    ? new Set(selectedBrokerIds)
    : null;

  const invested = positions.filter((p) => {
    if (isCashPosition(p)) return false;
    if (brokerFilter && !brokerFilter.has(p.broker_id)) return false;
    return p.quantity > 0.0001;
  });

  // exchangeRates[cur] = getExchangeRate(cur, preferredCurrency) = "X preferred per 1 cur"
  // eurBase = exchangeRates['EUR'] = "X preferred per 1 EUR" (= 1 when preferred is EUR)
  // toEur(val, cur): convert native value → EUR = val × (rates[cur] / eurBase)
  const eurBase = exchangeRates?.['EUR'] ?? 1;
  const toEur = (val, cur) => {
    const r = exchangeRates?.[cur] ?? exchangeRates?.[(cur||'').toUpperCase()] ?? 1;
    return eurBase === 0 ? 0 : (val * r) / eurBase;
  };
  let totalEurValue = 0;
  const posRows = invested.map((p) => {
    const price    = p.current_price ?? p.assets?.current_price ?? 0;
    const currency = p.assets?.currency || 'USD';
    const nativeValue = p.quantity * price;
    const eurValue    = toEur(nativeValue, currency);
    // value for display: in native currency (SharedPortfolioPage converts it using rates)
    totalEurValue += eurValue;
    return {
      ticker:       p.assets?.ticker || '',
      name:         p.assets?.name   || p.assets?.ticker || '',
      quantity:     p.quantity,
      current_price: config.show_values    ? price  : null,
      currency,
      value:         config.show_values    ? nativeValue : null,
      entry_price:   config.show_cost_basis ? (p.entry_price ?? 0) : null,
      pnl:           config.show_pnl && p.entry_price > 0
                       ? toEur((price - p.entry_price) * p.quantity, currency) : null,
      pnl_pct:       config.show_pnl && p.entry_price > 0
                       ? ((price - p.entry_price) / p.entry_price) * 100 : null,
      broker_name:   config.show_broker_names ? (p.broker_name ?? null) : null,
      _eurValue:     eurValue,
      weight:        0,
    };
  });

  // Always compute weights from EUR values (correct for multi-currency)
  for (const p of posRows) {
    p.weight = totalEurValue > 0 ? (p._eurValue / totalEurValue) * 100 : 0;
    delete p._eurValue;
  }

  posRows.sort((a, b) => b.weight - a.weight);

  // Compute metrics from positions (all in EUR)
  // For snapshot mode, historical data (realized P&L, dividends, fees) is not available —
  // the live mode server endpoint computes those from transaction history.
  const mvEur  = totalEurValue;
  const oiEur  = invested.reduce((sum, p) => {
    const currency = p.assets?.currency || 'USD';
    return sum + toEur((p.entry_price ?? 0) * p.quantity, currency);
  }, 0);
  const unrEur = mvEur - oiEur;
  const roiCartera = config.show_pnl && oiEur > 0 ? +(unrEur / oiEur * 100).toFixed(2) : null;
  // Snapshot has no historical data so roi_simple = roi_cartera in this context.
  // The live endpoint will replace this with FIFO-accurate values from cached_metrics.
  const roiSimple  = roiCartera;
  const snapshotMetrics = {
    market_value_eur:   config.show_values ? +mvEur.toFixed(2)  : null,
    open_invested_eur:  config.show_values ? +oiEur.toFixed(2)  : null,
    unrealized_pnl_eur: config.show_pnl   ? +unrEur.toFixed(2) : null,
    realized_pnl_eur:   null,
    dividends_eur:      null,
    fees_eur:           null,
    total_buy_cost_eur: config.show_values ? +oiEur.toFixed(2)  : null,
    total_gain_eur:     config.show_pnl   ? +unrEur.toFixed(2) : null,
    roi_simple:         roiSimple,
    roi_cartera:        roiCartera,
    annualized_return:  null,
    first_trade_date:   null,
  };

  // EUR-based rates for SharedPortfolioPage currency selector: "1 EUR = X cur"
  // eurRates[cur] = eurBase / exchangeRates[cur]
  const rates = { EUR: 1 };
  for (const [cur, r] of Object.entries(exchangeRates || {})) {
    if (r && r > 0) rates[cur] = +(eurBase / r).toFixed(6);
  }

  return {
    positions:   posRows,
    total_value: config.show_values ? +(totalEurValue.toFixed(2)) : null,
    currency:    'EUR',
    is_mixed_currency: new Set(invested.map(p => p.assets?.currency).filter(Boolean)).size > 1,
    rates,
    metrics:     snapshotMetrics,
    updated_at:  new Date().toISOString(),
  };
}

// Convert Dashboard metrics (in preferredCurrency) → EUR for server-side caching.
// exchangeRates[cur] = getExchangeRate(cur, preferredCurrency) = "X preferred per 1 cur"
// eurBase = exchangeRates['EUR'] = "X preferred per 1 EUR" (1 when preferred is EUR)
function buildCachedMetrics(dm, exchangeRates, config) {
  const eurBase = exchangeRates?.['EUR'] ?? 1;
  const toEur   = (v) => v == null ? null : +(v / eurBase).toFixed(2);

  const mvEur  = toEur(dm.marketValue);
  const oiEur  = toEur(dm.openInvested);
  const unrEur = toEur(dm.unrealizedPnl);
  const rlzEur = toEur(dm.realizedPnl);
  const divEur = toEur(dm.dividends);
  const feeEur = toEur(dm.fees);
  const bcEur  = toEur(dm.totalBuyCost);
  const tgEur  = unrEur != null
    ? +((unrEur||0) + (rlzEur||0) + (divEur||0) - (feeEur||0)).toFixed(2)
    : null;

  // Prefer pre-computed roiSimple from Dashboard (same value the app shows).
  // Falls back to recomputing from EUR components when not provided.
  const roiSimple  = dm.roiSimple != null
    ? +dm.roiSimple.toFixed(2)
    : (bcEur > 0 && tgEur != null ? +(tgEur / bcEur * 100).toFixed(2) : null);
  const roiCartera = oiEur > 0 && unrEur != null ? +(unrEur / oiEur * 100).toFixed(2) : null;

  // CAGR from roi_simple and first-transaction start date.
  // TWR (true time-weighted) is computed inside PortfolioGrowthChart and is not
  // available here, so we omit it rather than store an inaccurate proxy.
  // Sin serie aquí no se puede saber el primer día INVERTIDO, así que esta
  // ventana sigue arrancando en la primera transacción; es el peor caso y solo
  // se usa si no hay serie que la sobrescriba (ver el bloque de `cachedMetrics.twr`).
  const annualized = annualizeReturn(roiSimple, dm.portfolioStartDate);
  const annualizedReturn = annualized == null ? null : +annualized.toFixed(2);

  return {
    market_value_eur:   config.show_values ? mvEur  : null,
    open_invested_eur:  config.show_values ? oiEur  : null,
    unrealized_pnl_eur: config.show_pnl   ? unrEur : null,
    realized_pnl_eur:   config.show_pnl   ? rlzEur : null,
    dividends_eur:      config.show_pnl   ? divEur : null,
    fees_eur:           config.show_pnl   ? feeEur : null,
    total_buy_cost_eur: config.show_values ? bcEur  : null,
    total_gain_eur:     config.show_pnl   ? tgEur  : null,
    roi_simple:         config.show_pnl   ? roiSimple        : null,
    roi_cartera:        config.show_pnl   ? roiCartera       : null,
    annualized_return:  config.show_pnl   ? annualizedReturn : null,
    twr:                null,
    first_trade_date:   dm.portfolioStartDate ?? null,
    has_history:        (rlzEur != null || divEur != null || bcEur != null),
  };
}

export default function SharePortfolioModal({
  open,
  onClose,
  positions = [],
  brokers = [],
  exchangeRates = {},
  performanceData = [],     // TTWROR daily series from PortfolioGrowthChart
  dashboardMetrics = null,  // pre-computed metrics from Dashboard (in preferredCurrency)
  metricsScope = 'general', // ÁMBITO de performanceData/dashboardMetrics: 'general' o un broker id
}) {
  const { t } = useTranslation();
  const { user } = useSupabaseAuth();
  const { toast } = useToast();

  const [tab, setTab] = useState('create'); // 'create' | 'manage'

  // Create form state
  const [label, setLabel]           = useState('');
  const [mode, setMode]             = useState('live');
  const [selectedBrokers, setSelectedBrokers] = useState([]);
  const [config, setConfig]         = useState({ ...DEFAULT_CONFIG });
  const [expiryKey, setExpiryKey]   = useState('never');
  const [creating, setCreating]     = useState(false);
  const [createdToken, setCreatedToken] = useState(null);
  const [copiedToken, setCopiedToken]   = useState(false);

  // Manage tab state
  const [shares, setShares]         = useState([]);
  const [loadingShares, setLoadingShares] = useState(false);
  const [revokeId, setRevokeId]     = useState(null);
  const [revoking, setRevoking]     = useState(false);

  // Reset on open. La selección arranca en el MISMO ámbito del que vienen la
  // serie y las métricas (el filtro de broker del Dashboard), no en "todos":
  // con el Dashboard filtrado a un broker, el default anterior creaba un share
  // de toda la cartera cuyo gráfico y anualizada eran los de ese broker suelto.
  useEffect(() => {
    if (open) {
      setTab('create');
      setLabel('');
      setMode('live');
      // Si el ámbito apunta a un broker que ya no existe (localStorage rancio),
      // se cae a "todos" en vez de dejar la selección vacía — que desactivaría
      // el botón de crear sin decir por qué.
      const scoped = brokers.filter((b) => b.id === metricsScope).map((b) => b.id);
      setSelectedBrokers(scoped.length ? scoped : brokers.map((b) => b.id));
      setConfig({ ...DEFAULT_CONFIG });
      setExpiryKey('never');
      setCreatedToken(null);
      loadShares();
    }
  }, [open, brokers, metricsScope]);

  // Un fallo aquí pintaba "no tienes enlaces" — indistinguible de no tener
  // ninguno, y desde esa pantalla vacía no hay forma de revocar los que sí
  // existen. Se avisa y se deja la lista como estaba.
  async function loadShares() {
    setLoadingShares(true);
    const { data, error } = await supabase
      .from('portfolio_shares')
      .select('id, label, mode, config, broker_ids, expires_at, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });
    if (error) {
      toast({ variant: 'destructive', title: t('share.load_failed'), description: error.message });
    } else {
      setShares(data || []);
    }
    setLoadingShares(false);
  }

  // ¿La selección cubre el mismo ámbito del que vienen serie y métricas?
  // La decisión es pura y vive en lib/shareScope.js con sus tests.
  const scopeMatches = shareScopeMatches(
    metricsScope,
    selectedBrokers,
    brokers.map((b) => b.id)
  );

  function toggleBroker(id) {
    setSelectedBrokers((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  function toggleConfig(key) {
    setConfig((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  async function handleCreate() {
    if (!user) return;
    setCreating(true);
    try {
      const optionDays = EXPIRY_OPTIONS.find((o) => o.key === expiryKey)?.days ?? null;
      const expiresAt = optionDays
        ? new Date(Date.now() + optionDays * 86400 * 1000).toISOString()
        : null;

      const allBrokerIds = brokers.map((b) => b.id);
      const brokerIds =
        selectedBrokers.length === allBrokerIds.length || selectedBrokers.length === 0
          ? null
          : selectedBrokers;

      const snapshotData =
        mode === 'snapshot'
          ? buildSnapshotData(positions, exchangeRates, config, selectedBrokers)
          : null;

      // Serie y métricas SOLO cuando el ámbito coincide (ver `scopeMatches`):
      // el server recalcula posiciones y totales frescos de la BD, pero `twr` y
      // la anualizada que sale de él viajan tal cual desde aquí. Antes que
      // enseñar la curva de un broker sobre las posiciones de toda la cartera,
      // el share va sin gráfico y el server anualiza el ROI simple.
      const cachedMetrics = (dashboardMetrics && scopeMatches)
        ? buildCachedMetrics(dashboardMetrics, exchangeRates, config)
        : null;
      const sampledPerf = scopeMatches ? samplePerformanceWeekly(performanceData) : [];

      // Cache the cumulative TWR (last point of the TTWROR series) so the live endpoint
      // can annualize it — same basis as the brokers screen's "Rentabilidad Anualizada".
      if (cachedMetrics && config.show_pnl && sampledPerf.length) {
        const twr = sampledPerf[sampledPerf.length - 1].pct;
        cachedMetrics.twr = twr;
        // El primer día INVERTIDO, no el primer apunte: `portfolioStartDate` es la
        // transacción más antigua de cualquier tipo, así que un ingreso de efectivo
        // previo a la primera compra alargaba la ventana y hundía la anualizada.
        // Se guarda en el cache para que el endpoint del share anualice sobre la
        // MISMA ventana que la pantalla de brokers (los shares antiguos no lo
        // traen y el server cae a first_trade_date, como hasta ahora).
        const investedSince = firstInvestedDate(performanceData) || dashboardMetrics?.portfolioStartDate || null;
        cachedMetrics.invested_since = investedSince;
        const annualized = annualizeReturn(twr, investedSince);
        if (annualized != null) cachedMetrics.annualized_return = +annualized.toFixed(2);
      }

      const { data, error } = await supabase
        .from('portfolio_shares')
        .insert({
          user_id:          user.id,
          label:            label.trim() || null,
          mode,
          broker_ids:       brokerIds,
          config,
          expires_at:       expiresAt,
          snapshot_data:    snapshotData,
          cached_metrics:   cachedMetrics,
          // Con el gráfico apagado la serie NO se guarda: así no existe ni en la
          // BD ni en la respuesta pública, en vez de depender de que la página
          // se acuerde de no pintarla. El `twr` ya se extrajo arriba, o sea que
          // la rentabilidad anualizada sigue funcionando sin la serie.
          performance_data: (config.show_chart && sampledPerf.length) ? sampledPerf : null,
        })
        .select('id')
        .single();

      if (error) throw error;
      setCreatedToken(data.id);
      loadShares();
    } catch (e) {
      toast({ variant: 'destructive', title: t('common.error'), description: e.message });
    } finally {
      setCreating(false);
    }
  }

  function shareUrl(token) {
    return `${window.location.origin}/share/${token}`;
  }

  async function copyLink(token) {
    await navigator.clipboard.writeText(shareUrl(token));
    setCopiedToken(token);
    toast({ title: t('share.link_copied') });
    setTimeout(() => setCopiedToken(null), 2000);
  }

  // Social channels. Instagram has no web share-by-URL API, so we copy the link
  // to the clipboard and prompt the user to paste it into a story/bio.
  const SOCIAL_CHANNELS = [
    { key: 'whatsapp',  Icon: MessageCircle, label: 'WhatsApp',  cls: 'bg-[#25D366] hover:bg-[#1fb259]' },
    { key: 'twitter',   Icon: Twitter,       label: 'X',         cls: 'bg-slate-900 hover:bg-slate-700 dark:bg-slate-700 dark:hover:bg-slate-600' },
    { key: 'telegram',  Icon: Send,          label: 'Telegram',  cls: 'bg-[#0088cc] hover:bg-[#0077b3]' },
    { key: 'instagram', Icon: Instagram,     label: 'Instagram', cls: 'bg-linear-to-br from-[#feda75] via-[#d62976] to-[#4f5bd5] hover:opacity-90' },
  ];

  async function shareToSocial(network, token) {
    const url  = shareUrl(token);
    const text = t('share.social_text');
    const encUrl  = encodeURIComponent(url);
    const encText = encodeURIComponent(text);
    let target;
    switch (network) {
      case 'whatsapp':
        target = `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`;
        break;
      case 'twitter':
        target = `https://twitter.com/intent/tweet?text=${encText}&url=${encUrl}`;
        break;
      case 'telegram':
        target = `https://t.me/share/url?url=${encUrl}&text=${encText}`;
        break;
      case 'instagram':
        await navigator.clipboard.writeText(url);
        toast({ title: t('share.instagram_copied') });
        return;
      default:
        return;
    }
    window.open(target, '_blank', 'noopener,noreferrer');
  }

  // Native OS share sheet (mobile mainly). Falls back to copying the link.
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  async function nativeShare(token) {
    try {
      await navigator.share({
        title: t('share.social_title'),
        text:  t('share.social_text'),
        url:   shareUrl(token),
      });
    } catch (e) {
      // User dismissed the sheet — not an error worth surfacing.
      if (e?.name !== 'AbortError') copyLink(token);
    }
  }

  // Revocar es el freno de emergencia de esta feature: si el DELETE falla, el
  // enlace SIGUE VIVO. Antes se quitaba de la lista y se cantaba "revocado"
  // pasara lo que pasara — y al desaparecer de Gestionar ya no había ninguna
  // pantalla desde la que volver a intentarlo. Ahora el borrado se confirma
  // contra la BD (`select()` devuelve las filas realmente borradas) y la fila
  // solo desaparece de la lista cuando se ha ido de verdad.
  async function revokeShare(id) {
    setRevoking(true);
    try {
      const { data, error } = await supabase
        .from('portfolio_shares')
        .delete()
        .eq('id', id)
        .eq('user_id', user.id)
        .select('id');
      if (error) throw error;
      // Cero filas borradas = la fila sigue ahí (RLS, id que ya no existe…).
      // No es un éxito silencioso: el enlace continúa sirviendo datos.
      if (!data?.length) throw new Error(t('share.revoke_not_deleted'));
      setShares((prev) => prev.filter((s) => s.id !== id));
      setRevokeId(null);
      toast({ title: t('share.revoke_done') });
    } catch (e) {
      toast({
        variant: 'destructive',
        title: t('share.revoke_failed'),
        description: `${e.message} — ${t('share.revoke_failed_hint')}`,
      });
      loadShares();
    } finally {
      setRevoking(false);
    }
  }

  function isExpired(expiresAt) {
    return expiresAt && new Date(expiresAt) < new Date();
  }

  // Modal propio (no Radix): Escape no lo cerraba. Si hay un desplegable de
  // Radix abierto dentro (caducidad), Escape es suyo.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[data-radix-popper-content-wrapper]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <AnimatePresence>
      {/* Los dos hijos directos del AnimatePresence necesitan key: sin ellas
          ambos llegaban con key `undefined` y React avisaba de claves
          duplicadas en cada render del modal. */}
      <div
        key="share-root"
        className="fixed inset-0 z-200 flex items-center justify-center p-4"
        onClick={(e) => e.target === e.currentTarget && onClose()}
      >
        {/* Backdrop */}
        <motion.div
          key="share-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 bg-black/50 backdrop-blur-xs"
          onClick={onClose}
        />

        {/* Modal */}
        <motion.div
          key="share-modal"
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          transition={{ duration: 0.2 }}
          className="relative w-full max-w-lg max-h-[90vh] bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden flex flex-col"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="share-modal-title"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-slate-100 dark:border-slate-800 shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-blue-500/10 flex items-center justify-center">
                <Share2 className="w-4 h-4 text-blue-500" />
              </div>
              <div>
                <p id="share-modal-title" className="text-sm font-bold text-slate-900 dark:text-white leading-none">
                  {t('share.modal_title')}
                </p>
                <p className="text-[11px] text-slate-500 mt-0.5">{t('share.modal_subtitle')}</p>
              </div>
            </div>
            <button
              onClick={onClose}
              aria-label={t('common.close')}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-slate-100 dark:border-slate-800 shrink-0">
            {[
              { key: 'create', label: t('share.tab_create'), icon: Plus },
              { key: 'manage', label: t('share.tab_manage'), icon: Link },
            ].map(({ key, label: lbl, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`flex items-center gap-1.5 px-5 py-3 text-xs font-bold border-b-2 transition-colors ${
                  tab === key
                    ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                    : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {lbl}
                {key === 'manage' && shares.length > 0 && (
                  <span className="ml-1 px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 text-[10px]">
                    {shares.length}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto">
            {/* ── Create tab ── */}
            {tab === 'create' && (
              <div className="p-5 space-y-5">
                {createdToken ? (
                  /* Success state */
                  <div className="space-y-4">
                    <div className="flex flex-col items-center gap-2 py-4">
                      <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 flex items-center justify-center">
                        <Check className="w-6 h-6 text-emerald-500" />
                      </div>
                      <p className="text-sm font-bold text-slate-900 dark:text-white">
                        {t('share.link_created')}
                      </p>
                    </div>

                    <div className="flex items-center gap-2 p-3 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                      <p className="flex-1 text-xs font-mono text-slate-700 dark:text-slate-300 truncate">
                        {shareUrl(createdToken)}
                      </p>
                      <button
                        onClick={() => copyLink(createdToken)}
                        className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-blue-500 hover:bg-blue-400 text-white text-[11px] font-bold transition-colors"
                      >
                        {copiedToken === createdToken
                          ? <Check className="w-3 h-3" />
                          : <Copy className="w-3 h-3" />}
                        {t('share.copy_link')}
                      </button>
                    </div>

                    <a
                      href={shareUrl(createdToken)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-center gap-1.5 w-full py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      {t('share.preview_link')}
                    </a>

                    {/* Social share */}
                    <div className="space-y-2 pt-1">
                      {canNativeShare && (
                        <button
                          onClick={() => nativeShare(createdToken)}
                          className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl bg-blue-500 hover:bg-blue-400 text-white text-sm font-bold transition-colors"
                        >
                          <Share2 className="w-4 h-4" />
                          {t('share.native_share')}
                        </button>
                      )}
                      <p className="text-[11px] font-bold text-slate-500 text-center">
                        {t('share.share_on')}
                      </p>
                      <div className="flex items-center justify-center gap-2.5">
                        {SOCIAL_CHANNELS.map(({ key, Icon, label, cls }) => (
                          <button
                            key={key}
                            onClick={() => shareToSocial(key, createdToken)}
                            title={label}
                            aria-label={t('share.share_on_network', { network: label })}
                            className={`flex items-center justify-center w-10 h-10 rounded-xl text-white transition-all ${cls}`}
                          >
                            <Icon className="w-4 h-4" />
                          </button>
                        ))}
                      </div>
                    </div>

                    <button
                      onClick={() => setCreatedToken(null)}
                      className="w-full py-2 rounded-xl border border-dashed border-slate-200 dark:border-slate-700 text-slate-500 text-xs hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                    >
                      {t('share.create_another')}
                    </button>
                  </div>
                ) : (
                  /* Form */
                  <>
                    {/* Label */}
                    <div>
                      <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                        {t('share.label_field')}
                      </label>
                      <input
                        type="text"
                        value={label}
                        onChange={(e) => setLabel(e.target.value)}
                        placeholder={t('share.label_placeholder')}
                        maxLength={60}
                        className="w-full px-3 py-2 rounded-xl text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-hidden focus:ring-2 focus:ring-blue-500"
                      />
                    </div>


                    {/* Brokers */}
                    {brokers.length > 1 && (
                      <div>
                        <p className="text-xs font-bold text-slate-700 dark:text-slate-300 mb-2">
                          {t('share.brokers_label')}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {brokers.map((b) => (
                            <button
                              key={b.id}
                              onClick={() => toggleBroker(b.id)}
                              className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                                selectedBrokers.includes(b.id)
                                  ? 'border-blue-500 bg-blue-500 text-white'
                                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-blue-300'
                              }`}
                            >
                              {b.name}
                            </button>
                          ))}
                        </div>
                        {/* El gráfico y la anualizada vienen del ámbito que el
                            Dashboard tenía cargado; si la selección se sale de
                            ahí se omiten en vez de enseñar los de otra cartera. */}
                        {!scopeMatches && selectedBrokers.length > 0 && (
                          <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400 leading-snug">
                            {t('share.scope_mismatch_hint')}
                          </p>
                        )}
                      </div>
                    )}

                    {/* Privacy toggles */}
                    <div>
                      <p className="text-xs font-bold text-slate-700 dark:text-slate-300 mb-2">
                        {t('share.privacy_label')}
                      </p>
                      <div className="space-y-1">
                        {[
                          { key: 'show_values',         labelKey: 'show_values'         },
                          { key: 'show_pnl',            labelKey: 'show_pnl'            },
                          { key: 'show_cost_basis',     labelKey: 'show_cost_basis'     },
                          // Las ventas realizadas SON resultado: el server las
                          // sirve solo con `show_pnl` activo, así que el
                          // interruptor se apaga con él en vez de quedarse
                          // encendido sin efecto.
                          { key: 'show_realized_sales', labelKey: 'show_realized_sales', dependsOn: 'show_pnl' },
                          { key: 'show_chart',          labelKey: 'show_chart'          },
                          { key: 'show_broker_names',   labelKey: 'show_broker_names'   },
                        ].map(({ key, labelKey, dependsOn }) => {
                          const blocked = dependsOn ? !config[dependsOn] : false;
                          const on = config[key] && !blocked;
                          return (
                            <div
                              key={key}
                              className={`flex items-center justify-between py-1.5 px-3 rounded-lg transition-colors ${
                                blocked
                                  ? 'opacity-50 cursor-not-allowed'
                                  : 'hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer'
                              }`}
                              title={blocked ? t('share.needs_pnl_hint') : undefined}
                              onClick={() => { if (!blocked) toggleConfig(key); }}
                            >
                              <div className="flex items-center gap-2">
                                {on
                                  ? <Eye className="w-3.5 h-3.5 text-emerald-500" />
                                  : <EyeOff className="w-3.5 h-3.5 text-slate-400" />}
                                <span className="text-xs text-slate-700 dark:text-slate-300">
                                  {t(`share.${labelKey}`)}
                                </span>
                              </div>
                              <div
                                className={`relative w-9 h-5 rounded-full transition-colors duration-200 ${
                                  on ? 'bg-blue-500' : 'bg-slate-300 dark:bg-slate-600'
                                }`}
                              >
                                <span
                                  className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow-xs transition-transform duration-200 ${
                                    on ? 'translate-x-4' : 'translate-x-0'
                                  }`}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Expiration */}
                    <div>
                      <p className="text-xs font-bold text-slate-700 dark:text-slate-300 mb-2">
                        {t('share.expires_label')}
                      </p>
                      <div className="relative">
                        <select
                          value={expiryKey}
                          onChange={(e) => setExpiryKey(e.target.value)}
                          className="w-full appearance-none px-3 py-2 pr-8 rounded-xl text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500"
                        >
                          {EXPIRY_OPTIONS.map((o) => (
                            <option key={o.key} value={o.key}>
                              {t(`share.expires_${o.key}`)}
                            </option>
                          ))}
                        </select>
                        <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
                      </div>
                    </div>

                    {/* Create button */}
                    <button
                      onClick={handleCreate}
                      disabled={creating || selectedBrokers.length === 0}
                      className="w-full py-2.5 rounded-xl bg-blue-500 hover:bg-blue-400 disabled:opacity-60 text-white text-sm font-bold transition-colors"
                    >
                      {creating ? t('share.creating') : t('share.create_button')}
                    </button>
                  </>
                )}
              </div>
            )}

            {/* ── Manage tab ── */}
            {tab === 'manage' && (
              <div className="p-5">
                {loadingShares ? (
                  <div className="flex items-center justify-center py-12">
                    <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : shares.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-12 text-center">
                    <Link className="w-8 h-8 text-slate-300 dark:text-slate-600" />
                    <p className="text-sm text-slate-500">{t('share.manage_empty')}</p>
                    <button
                      onClick={() => setTab('create')}
                      className="mt-2 text-xs text-blue-500 hover:text-blue-400 font-semibold"
                    >
                      {t('share.create_first')}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {shares.map((s) => {
                      const expired = isExpired(s.expires_at);
                      return (
                        <div
                          key={s.id}
                          className={`p-3 rounded-xl border ${
                            expired
                              ? 'border-rose-200 dark:border-rose-900/50 bg-rose-50/50 dark:bg-rose-900/10'
                              : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50'
                          }`}
                        >
                          <div className="flex items-start gap-2">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="text-xs font-bold text-slate-800 dark:text-slate-200 truncate">
                                  {s.label || t('share.unnamed')}
                                </span>
                                {/* Mode badge */}
                                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                                  s.mode === 'live'
                                    ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400'
                                    : 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400'
                                }`}>
                                  {t(`share.${s.mode}_badge`)}
                                </span>
                                {expired && (
                                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-rose-100 dark:bg-rose-900/40 text-rose-600 dark:text-rose-400">
                                    {t('share.expired_badge')}
                                  </span>
                                )}
                              </div>
                              <p className="text-[10px] text-slate-400 mt-0.5">
                                {s.expires_at
                                  ? t('share.expires_on', {
                                      date: new Date(s.expires_at).toLocaleDateString(),
                                    })
                                  : t('share.expires_never_label')}
                              </p>
                            </div>

                            {/* Actions */}
                            <div className="flex items-center gap-1 shrink-0">
                              {!expired && (
                                <>
                                  <button
                                    onClick={() => copyLink(s.id)}
                                    className="p-1.5 rounded-lg text-slate-500 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                                    title={t('share.copy_link')}
                                  >
                                    {copiedToken === s.id
                                      ? <Check className="w-3.5 h-3.5 text-emerald-500" />
                                      : <Copy className="w-3.5 h-3.5" />}
                                  </button>
                                  <a
                                    href={shareUrl(s.id)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="p-1.5 rounded-lg text-slate-500 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                                    title={t('share.preview_link')}
                                  >
                                    <ExternalLink className="w-3.5 h-3.5" />
                                  </a>
                                </>
                              )}
                              <button
                                onClick={() => setRevokeId(s.id)}
                                className="p-1.5 rounded-lg text-slate-500 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors"
                                title={t('share.revoke')}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </motion.div>
      </div>

      {/* Revoke confirm dialog */}
      <AnimatePresence key="revoke-layer">
        {revokeId && (
          <motion.div
            key="revoke-confirm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-250 flex items-center justify-center p-4"
          >
            <div className="absolute inset-0 bg-black/60" onClick={() => setRevokeId(null)} />
            <motion.div
              initial={{ scale: 0.95 }}
              animate={{ scale: 1 }}
              className="relative bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 w-full max-w-sm shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <Trash2 className="w-8 h-8 text-rose-500 mx-auto mb-3" />
              <p className="text-sm font-bold text-slate-900 dark:text-white text-center mb-1">
                {t('share.revoke')}
              </p>
              <p className="text-xs text-slate-500 text-center mb-5">
                {t('share.revoke_confirm')}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setRevokeId(null)}
                  disabled={revoking}
                  className="flex-1 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-60 transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={() => revokeShare(revokeId)}
                  disabled={revoking}
                  className="flex-1 py-2 rounded-xl bg-rose-500 hover:bg-rose-400 disabled:opacity-60 text-white text-sm font-bold transition-colors"
                >
                  {revoking ? t('share.revoking') : t('share.revoke_confirm_btn')}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </AnimatePresence>
  );
}
