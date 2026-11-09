import { useEffect, useState, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  AreaChart, Area, XAxis, YAxis, CartesianGrid, ReferenceLine,
} from 'recharts';
import {
  TrendingUp, TrendingDown, BarChart3, Radio, Camera,
  Copy, Check, ExternalLink, Moon, Sun, Award,
  Globe, AlertCircle,
} from 'lucide-react';
import { rebasePerformanceRange } from '@/lib/sharePerformance';
import SearchableSelect from '@/components/ui/SearchableSelect';
import { appLocale, formatPercent } from '@/lib/formatters';

const SERVER_BASE = import.meta.env.VITE_SERVER_URL || '';

const CHART_COLORS = [
  '#3b82f6','#8b5cf6','#10b981','#f59e0b',
  '#ec4899','#06b6d4','#f97316','#94a3b8',
];

// Currencies shown in the selector (in preferred display order).
// El NOMBRE viaja junto al código porque el buscador casa contra la etiqueta:
// quien busca su moneda teclea "dólar" o "libra", no "USD"/"GBP". El filtrado
// (lib/optionSearch) normaliza acentos, así que "dolar" también encuentra.
const SELECTOR_CURRENCIES = ['EUR','USD','GBP','CHF','CAD','JPY','AUD','SEK','DKK','NOK'];
const CURRENCY_SYMBOL = {
  EUR:'€', USD:'$', GBP:'£', CHF:'Fr', CAD:'C$', JPY:'¥', AUD:'A$', SEK:'kr', DKK:'kr', NOK:'kr',
};

