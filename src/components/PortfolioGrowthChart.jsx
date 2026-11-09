import { useState, useEffect, useMemo } from 'react';
import Decimal from 'decimal.js';
import { Loader2, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';


import { useSupabaseAuth } from '@/contexts/SupabaseAuthContext';
import { usePrivacyMode } from '@/contexts/PrivacyModeContext';
import { usePortfolioPerformance } from '@/hooks/usePortfolioPerformance';
import { mergeBenchmarkSeries } from '@/services/performanceService';
import { localTodayIso, parseIsoDateLocal } from '@/lib/dates';
import { oneDayWindow } from '@/lib/growthWindow';

import { GrowthChartHeader }   from './charts/GrowthChartHeader';
import { GrowthChartCanvas, GrowthChartLegend } from './charts/GrowthChartCanvas';
import { GrowthChartExplainer } from './charts/GrowthChartExplainer';

const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CHF: 'Fr' };
const getCurrencySymbol = (c) => CURRENCY_SYMBOLS[c] || c || '€';

// TWR mode (the FX-blind price-only chain) was removed after the financial audit:
// it showed a different number than TTWROR for "the same thing" — the difference
// being silently-ignored currency P&L. TTWROR is the portfolio TWR.
export const MODES = {
  TTWROR:  { color: '#3b82f6', gradId: 'gradTTWROR',  label: 'TTWROR',  desc: 'True Time-Weighted Return' },
  ROI:     { color: '#8b5cf6', gradId: 'gradROI',     label: 'ROI',     desc: 'ROI Simple (coste base)' },
};

// ─────────────────────────────────────────────────────────────────────────────
// Period filtering + geometric TTWROR rebase
// Pure function — no side effects, easy to unit-test.
// ─────────────────────────────────────────────────────────────────────────────
function applyPeriodFilter(performanceData, { timeRange, customStart, customEnd }) {
  if (!performanceData.length) return [];

  let filtered = [...performanceData];
  const now = new Date();

  // Los límites se comparan como 'YYYY-MM-DD' (texto): new Date(d.date) es
  // medianoche UTC y, al oeste de UTC, dejaba fuera el primer día del rango.
  const since = (l) => { const from = localTodayIso(l); filtered = filtered.filter(d => d.date >= from); };
  if      (timeRange === '1D')  filtered = oneDayWindow(filtered); // una sesión, no dos (ver lib/growthWindow)
  else if (timeRange === '1W')  { const l = new Date(now); l.setDate(now.getDate() - 7); since(l); }
  else if (timeRange === '6M')  { const l = new Date(now); l.setMonth(now.getMonth() - 6); since(l); }
  else if (timeRange === '1Y')  { const l = new Date(now); l.setFullYear(now.getFullYear() - 1); since(l); }
  else if (timeRange === 'YTD') since(new Date(now.getFullYear(), 0, 1));
  else if (/^\d{4}$/.test(timeRange)) filtered = filtered.filter(d => d.date.startsWith(timeRange));
  else if (timeRange === 'CUSTOM') {
    if (customStart) filtered = filtered.filter(d => d.date >= customStart);
    if (customEnd)   filtered = filtered.filter(d => d.date <= customEnd);
  }

  return filtered;
}