function fmt(value, currency = 'EUR', digits = 2) {
  if (value == null || isNaN(value)) return '—';
  const cur = (!currency || currency === 'MIXED') ? 'EUR' : currency;
  return new Intl.NumberFormat(appLocale(), {
    style: 'currency', currency: cur,
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

function fmtPct(v, digits = 2) {
  if (v == null || isNaN(v)) return '—';
  return formatPercent(v, digits, { sign: true });
}

function PieTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0];
  return (
    <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2 shadow-lg text-xs">
      <p className="font-bold text-slate-900 dark:text-white">{d.name}</p>
      <p className="text-slate-500">{formatPercent(d.value, 1)}</p>
    </div>
  );
}

function buildChartData(positions, tab, tOthers) {
  const pos = positions.filter(p => (p.weight ?? 0) > 0.01);

  if (tab === 'posiciones') {
    const tickerCount = {};
    for (const p of pos) tickerCount[p.ticker] = (tickerCount[p.ticker] || 0) + 1;
    const sorted = [...pos].sort((a, b) => b.weight - a.weight);
    const top  = sorted.slice(0, 8);
    const rest = sorted.slice(8);
    const data = top.map(p => ({
      name:  tickerCount[p.ticker] > 1 ? `${p.ticker} (${p.currency})` : p.ticker,
      value: parseFloat(p.weight.toFixed(1)),
    }));
    if (rest.length) {
      data.push({ name: tOthers, value: parseFloat(rest.reduce((s, p) => s + p.weight, 0).toFixed(1)) });
    }
    return data;
  }

  const keyFn = {
    divisas:    p => p.currency  || '—',
    sectores:   p => p.sector    || tOthers,
    regiones:   p => p.region    || tOthers,
    industrias: p => p.industry  || tOthers,
  }[tab];

  if (!keyFn) return [];

  const groups = {};
  for (const p of pos) {
    const k = keyFn(p);
    groups[k] = (groups[k] || 0) + (p.weight ?? 0);
  }
  return Object.entries(groups)
    .sort(([, a], [, b]) => b - a)
    .map(([name, value]) => ({ name, value: parseFloat(value.toFixed(1)) }));
}

const CHART_TABS = ['posiciones','divisas','sectores','regiones','industrias'];

export default function SharedPortfolioPage() {
  const { token } = useParams();
  const { t }     = useTranslation();

  const [state, setState]         = useState('loading');
  const [data,  setData]          = useState(null);
  const [perfRange, setPerfRange] = useState('ALL');
  const [chartMetric, setChartMetric] = useState('ttwror'); // 'ttwror' | 'roi'
  const [copied, setCopied]     = useState(false);
  const [chartTab, setChartTab] = useState('posiciones');
  const [selectedCurrency, setSelectedCurrency] = useState('EUR');
  // Claro por DEFECTO, como el resto de la plataforma: DashboardLayout arranca
  // en `useState(false)` y solo se va a oscuro si `user_preferences.dark_mode`
  // lo dice — en toda la app no se consulta `prefers-color-scheme` ni una vez.
  // Esta página sí lo hacía, así que a cualquiera con el SO en oscuro le abría
  // en oscuro una cartera compartida que su dueño ve en claro. Solo manda la
  // elección EXPLÍCITA del visitante en este navegador (el botón de la barra).
  const [dark, setDark] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      return localStorage.getItem('trazza_dark') === 'true';
    } catch {
      return false; // modo privado / cookies bloqueadas
    }
  });

  useEffect(() => {
    try { localStorage.setItem('trazza_dark', dark); } catch { /* modo privado */ }
  }, [dark]);

  useEffect(() => {
    if (!token) { setState('not_found'); return; }
    fetch(`${SERVER_BASE}/share-data/${token}`)
      .then(async r => {
        if (r.status === 404) { setState('not_found'); return; }
        if (r.status === 410) { setState('expired');   return; }
        if (!r.ok)            { setState('error');     return; }
        const json = await r.json();
        setData(json);
        const base = json.currency && json.currency !== 'MIXED' ? json.currency : 'EUR';
        setSelectedCurrency(base);
        setState('ok');
      })
      .catch(() => setState('error'));
  }, [token]);


  // Convert a value from EUR to the currently selected display currency
  const convertFromEur = (eurValue) => {
    if (eurValue == null || !data?.rates) return eurValue;
    const rate = data.rates[selectedCurrency] ?? 1;
    return eurValue * rate;
  };

  // Convert a value from a native currency to the selected display currency
  const convertNative = (nativeValue, fromCurrency) => {
    if (nativeValue == null || !data?.rates) return nativeValue;
    const fromRate = data.rates[fromCurrency] ?? data.rates[(fromCurrency||'').toUpperCase()] ?? 1;
    const toRate   = data.rates[selectedCurrency] ?? 1;
    return (nativeValue / fromRate) * toRate;
  };

  const fmtD = (eurValue, opts = {}) =>
    fmt(convertFromEur(eurValue), selectedCurrency, opts.digits ?? 2);

  const derived = useMemo(() => {
    if (!data?.positions?.length) return null;
    const pos     = data.positions.filter(p => (p.weight ?? 0) > 0);
    const withPnl = pos.filter(p => p.pnl_pct != null);

    const bestGainer     = withPnl.length ? withPnl.reduce((b,p) => p.pnl_pct > b.pnl_pct ? p : b) : null;
    const worstPerformer = withPnl.length ? withPnl.reduce((w,p) => p.pnl_pct < w.pnl_pct ? p : w) : null;
    const biggestPos     = pos.length ? pos.reduce((b,p) => (p.weight??0)>(b.weight??0)?p:b, pos[0]) : null;

    return { bestGainer, worstPerformer, biggestPos };
  }, [data]);

  const chartData = useMemo(
    () => data?.positions?.length
      ? buildChartData(data.positions, chartTab, t('share.others'))
      : [],
    [data, chartTab, t]
  );

  // Available currencies for the selector (those present in rates object)
  const availableCurrencies = useMemo(() => {
    if (!data?.rates) return ['EUR'];
    return SELECTOR_CURRENCIES.filter(c => data.rates[c] != null);
  }, [data]);

  // Opciones del buscador: "USD · Dólar estadounidense ($)". El código va
  // primero porque es lo que el visitante reconoce de un vistazo en la lista,
  // y el nombre detrás es lo que hace útil escribir para buscar.
  const currencyOptions = useMemo(() => availableCurrencies.map(c => ({
    value: c,
    label: `${c} · ${t(`share.currency_${c.toLowerCase()}`)}${CURRENCY_SYMBOL[c] ? ` (${CURRENCY_SYMBOL[c]})` : ''}`,
    triggerLabel: c, // en la cabecera solo cabe el código
  })), [availableCurrencies, t]);

  // Filter + rebase performance data by selected range (pure, shared, unit-tested)
  const filteredPerf = useMemo(
    () => rebasePerformanceRange(data?.performance_data, perfRange),
    [data, perfRange]
  );

  // ROI series only exists on shares created after this feature shipped.
  const hasRoiSeries = useMemo(
    () => (data?.performance_data || []).some(d => d.roi != null),
    [data]
  );

  // El ROI SOLO se ofrece con el rango completo — la misma regla que
  // PortfolioGrowthChart (`effectiveChartMode`, 2026-09-19). Sobre un tramo,
  // `rebasePerformanceRange` reencuadra la línea a 0% en su primera fecha, así
  // que lo que se pinta deja de ser una rentabilidad: es cuánto ha CAMBIADO el
  // múltiplo valor/coste. Y una aportación suma los MISMOS euros al valor y al
  // coste, o sea que arrastra ese cociente hacia el 0% por bien que vaya el
  // mercado: se puede ganar dinero y ver el número en rojo. Medido con esta
  // misma función: 6M con TTWROR +20,00% y ROI −12,31% en la misma tarjeta.
  // Aquí importa más que en la app, porque quien abre un enlace compartido no
  // tiene contexto para desconfiar del número.
  const roiDisabled = perfRange !== 'ALL';
  // Se DERIVA en vez de corregir el estado desde un efecto: el modo pintado y el
  // rango no pueden desincronizarse ni un render, y al volver a ALL se recupera
  // el ROI que el visitante había elegido.
  const activeMetric = (chartMetric === 'roi' && hasRoiSeries && !roiDisabled) ? 'roi' : 'ttwror';
  const metricKey    = activeMetric === 'roi' ? 'roi' : 'pct';
  // Mismos colores por modo que el gráfico de la app: TTWROR azul, ROI violeta.
  const metricColor  = activeMetric === 'roi' ? '#8b5cf6' : '#3b82f6';

  function copyLink() {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // ── Error/loading states ──────────────────────────────────────────────────
  if (state === 'loading') {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (state !== 'ok') {
    const msgs = {
      not_found: { icon:'🔗', title:t('share.public_not_found'), sub:t('share.public_not_found_sub') },
      expired:   { icon:'⏰', title:t('share.public_expired'),   sub:t('share.public_expired_sub')   },
      error:     { icon:'⚠️', title:t('share.public_error'),     sub:t('share.public_error_sub')     },
    };
    const m = msgs[state] || msgs.error;
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="text-5xl">{m.icon}</div>
        <h1 className="font-display text-xl font-black text-slate-900">{m.title}</h1>
        <p className="text-sm text-slate-500 max-w-xs">{m.sub}</p>
        <Link to="/" className="mt-2 px-5 py-2.5 rounded-xl bg-blue-500 hover:bg-blue-400 text-white text-sm font-bold">
          {t('share.public_cta_btn')}
        </Link>
      </div>
    );
  }

  const {
    label, mode, config, positions = [],
    is_mixed_currency,
    metrics, updated_at, expires_at,
    realized_sales: realizedSales = [],
    realized_sales_total: realizedSalesTotal = 0,
  } = data;

  const invested  = positions.filter(p => (p.weight??0) > 0 || (p.value??0) > 0);
  const hasValues = config?.show_values;
  const hasPnl    = config?.show_pnl;
  const hasBroker = config?.show_broker_names;
  // `show_chart` gobierna las DOS gráficas. Antes solo apagaba el quesito y la
  // curva de rendimiento seguía a la vista: un interruptor de privacidad que no
  // apagaba la mitad de lo que promete.
  const hasChart  = config?.show_chart !== false;
  // El coste medio se PINTA cuando está activado. Hasta ahora el server lo
  // mandaba en el JSON público y la página no lo enseñaba en ningún sitio, así
  // que el interruptor exponía el dato sin que el dueño llegara a verlo.
  const hasCostBasis = config?.show_cost_basis === true;
  // Ventas realizadas: el server ya aplica la doble puerta (opt-in + show_pnl)
  // y manda [] si no toca, así que aquí basta con que haya filas.
  const hasSales = realizedSales.length > 0;

  // Detect duplicate tickers to show currency suffix in table
  const tickerCount = {};
  for (const p of invested) tickerCount[p.ticker] = (tickerCount[p.ticker] || 0) + 1;
  const displayTicker = p => tickerCount[p.ticker] > 1 ? `${p.ticker} (${p.currency})` : p.ticker;

  // ── Rich metrics for the hero panel ──────────────────────────────────────
  const m = metrics || {};

  // TTWROR (cumulative time-weighted return): cached metric when available,
  // otherwise the last point of the sampled performance series (same value).

  // Fallback: simple return from positions for older snapshots without metrics
  const weightedReturn = hasPnl && invested.length > 0 && !m.roi_cartera ? (() => {
    const withPnl = invested.filter(p => p.pnl_pct != null);
    const totalW  = withPnl.reduce((s, p) => s + (p.weight ?? 0), 0);
    return totalW > 0 ? withPnl.reduce((s, p) => s + p.pnl_pct * (p.weight ?? 0) / totalW, 0) : null;
  })() : null;

  return (
    <div className={dark ? 'dark' : ''}>
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 transition-colors duration-200">

        {/* ── Nav ── */}
        <div className="sticky top-0 z-50 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xs">
          <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
            <Link to="/" className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-lg bg-blue-500 flex items-center justify-center">
                <BarChart3 className="w-3.5 h-3.5 text-white" />
              </div>
              <span className="font-display text-sm font-black text-slate-900 dark:text-white tracking-tight">Trazza</span>
            </Link>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setDark(d => !d)}
                title={dark ? t('share.light_mode') : t('share.dark_mode')}
                className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              >
                {dark ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
              </button>
              <button
                onClick={copyLink}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                {t('share.copy_link')}
              </button>
              <Link to="/auth" className="hidden sm:flex px-3 py-1.5 rounded-lg bg-blue-500 hover:bg-blue-400 text-white text-xs font-bold transition-colors">
                {t('share.public_signup_cta')}
              </Link>
            </div>
          </div>
        </div>

        <div className="max-w-5xl mx-auto px-4 py-8 space-y-5">

          {/* ── Hero ── */}
          <motion.div
            initial={{ opacity:0, y:14 }} animate={{ opacity:1, y:0 }}
            className="relative overflow-hidden rounded-2xl p-6 text-white shadow-xl shadow-blue-500/20"
            style={{ background:'linear-gradient(135deg,#2563eb 0%,#7c3aed 100%)' }}
          >
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_70%_50%,rgba(255,255,255,0.1),transparent_60%)] pointer-events-none" />
            <div className="relative">
              {/* Title row */}
              <div className="flex items-start justify-between gap-3 mb-4">
                <div>
                  <h1 className="font-display text-2xl font-black tracking-tight leading-tight mb-1.5">
                    {label || t('share.public_page_title')}
                  </h1>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-white/20">
                      {mode==='live' ? <Radio className="w-2.5 h-2.5"/> : <Camera className="w-2.5 h-2.5"/>}
                      {t(`share.${mode}_badge`)}
                    </span>
                    {updated_at && (
                      <span className="text-[11px] text-white/70">
                        {t('share.public_updated', { date: new Date(updated_at).toLocaleDateString() })}
                      </span>
                    )}
                    {expires_at && (
                      <span className="text-[11px] text-white/70">
                        · {t('share.expires_on', { date: new Date(expires_at).toLocaleDateString() })}
                      </span>
                    )}
                    {is_mixed_currency && (
                      <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-400/30 text-amber-200">
                        {t('share.mixed_currencies')}
                      </span>
                    )}
                  </div>
                </div>

                {/* Selector de moneda — `SearchableSelect`, el mismo combobox
                    con buscador que usa el diálogo de Gastos. El `<select>`
                    nativo solo mostraba el código a secas y en un móvil abre la
                    rueda del sistema; aquí se busca por nombre ("dólar") y la
                    opción elegida se lee entera. */}
                {availableCurrencies.length > 1 && (
                  <div className="shrink-0 w-38">
                    <div className="flex items-center gap-1.5 bg-white/10 hover:bg-white/15 rounded-xl px-2.5 py-1.5 transition-colors">
                      <Globe className="w-3 h-3 text-white/60 shrink-0" />
                      <SearchableSelect
                        value={selectedCurrency}
                        onChange={setSelectedCurrency}
                        options={currencyOptions}
                        ariaLabel={t('share.currency_selector_label')}
                        searchPlaceholder={t('share.currency_search')}
                        emptyText={t('share.currency_none')}
                        className="w-full text-white text-xs font-bold focus:outline-hidden cursor-pointer [&>svg]:text-white/60"
                        // El disparador es una pastilla estrecha en la cabecera;
                        // el panel se ancla a su DERECHA y se da ancho propio o
                        // las etiquetas se recortarían a una letra. Medido: el
                        // borde derecho del disparador cae en x≈244 a 375px y
                        // x≈218 a 320px, así que 16rem se salía por la izquierda
                        // (−12 y −38). En móvil va a 12.5rem —el nombre se
                        // trunca, pero el CÓDIGO va primero y es lo que hay que
                        // reconocer— y desde sm recupera el ancho completo.
                        panelClassName="w-50 sm:w-64 right-0"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* ── Primary metrics row ── */}
              {(hasValues || hasPnl) && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-2.5">
                  {hasValues && m.market_value_eur != null && (
                    <div className="bg-white/10 backdrop-blur-xs rounded-xl p-3">
                      <p className="text-[10px] text-white/60 uppercase tracking-wide font-semibold mb-1">{t('share.metric_market_value')}</p>
                      <p className="text-base font-black leading-none tabular-nums">{fmtD(m.market_value_eur, { digits: 0 })}</p>
                    </div>
                  )}
                  {hasPnl && m.unrealized_pnl_eur != null && (
                    <div className="bg-white/10 backdrop-blur-xs rounded-xl p-3">
                      <p className="text-[10px] text-white/60 uppercase tracking-wide font-semibold mb-1">{t('share.metric_unrealized')}</p>
                      <p className={`text-base font-black leading-none tabular-nums ${m.unrealized_pnl_eur >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                        {m.unrealized_pnl_eur >= 0 ? '+' : ''}{fmtD(m.unrealized_pnl_eur, { digits: 0 })}
                      </p>
                    </div>
                  )}
                  {/* Ganancia Total: only show when we have full history, otherwise misleading */}
                  {hasPnl && m.total_gain_eur != null && m.has_history && (
                    <div className="bg-white/10 backdrop-blur-xs rounded-xl p-3">
                      <p className="text-[10px] text-white/60 uppercase tracking-wide font-semibold mb-1">{t('share.metric_total_gain')}</p>
                      <p className={`text-base font-black leading-none tabular-nums ${m.total_gain_eur >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                        {m.total_gain_eur >= 0 ? '+' : ''}{fmtD(m.total_gain_eur, { digits: 0 })}
                      </p>
                    </div>
                  )}
                  {/* Fallback: position count when metrics unavailable */}
                  {!hasValues && !hasPnl && (
                    <div className="bg-white/10 backdrop-blur-xs rounded-xl p-3">
                      <p className="text-[10px] text-white/60 uppercase tracking-wide font-semibold mb-1">{t('share.public_positions')}</p>
                      <p className="text-base font-black leading-none">{invested.length}</p>
                    </div>
                  )}
                </div>
              )}

              {/* ── Historical metrics row: only when DB transactions exist ── */}
              {hasPnl && m.has_history && (m.realized_pnl_eur != null || m.dividends_eur != null || m.fees_eur != null) && (
                <div className="grid grid-cols-3 gap-2.5 mb-2.5">
                  {m.realized_pnl_eur != null && (
                    <div className="bg-white/8 rounded-xl p-2.5">
                      <p className="text-[9px] text-white/50 uppercase tracking-wide font-semibold mb-0.5">{t('share.metric_realized')}</p>
                      <p className={`text-sm font-bold tabular-nums ${m.realized_pnl_eur >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                        {m.realized_pnl_eur >= 0 ? '+' : ''}{fmtD(m.realized_pnl_eur, { digits: 0 })}
                      </p>
                    </div>
                  )}
                  {m.dividends_eur != null && (
                    <div className="bg-white/8 rounded-xl p-2.5">
                      <p className="text-[9px] text-white/50 uppercase tracking-wide font-semibold mb-0.5">{t('share.metric_dividends')}</p>
                      <p className="text-sm font-bold tabular-nums text-emerald-300">
                        +{fmtD(m.dividends_eur, { digits: 0 })}
                      </p>
                    </div>
                  )}
                  {m.fees_eur != null && (
                    <div className="bg-white/8 rounded-xl p-2.5">
                      <p className="text-[9px] text-white/50 uppercase tracking-wide font-semibold mb-0.5">{t('share.metric_fees')}</p>
                      <p className="text-sm font-bold tabular-nums text-rose-300">
                        -{fmtD(m.fees_eur, { digits: 0 })}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* ── ROI row — solo Rentab. Anual (ROI Cartera y TTWROR retirados 2026-07) ── */}
              {hasPnl && (m.annualized_return != null || weightedReturn != null) && (
                <div className="border-t border-white/10 pt-2.5">
                  <p className="text-[10px] text-white/50 uppercase tracking-wide font-semibold mb-2">{t('share.performance_section')}</p>
                  <div className="flex flex-wrap gap-x-5 gap-y-2">
                    {m.annualized_return != null && (
                      <div>
                        <p className="text-[9px] text-white/50 mb-0.5">{t('share.metric_roi_annualized')}</p>
                        <p className={`text-sm font-black tabular-nums ${m.annualized_return >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                          {fmtPct(m.annualized_return)}
                        </p>
                      </div>
                    )}
                    {/* Fallback for old snapshots without full metrics */}
                    {m.annualized_return == null && weightedReturn != null && (
                      <div>
                        <p className="text-[9px] text-white/50 mb-0.5">{t('share.return_pct')}</p>
                        <p className={`text-sm font-black tabular-nums ${weightedReturn >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                          {fmtPct(weightedReturn)}
                        </p>
                      </div>
                    )}
                    {/* Positions count always shown */}
                    <div>
                      <p className="text-[9px] text-white/50 mb-0.5">{t('share.public_positions')}</p>
                      <p className="text-sm font-black">{invested.length}</p>
                    </div>
                  </div>
                </div>
              )}

              {/* If no metrics at all, show simple positions count */}
              {!hasValues && !hasPnl && (
                <div className="flex items-center gap-6">
                  <div>
                    <p className="text-[10px] text-white/60 uppercase tracking-wide font-semibold mb-1">{t('share.public_positions')}</p>
                    <p className="text-2xl font-black">{invested.length}</p>
                  </div>
                </div>
              )}
            </div>
          </motion.div>

          {/* ── Performance chart ── */}
          {hasChart && filteredPerf.length > 1 && (
            <motion.div
              initial={{ opacity:0, y:14 }} animate={{ opacity:1, y:0 }} transition={{ delay:0.18 }}
              className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5"
            >
              <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-display text-sm font-black tracking-tight text-slate-900 dark:text-white">{t('share.chart_title')}</p>
                    {/* Selector de métrica — mismo patrón que `ModeSelector` de
                        charts/GrowthChartHeader: el ROI se DESHABILITA fuera de
                        ALL con su porqué en el title, no desaparece. Un control
                        que se esfuma al cambiar de rango se lee como un fallo;
                        uno apagado explica por qué esa lectura no vale ahí. */}
                    {hasRoiSeries && (
                      <div className="flex items-center gap-0.5 bg-slate-100/80 dark:bg-slate-800/60 p-0.5 rounded-xl border border-slate-200/50 dark:border-slate-700/50">
                        {[
                          { key: 'ttwror', label: t('share.metric_ttwror'),     color: '#3b82f6', desc: t('share.mode_desc_ttwror') },
                          { key: 'roi',    label: t('share.chart_metric_roi'),  color: '#8b5cf6', desc: t('share.mode_desc_roi')    },
                        ].map(({ key, label, color: modeColor, desc }) => {
                          const off = key === 'roi' && roiDisabled;
                          return (
                            <button
                              key={key}
                              onClick={() => setChartMetric(key)}
                              disabled={off}
                              title={off ? t('share.roi_only_all') : desc}
                              className={`px-2.5 py-1 text-[10px] font-bold rounded-lg transition-all ${
                                off
                                  ? 'text-slate-300 dark:text-slate-600 cursor-not-allowed'
                                  : activeMetric === key
                                  ? 'bg-white dark:bg-slate-700 shadow-xs'
                                  : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                              }`}
                              style={!off && activeMetric === key ? { color: modeColor } : {}}
                            >{label}</button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  {(() => {
                    const endVal = filteredPerf[filteredPerf.length - 1]?.[metricKey] ?? 0;
                    return (
                      <div className="flex items-center gap-2">
                        <p className={`text-3xl font-black tabular-nums leading-tight ${endVal >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'}`}>
                          {formatPercent(endVal, 2, { sign: true })}
                        </p>
                        {/* Distintivo del modo, como en el gráfico de la app: el
                            titular va en verde/rojo por SIGNO y el modo aparte,
                            con el color de su serie. */}
                        <span
                          className="text-[10px] font-black px-2 py-0.5 rounded-full border"
                          style={{ color: metricColor, borderColor: `${metricColor}50`, backgroundColor: `${metricColor}14` }}
                        >
                          {activeMetric === 'roi' ? t('share.chart_metric_roi') : t('share.metric_ttwror')}
                        </span>
                      </div>
                    );
                  })()}
                  {/* En la app esto vive solo en el tooltip del botón, pero aquí
                      el visitante es un desconocido y en táctil no hay hover:
                      va una línea corta en pantalla y el porqué completo en el
                      title, sin cargar la tarjeta. */}
                  {roiDisabled && hasRoiSeries && (
                    <p className="text-[10px] text-slate-400 mt-0.5">{t('share.roi_only_all_short')}</p>
                  )}
                </div>
                <div className="flex items-center gap-0.5 bg-slate-100/80 dark:bg-slate-800/60 p-0.5 rounded-xl border border-slate-200/50 dark:border-slate-700/50">
                  {['6M','1Y','YTD','ALL'].map(r => (
                    <button
                      key={r}
                      onClick={() => setPerfRange(r)}
                      className={`px-2.5 py-1 text-[10px] font-bold rounded-lg transition-colors ${
                        perfRange === r
                          ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs'
                          : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                      }`}
                    >{r}</button>
                  ))}
                </div>
              </div>
              {(() => {
                // La línea va del color del MODO (azul TTWROR / violeta ROI),
                // igual que en el gráfico de la app: así el distintivo de arriba
                // y la serie son el mismo color y se ve de un vistazo qué se
                // está pintando. El signo lo comunica el titular, en verde/rojo.
                const color  = metricColor;
                const gradId = `perfGrad-${activeMetric}`;
                return (
                  <div className="h-52">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={filteredPerf} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                        <defs>
                          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={color} stopOpacity={0.3} />
                            <stop offset="100%" stopColor={color} stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" className="dark:stroke-slate-800" />
                        <XAxis
                          dataKey="date"
                          axisLine={false} tickLine={false}
                          tick={{ fontSize: 10, fill: '#94a3b8', fontWeight: 600 }}
                          tickFormatter={d => { const dt = new Date(d); return `${dt.toLocaleString('default',{month:'short'})} ${String(dt.getFullYear()).slice(2)}`; }}
                          interval={Math.max(1, Math.floor(filteredPerf.length / 6))}
                          dy={8}
                        />
                        <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#94a3b8', fontWeight: 600 }} tickFormatter={v => `${v}%`} />
                        <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="3 3" strokeOpacity={0.5} />
                        <Tooltip
                          content={({ active, payload }) => {
                            if (!active || !payload?.length) return null;
                            const d = payload[0].payload;
                            const v = d[metricKey];
                            return (
                              <div className="bg-slate-900/95 border border-slate-700/60 px-3 py-2 rounded-xl shadow-xl text-xs">
                                <p className="text-slate-400 mb-1">{d.date}</p>
                                <p className={`font-black ${v >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                  {formatPercent(v, 2, { sign: true })}
                                </p>
                              </div>
                            );
                          }}
                        />
                        <Area
                          type="monotone" dataKey={metricKey}
                          stroke={color} strokeWidth={2}
                          fill={`url(#${gradId})`}
                          dot={false}
                          activeDot={{ r: 4, fill: color, stroke: '#fff', strokeWidth: 2 }}
                          isAnimationActive={false}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                );
              })()}
              <div className="mt-3 flex items-center gap-1.5 text-[10px] text-slate-400">
                <AlertCircle className="w-3 h-3 shrink-0" />
                {t('share.values_disclaimer')}
              </div>
            </motion.div>
          )}

          {/* ── Chart + highlights ── */}
          {hasChart && (
            <motion.div
              initial={{ opacity:0, y:14 }} animate={{ opacity:1, y:0 }} transition={{ delay:0.08 }}
              className="grid grid-cols-1 lg:grid-cols-5 gap-5"
            >
              {/* Donut chart with tabs */}
              <div className="lg:col-span-3 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5">
                <p className="font-display text-sm font-black tracking-tight text-slate-900 dark:text-white mb-3">
                  {t('share.allocation')}
                </p>

                <div className="flex gap-1 mb-4 overflow-x-auto pb-1 scrollbar-none">
                  {CHART_TABS.map(tab => (
                    <button
                      key={tab}
                      onClick={() => setChartTab(tab)}
                      className={`shrink-0 px-3 py-1 rounded-full text-[11px] font-bold transition-colors ${
                        chartTab === tab
                          ? 'bg-blue-500 text-white'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
                      }`}
                    >
                      {t(`share.tab_${tab}`)}
                    </button>
                  ))}
                </div>

                {chartData.length === 0 ? (
                  <div className="flex items-center justify-center h-44 text-sm text-slate-400">
                    {t('share.no_chart_data')}
                  </div>
                ) : (
                  <div className="flex flex-col sm:flex-row items-center gap-5">
                    <div className="w-44 h-44 shrink-0">
                      <ResponsiveContainer key={chartTab} width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={chartData}
                            cx="50%" cy="50%"
                            innerRadius={46} outerRadius={78}
                            paddingAngle={2} dataKey="value" stroke="none"
                            isAnimationActive={false}
                          >
                            {chartData.map((_, idx) => (
                              <Cell key={`${chartTab}-${idx}`} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                            ))}
                          </Pie>
                          <Tooltip content={<PieTooltip />} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>

                    <div className="flex-1 w-full space-y-1.5 max-h-44 overflow-y-auto pr-1">
                      {chartData.map((d, idx) => (
                        <div key={`${chartTab}-${idx}`} className="flex items-center gap-2.5">
                          <div className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: CHART_COLORS[idx % CHART_COLORS.length] }} />
                          <span className="text-xs text-slate-700 dark:text-slate-300 flex-1 truncate font-medium">{d.name}</span>
                          <span className="text-xs font-bold text-slate-500 dark:text-slate-400 tabular-nums shrink-0">{formatPercent(d.value, 1)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Highlights */}
              <div className="lg:col-span-2 flex flex-col gap-3">
                {derived?.bestGainer && (
                  <motion.div
                    initial={{ opacity:0, x:12 }} animate={{ opacity:1, x:0 }} transition={{ delay:0.12 }}
                    className="flex-1 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4"
                  >
                    <p className="text-[10px] text-slate-400 uppercase tracking-wide font-semibold mb-2.5">{t('share.top_gainer')}</p>
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center shrink-0">
                        <TrendingUp className="w-4 h-4 text-emerald-500" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-base font-black text-slate-900 dark:text-white truncate">{derived.bestGainer.ticker}</p>
                        <p className="text-xs font-bold text-emerald-500">{fmtPct(derived.bestGainer.pnl_pct)}</p>
                      </div>
                    </div>
                  </motion.div>
                )}

                {derived?.worstPerformer && derived.worstPerformer.ticker !== derived.bestGainer?.ticker && (
                  <motion.div
                    initial={{ opacity:0, x:12 }} animate={{ opacity:1, x:0 }} transition={{ delay:0.16 }}
                    className="flex-1 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4"
                  >
                    <p className="text-[10px] text-slate-400 uppercase tracking-wide font-semibold mb-2.5">{t('share.worst_performer')}</p>
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl bg-rose-100 dark:bg-rose-900/30 flex items-center justify-center shrink-0">
                        <TrendingDown className="w-4 h-4 text-rose-500" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-base font-black text-slate-900 dark:text-white truncate">{derived.worstPerformer.ticker}</p>
                        <p className="text-xs font-bold text-rose-500">{fmtPct(derived.worstPerformer.pnl_pct)}</p>
                      </div>
                    </div>
                  </motion.div>
                )}

                {derived?.biggestPos && (
                  <motion.div
                    initial={{ opacity:0, x:12 }} animate={{ opacity:1, x:0 }} transition={{ delay:0.20 }}
                    className="flex-1 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4"
                  >
                    <p className="text-[10px] text-slate-400 uppercase tracking-wide font-semibold mb-2.5">{t('share.biggest_position')}</p>
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center shrink-0">
                        <Award className="w-4 h-4 text-blue-500" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-base font-black text-slate-900 dark:text-white truncate">{derived.biggestPos.ticker}</p>
                        <p className="text-xs font-bold text-blue-500">{formatPercent(derived.biggestPos.weight ?? 0, 1)} {t('share.of_portfolio')}</p>
                      </div>
                    </div>
                  </motion.div>
                )}
              </div>
            </motion.div>
          )}

          {/* ── Positions table ── */}
          <motion.div
            initial={{ opacity:0, y:14 }} animate={{ opacity:1, y:0 }} transition={{ delay:0.14 }}
            className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden"
          >
            <div className="px-5 py-3.5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
              <p className="font-display text-sm font-black tracking-tight text-slate-900 dark:text-white flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-slate-400" />
                {t('share.public_positions')}
              </p>
              <span className="text-xs text-slate-400">{invested.length} {t('share.public_positions').toLowerCase()}</span>
            </div>

            {invested.length === 0 ? (
              <div className="py-12 text-center text-slate-400 text-sm">{t('share.public_no_positions')}</div>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800/60">
                {invested.map((p, i) => {
                  const pnlPos = (p.pnl_pct ?? 0) >= 0;
                  const color  = CHART_COLORS[i % CHART_COLORS.length];
                  // Convert position value from native to selected display currency
                  const displayValue = p.value != null ? convertNative(p.value, p.currency) : null;
                  return (
                    <motion.div
                      key={`${p.ticker}-${i}`}
                      initial={{ opacity:0, x:-8 }} animate={{ opacity:1, x:0 }}
                      transition={{ delay: 0.16 + i * 0.025 }}
                      className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
                    >
                      <span className="shrink-0 w-5 text-[11px] text-slate-400 font-medium text-right">{i+1}</span>

                      <div className="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center" style={{ backgroundColor:`${color}22` }}>
                        <span className="text-[9px] font-black leading-none text-center" style={{ color }}>
                          {(p.ticker||'').slice(0,4)}
                        </span>
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-bold text-slate-900 dark:text-white truncate">
                            {displayTicker(p)}
                          </span>
                          {hasBroker && p.broker_name && (
                            <span className="text-[10px] text-slate-400 shrink-0">· {p.broker_name}</span>
                          )}
                        </div>
                        <p className="text-[11px] text-slate-400 truncate">{p.name}</p>
                        {hasCostBasis && p.entry_price != null && (
                          <p className="text-[10px] text-slate-400 tabular-nums">
                            {t('share.cost_basis_row', {
                              price: fmt(convertNative(p.entry_price, p.currency), selectedCurrency),
                            })}
                          </p>
                        )}
                        <div className="flex items-center gap-2 mt-1">
                          <div className="flex-1 h-1 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                            <div className="h-full rounded-full" style={{ width:`${Math.min(p.weight??0,100)}%`, backgroundColor:color }} />
                          </div>
                          <span className="text-[10px] text-slate-400 shrink-0 w-10 text-right tabular-nums">
                            {formatPercent(p.weight ?? 0, 1)}
                          </span>
                        </div>
                      </div>

                      <div className="shrink-0 text-right min-w-[80px]">
                        {hasValues && displayValue != null ? (
                          <p className="text-sm font-bold text-slate-900 dark:text-white tabular-nums">
                            {fmt(displayValue, selectedCurrency, 0)}
                          </p>
                        ) : (
                          <p className="text-xs text-slate-400">{t('share.public_hidden')}</p>
                        )}
                        {hasPnl && p.pnl_pct != null && (
                          <span className={`inline-flex items-center gap-0.5 text-[11px] font-bold tabular-nums mt-0.5 px-1.5 py-0.5 rounded-md ${
                            pnlPos
                              ? 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400'
                              : 'bg-rose-50 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400'
                          }`}>
                            {pnlPos ? <TrendingUp className="w-2.5 h-2.5"/> : <TrendingDown className="w-2.5 h-2.5"/>}
                            {fmtPct(p.pnl_pct)}
                          </span>
                        )}
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            )}
          </motion.div>

          {/* ── Ventas realizadas (P&L) ── */}
          {hasSales && (
            <motion.div
              initial={{ opacity:0, y:14 }} animate={{ opacity:1, y:0 }} transition={{ delay:0.2 }}
              className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden"
            >
              <div className="px-5 py-3.5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3 flex-wrap">
                <p className="font-display text-sm font-black tracking-tight text-slate-900 dark:text-white flex items-center gap-2">
                  <TrendingDown className="w-4 h-4 text-slate-400" />
                  {t('share.realized_sales_title')}
                </p>
                {/* Total = suma de lo que se PINTA. Con la lista recortada a las
                    100 últimas, sumar todo diría una cosa y la tabla otra. */}
                {(() => {
                  const shown = realizedSales.reduce((s, r) => s + (r.profit_eur ?? 0), 0);
                  return (
                    <span className={`text-sm font-black tabular-nums ${shown >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'}`}>
                      {shown >= 0 ? '+' : ''}{fmtD(shown, { digits: 0 })}
                    </span>
                  );
                })()}
              </div>

              {/* Tablas, diagramas y bloques de código son lo único que puede
                  desbordar a lo ancho, y siempre en su propio contenedor. */}
              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-136">
                  <thead>
                    <tr className="text-slate-400 border-b border-slate-100 dark:border-slate-800">
                      <th className="text-left font-semibold px-5 py-2">{t('share.sales_col_asset')}</th>
                      <th className="text-right font-semibold px-3 py-2 whitespace-nowrap">{t('share.sales_col_date')}</th>
                      {hasValues && <th className="text-right font-semibold px-3 py-2 whitespace-nowrap">{t('share.sales_col_qty')}</th>}
                      {hasValues && <th className="text-right font-semibold px-3 py-2 whitespace-nowrap">{t('share.sales_col_buy')}</th>}
                      {hasValues && <th className="text-right font-semibold px-3 py-2 whitespace-nowrap">{t('share.sales_col_sell')}</th>}
                      <th className="text-right font-semibold px-5 py-2 whitespace-nowrap">{t('share.sales_col_result')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                    {realizedSales.map((r, i) => {
                      const pos = (r.profit_eur ?? 0) >= 0;
                      return (
                        <tr key={`${r.ticker}-${r.date}-${i}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                          <td className="px-5 py-2.5">
                            <p className="font-bold text-slate-900 dark:text-white">{r.ticker}</p>
                            {/* El subtítulo solo aparece si APORTA algo: el
                                server ya vacía los nombres que repiten el
                                ticker o son un ISIN, y aquí se comprueba otra
                                vez para que un share antiguo tampoco lo pinte. */}
                            {r.name && r.name !== r.ticker && (
                              <p className="text-[10px] text-slate-400 truncate max-w-48">{r.name}</p>
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-right text-slate-500 tabular-nums whitespace-nowrap">{r.date}</td>
                          {hasValues && <td className="px-3 py-2.5 text-right text-slate-500 tabular-nums">{r.quantity}</td>}
                          {/* Coste medio: sin compra registrada el FIFO lo deja
                              en 0, y pintar "0,00 €" se lee como que el activo
                              fue gratis (y el resultado, un regalo). Va un guion;
                              el aviso de la columna de resultado lo explica. */}
                          {hasValues && (
                            <td className="px-3 py-2.5 text-right text-slate-500 tabular-nums whitespace-nowrap">
                              {r.avg_buy_price ? fmt(convertNative(r.avg_buy_price, r.currency), selectedCurrency) : '—'}
                            </td>
                          )}
                          {hasValues && (
                            <td className="px-3 py-2.5 text-right text-slate-500 tabular-nums whitespace-nowrap">
                              {r.price != null ? fmt(convertNative(r.price, r.currency), selectedCurrency) : '—'}
                            </td>
                          )}
                          <td className="px-5 py-2.5 text-right whitespace-nowrap">
                            <span className={`font-bold tabular-nums ${pos ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'}`}>
                              {pos ? '+' : ''}{fmtD(r.profit_eur)}
                            </span>
                            {r.profit_pct != null && (
                              <span className="block text-[10px] text-slate-400 tabular-nums">{fmtPct(r.profit_pct)}</span>
                            )}
                            {/* Una venta sin compra registrada tiene coste 0, así
                                que su % es una ficción; se marca en vez de
                                enseñarlo como si fuera bueno. */}
                            {r.partial_cost && (
                              <span className="block text-[10px] text-amber-600 dark:text-amber-400">{t('share.sales_partial_cost')}</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {realizedSalesTotal > realizedSales.length && (
                <p className="px-5 py-2.5 text-[10px] text-slate-400 border-t border-slate-100 dark:border-slate-800">
                  {t('share.sales_truncated', { shown: realizedSales.length, total: realizedSalesTotal })}
                </p>
              )}
            </motion.div>
          )}

          {/* ── Footer ── */}
          <div className="text-center space-y-3 py-4">
            <p className="text-xs text-slate-400 max-w-sm mx-auto leading-relaxed">{t('share.public_disclaimer')}</p>
            <Link
              to="/auth"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-blue-500 hover:bg-blue-400 text-white text-sm font-bold transition-colors shadow-lg shadow-blue-500/25"
            >
              <ExternalLink className="w-4 h-4" />
              {t('share.public_cta')}
            </Link>
            <p className="text-xs text-slate-400">Trazza · {t('share.public_footer_tagline')}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