function rebaseFiltered(filtered) {
  if (!filtered.length) return [];

  const startYield = filtered[0].yield ?? 0;
  const startFactor = (startYield / 100) + 1;
  const safeStartFactor = startFactor > 0.01 ? startFactor : 1;

  // ROI rebase base: the range must start at 0% like the TTWROR line does.
  const startROIFactor = ((filtered[0].simpleROI ?? 0) / 100) + 1;
  const safeStartROI = startROIFactor > 0.01 ? startROIFactor : 1;

  let cumTTWROR = new Decimal(1);

  return filtered.map((d) => {
    const factor = ((d.yield ?? 0) / 100) + 1;
    const normalizedYield = (factor / safeStartFactor - 1) * 100;

    cumTTWROR = cumTTWROR.times(new Decimal(1).plus(new Decimal(d.isolatedTTWROR || 0)));
    const normalizedTTWROR = cumTTWROR.minus(1).times(100).toNumber();

    // ROI is ALWAYS rebased to the first point of the range (incl. "ALL"), so the
    // line starts at 0% exactly like the TTWROR line. Previously "ALL" showed the
    // raw absolute simpleROI, which for a position opened mid-period carries the
    // buy-day baseline artifact (series value uses adjClose/historical FX while the
    // cost uses the actual trade price), making "ALL" disagree in SIGN with "YTD"
    // even though they span the same days. Rebasing cancels that constant cost
    // offset and keeps every range internally consistent.
    const f = ((d.simpleROI ?? 0) / 100) + 1;
    const normalizedSimpleROI = (f / safeStartROI - 1) * 100;

    return { ...d, normalizedYield, normalizedTTWROR, normalizedSimpleROI, displayYield: normalizedYield.toFixed(2) };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

const PortfolioGrowthChart = ({
  currency = 'EUR',
  brokerId = 'general',
  onPerformanceCalculated,
  totalReturnPct,
  breakdownStats = null,
}) => {
  const { user } = useSupabaseAuth();
  const { privacyMode } = usePrivacyMode();
  const { t, i18n } = useTranslation();

  // ── UI state ───────────────────────────────────────────────────────────────
  const [timeRange, setTimeRange]       = useState('ALL');
  const [chartMode, setChartMode]       = useState('TTWROR');
  const [displayType, setDisplayType]   = useState('PERCENTAGE');
  const [showExplainer, setShowExplainer] = useState(false);
  const [customStart, setCustomStart]   = useState('');
  const [customEnd, setCustomEnd]       = useState('');

  // ── El ROI solo se ofrece en el rango completo ─────────────────────────────
  // Sobre un tramo, `rebaseFiltered` reencuadra la línea a 0% en su primera
  // fecha, así que lo que se pinta deja de ser una rentabilidad: es el cambio
  // del múltiplo valor/coste. Y una aportación suma los MISMOS euros al valor y
  // al coste, lo que arrastra ese múltiplo hacia 1 —hacia el 0%— por bien que
  // vaya el mercado. Caso real del owner: TTWROR YTD +19,79% con el titular del
  // ROI en −2,39%, y la plusvalía latente casi duplicada en ese mismo periodo.
  // El número era correcto y no respondía a ninguna pregunta que se haga quien
  // mira su cartera; lo que medía, sobre todo, era su calendario de aportaciones.
  //
  // Mismo criterio que se aplicó a `gainPercent` en la pantalla de brokers
  // (2026-09-11): la métrica se sigue calculando, lo que se retira es el sitio
  // donde convivía con otra que mide algo distinto e invitaba a compararlas.
  //
  // Se DERIVA en lugar de corregir el estado desde un efecto: así el modo que se
  // pinta y el rango no pueden desincronizarse ni un solo render, y al volver a
  // ALL se recupera el ROI que el usuario había elegido.
  const effectiveChartMode = timeRange === 'ALL' ? chartMode : 'TTWROR';

  // ── S&P 500 benchmark ──────────────────────────────────────────────────────
  const [showSP500, setShowSP500]       = useState(false);
  const [sp500Data, setSp500Data]       = useState([]);
  const [sp500Loading, setSp500Loading] = useState(false);

  useEffect(() => {
    if (!showSP500 || sp500Data.length > 0) return;
    setSp500Loading(true);
    // ^SP500TR (total return, dividends reinvested): the portfolio's TTWROR includes
    // dividends via adjclose, so benchmarking against the price-only ^GSPC flattered
    // the portfolio by ~1.5-2 pp/year.
    fetch('/api/yahoo/v8/finance/chart/%5ESP500TR?range=10y&interval=1d')
      .then(r => r.json())
      .then(data => {
        const result = data.chart?.result?.[0];
        if (!result) return;
        const ts = result.timestamp || [];
        const closes = result.indicators?.quote?.[0]?.close || [];
        setSp500Data(
          ts.map((t, i) => ({ date: new Date(t * 1000).toISOString().split('T')[0], close: closes[i] }))
            .filter(p => p.close != null)
        );
      })
      .catch(e => console.error('[SP500]', e))
      .finally(() => setSp500Loading(false));
  }, [showSP500]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Performance data (hook) ────────────────────────────────────────────────
  const { data: performanceData, loading, currentHoldingNames, missingTickers } = usePortfolioPerformance({
    userId: user?.id,
    brokerId,
    currency,
    onCalculated: onPerformanceCalculated,
  });

  // ── Period filtering + rebase ─────────────────────────────────────────────
  const filteredData = useMemo(() => {
    const filtered = applyPeriodFilter(performanceData, { timeRange, customStart, customEnd });
    const rebased  = rebaseFiltered(filtered);

    // El benchmark solo se cruza con el TTWROR. Ver `benchmarkApplies`.
    if (!showSP500 || effectiveChartMode !== 'TTWROR' || !sp500Data.length || !rebased.length) return rebased;

    // Regla del benchmark (base = cierre anterior al primer día INVERTIDO):
    // vive en `mergeBenchmarkSeries`, compartida con la pantalla de brokers.
    // En 1D el primer punto es solo la base: el índice se cruza con la última
    // sesión (base = cierre de la base) y la base arranca en 0.
    if (rebased[0]?.isOneDayBase) {
      return [{ ...rebased[0], sp500Return: 0 }, ...mergeBenchmarkSeries(rebased.slice(1), sp500Data, { dateKey: 'date' })];
    }
    return mergeBenchmarkSeries(rebased, sp500Data, { dateKey: 'date' });
  }, [performanceData, timeRange, customStart, customEnd, showSP500, sp500Data, effectiveChartMode]);

  // ── Derived display values ─────────────────────────────────────────────────
  const yieldKey = effectiveChartMode === 'ROI' ? 'normalizedSimpleROI' : 'normalizedTTWROR';
  const activeDataKey = displayType === 'VALUE' ? 'value' : yieldKey;

  const last      = filteredData.length > 0 ? filteredData[filteredData.length - 1] : null;
  const first     = filteredData.length > 0 ? filteredData[0] : null;
  const lastValue  = last?.value ?? 0;
  const firstValue = first?.value ?? 0;
  const lastCost   = last?.cumulativeCost ?? 0;
  const firstCost  = first?.cumulativeCost ?? 0;
  // Net external flows over the period: buys − sell proceeds (cumulativeNetFlow).
  // The old cumulativeCost diff only counted BUYs, so any SELL in the period skewed
  // "Ganancia periodo". Falls back to cumulativeCost for series without the field.
  const netCashFlows = (last?.cumulativeNetFlow ?? lastCost) - (first?.cumulativeNetFlow ?? firstCost);
  const periodAbsoluteGain = (lastValue - firstValue) - netCashFlows;
  const latestSP           = last?.sp500Return ?? null;

  // ── ¿Se puede comparar con el índice? ──────────────────────────────────────
  // Solo en TTWROR. El TWR encadena rendimientos diarios y es INMUNE a cuándo
  // metiste el dinero — por eso es la medida que se puede poner al lado de un
  // índice. El ROI divide por el coste base, que cambia con cada compra: aportar
  // justo antes de una subida lo diluye aunque el mercado haya hecho lo mismo,
  // así que enfrentarlo al S&P mide tu calendario de aportaciones, no tu acierto.
  // (Y desde 2026-09-11 el último punto del ROI en rango completo usa precios
  // VIVOS mientras el índice va a cierre: ni siquiera serían el mismo instante.)
  const benchmarkApplies = effectiveChartMode === 'TTWROR';

  const sym             = getCurrencySymbol(currency);
  const modeConfig      = MODES[effectiveChartMode] ?? MODES.TTWROR;
  const displayMarketValue = breakdownStats?.liveInvested ?? lastValue;
  const displayCostBasis   = breakdownStats?.capitalInvertido ?? lastCost;

  // ── ROI: el MISMO número que la pantalla de brokers ────────────────────────
  // La serie valora con el último CIERRE diario; la cabecera de brokers, con
  // precios vivos. Mismo coste base y distinto valor = dos ROI que no cuadran
  // (medido con la cartera del owner: 22,67% aquí contra 22,07% allí — 26.245 €
  // de coste en ambos, 32.196 € de valor contra 32.038 €). Con el rango completo
  // el % se deriva de los DOS números que esta misma tarjeta ya enseña en vivo
  // (valor de mercado ÷ capital invertido), que es exactamente
  // (investedValue − investedHybrid) / investedHybrid, la definición del chip
  // "ROI Cartera actual". Solo en 'ALL': en un rango corto el ROI que se pinta
  // es el rebasado del periodo, y un absoluto ahí respondería a otra pregunta.
  const liveRoiPct = (
    effectiveChartMode === 'ROI' &&
    breakdownStats?.liveInvested != null && displayCostBasis > 0 &&
    Number.isFinite(displayMarketValue)
  ) ? (displayMarketValue / displayCostBasis - 1) * 100 : null;

  // El último punto de la línea se mueve con el número: si la cabecera dijera
  // 22,07% y el tooltip del último día 22,67%, seguiríamos con dos verdades.
  const chartData = useMemo(() => {
    if (liveRoiPct == null || !filteredData.length) return filteredData;
    const out = filteredData.slice();
    out[out.length - 1] = { ...out[out.length - 1], normalizedSimpleROI: liveRoiPct };
    return out;
  }, [filteredData, liveRoiPct]);

  const latestYieldVal = chartData.length > 0 ? (chartData[chartData.length - 1]?.[yieldKey] ?? 0) : 0;
  const yieldMin = chartData.length > 0 ? Math.min(...chartData.map(d => d[activeDataKey] ?? 0)) : 0;

  const availableYears = useMemo(() => {
    if (!performanceData.length) return [];
    const years = new Set(performanceData.map(d => d.date.substring(0, 4)));
    // Current year excluded — YTD already covers it; a duplicate chip adds noise.
    years.delete(String(new Date().getFullYear()));
    return [...years].sort().reverse();
  }, [performanceData]);

  const xAxisConfig = useMemo(() => {
    const n = filteredData.length;
    if (n === 0) return { interval: 0, formatter: s => s };
    const interval = Math.max(1, Math.floor(n / 8));
    const formatter = dateStr => {
      if (!dateStr) return '';
      // Medianoche LOCAL: new Date('YYYY-MM-DD') es UTC y en América rotulaba el día anterior.
      const d = parseIsoDateLocal(dateStr) || new Date(dateStr);
      const locale = i18n.language.startsWith('es') ? 'es-ES' : 'en-US';
      if (['1D', '1W', '6M', 'YTD'].includes(timeRange)) {
        return d.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
      }
      return d.toLocaleDateString(locale, { month: 'short', year: '2-digit' });
    };
    return { interval, formatter };
  }, [filteredData.length, timeRange, i18n.language]);

  // ── Guards ─────────────────────────────────────────────────────────────────
  if (loading) return (
    <div className="bg-white dark:bg-slate-900 p-6 rounded-2xl border border-slate-200/80 dark:border-slate-700/40 shadow-xs col-span-full h-[420px] flex flex-col items-center justify-center gap-3">
      <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
      <span className="text-slate-500 text-xs font-semibold uppercase tracking-widest">{t('portfolio_growth.calculating')}</span>
    </div>
  );

  if (!performanceData.length) return (
    <div className="bg-white dark:bg-slate-900 p-6 rounded-2xl border border-slate-200/80 dark:border-slate-700/40 shadow-xs col-span-full h-[420px] flex items-center justify-center">
      <span className="text-slate-400 text-sm italic">{t('portfolio_growth.no_data')}</span>
    </div>
  );

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200/60 dark:border-slate-700/40 rounded-2xl overflow-hidden shadow-xs col-span-full">

      <GrowthChartHeader
        displayType={displayType}
        latestYieldVal={latestYieldVal}
        modeConfig={modeConfig}
        sym={sym}
        currency={currency}
        privacyMode={privacyMode}
        displayMarketValue={displayMarketValue}
        displayCostBasis={displayCostBasis}
        periodAbsoluteGain={periodAbsoluteGain}
        incompleteHistory={missingTickers.length > 0}
        timeRange={timeRange}
        onTimeRangeChange={setTimeRange}
        availableYears={availableYears}
        chartMode={effectiveChartMode}
        roiDisabled={timeRange !== 'ALL'}
        onChartModeChange={setChartMode}
        showSP500={showSP500 && benchmarkApplies}
        benchmarkApplies={benchmarkApplies}
        onToggleSP500={() => setShowSP500(v => !v)}
        sp500Loading={sp500Loading}
        customStart={customStart}
        customEnd={customEnd}
        onCustomStartChange={setCustomStart}
        onCustomEndChange={setCustomEnd}
        onToggleDisplayType={() => setDisplayType(d => d === 'PERCENTAGE' ? 'VALUE' : 'PERCENTAGE')}
        onOpenExplainer={() => setShowExplainer(true)}
      />

      {/* Un histórico que no llegó NO es inocuo: el motor valora ese activo a 0
          durante toda la serie y el % sale mal. Antes pasaba en silencio y el
          usuario veía dos números distintos en dos pantallas sin saber por qué. */}
      {missingTickers.length > 0 && (
        <div className="mx-4 mb-3 flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/20 px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
          <p className="text-[11px] leading-snug text-amber-800 dark:text-amber-300">
            {t('portfolio_growth.missing_history', {
              count: missingTickers.length,
              tickers: missingTickers.slice(0, 4).join(', '),
            })}
          </p>
        </div>
      )}

      <GrowthChartCanvas
        data={chartData}
        activeDataKey={activeDataKey}
        chartMode={effectiveChartMode}
        modeConfig={modeConfig}
        displayType={displayType}
        showSP500={showSP500 && benchmarkApplies}
        sym={sym}
        privacyMode={privacyMode}
        currentHoldingNames={currentHoldingNames}
        xAxisConfig={xAxisConfig}
        yieldMin={yieldMin}
      />

      <GrowthChartLegend
        modeConfig={modeConfig}
        displayType={displayType}
        showSP500={showSP500 && benchmarkApplies}
        latestSP={latestSP}
        latestYieldVal={latestYieldVal}
        timeRange={timeRange}
        totalReturnPct={totalReturnPct}
        privacyMode={privacyMode}
      />

      {showExplainer && <GrowthChartExplainer onClose={() => setShowExplainer(false)} />}
    </div>
  );
};

export default PortfolioGrowthChart;
