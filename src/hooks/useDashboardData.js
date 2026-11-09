/**
 * Carga y valoración en vivo del Dashboard. Vivía inline en `pages/Dashboard.jsx`
 * (~600 líneas); se extrae con el mismo patrón que `usePositions` para la
 * pantalla de brokers: la página pinta, el hook trae y valora.
 *
 * Reglas que se conservan de la página (ver CLAUDE.md):
 * - Gate `initReady`: nada se carga antes de leer la divisa de las preferencias.
 * - Un fallo al cargar brokers/posiciones/transacciones SE AVISA: unos ceros en
 *   silencio son indistinguibles de una cuenta vacía.
 * - `brokers.length` en las deps de la carga: si la lista llega tarde, se recarga.
 * - Cotizaciones en POOL (`runPooled`), nunca en ráfaga.
 * - El precio vivo se convierte a la divisa de CADA asset antes de valorarlo
 *   (`convertQuotePrice`). No se escribe en `assets`: el precio de la tabla
 *   compartida lo escribe solo el cron del server (server/lib/assetPrices.js).
 *
 * Lo que NO se trajo de la página, a propósito: una descarga del histórico de 1
 * año de cada ticker y de cada divisa que se guardaba en un estado que ya no leía
 * nadie (restos de un panel de analítica retirado). Eran decenas de peticiones a
 * Yahoo por carga, gastadas a cuenta de las que sí hacen falta.
 */
import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/customSupabaseClient';
import { useToast } from '@/components/ui/use-toast';
import { usePortfolioData } from '@/contexts/PortfolioDataContext';
import { yahooFinanceService } from '@/services/yahooFinance';
import { marketDataService } from '@/services/marketDataService';
import { runPooled, withRetry } from '@/lib/asyncPool';
import { currencyService } from '@/services/currencyService';
import { resolveTicker } from '@/lib/tickerMap';
import { countryFromTicker } from '@/lib/listingCountry';
import { computeHistoryTotals, computeInvestedHybrid, computePositionsFingerprint } from '@/services/portfolioHistory';
import { computeEmbeddedCommissionsFallback, computeInvestedMarketValue } from '@/services/portfolioStats';
import { computeUnsavedCsvTotals, groupInvestedByTicker } from '@/services/dashboardTotals';
import { resolveQuoteSymbol, isQuotableSymbol, mergeTickerMaps } from '@/services/quoteSymbol';
import { convertQuotePrice } from '@/services/quotePricing';
import { isCashPosition, isHeldInvestedPosition } from '@/lib/positionKind';
import { getFundExposure } from '@/services/fundExposure';
import { loadFundSectorWeights } from '@/services/fundSectors';
import { earningsService } from '@/services/earningsService';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { preferredCurrencyOf } from '@/lib/preferredCurrency';
import { assetDisplayName } from '@/services/assetDisplayName';

const SELECTED_BROKER_KEY = 'trazza_selected_broker';

export const EMPTY_PORTFOLIO_DATA = Object.freeze({
  totalInvested: 0,
  totalBuyCost: 0,
  totalWealth: 0,
  cashPosition: 0,
  positions: [],
  weightsData: [],
  treemapData: [],
  dailyChangeAbs: 0,
  dailyChangePct: 0,
  isMarketOpen: false,
  totalGainAbs: 0,
  totalGainPct: 0,
  totalDividends: 0,
  totalFees: 0,
  realizedGain: 0,
  portfolioStartDate: null,
});

const readSelectedBroker = () => {
  try { return localStorage.getItem(SELECTED_BROKER_KEY) || 'general'; } catch { return 'general'; }
};

const sumConverted = (positions, currency, rates, valueOf) => positions.reduce((sum, p) => {
  const cur = p.assets?.currency || 'EUR';
  const rate = cur === currency ? 1 : (rates[cur] || 1);
  return sum + valueOf(p) * rate;
}, 0);

/** Posiciones, transacciones e imported_data del alcance. Los `error` se propagan. */
async function fetchScopeRows(userId, brokerFilter) {
  const { data: positions, error: positionsErr } = await supabase
    .from('positions')
    .select(`*, assets (*)`)
    .in('broker_id', brokerFilter);
  if (positionsErr) throw new Error(`positions: ${positionsErr.message}`);
  const validPositions = positions || [];

  // Filtro por position_id (fiable) y no por positions.broker_id embebido, que
  // PostgREST puede ignorar en silencio y perder ventas (ver usePositions).
  const positionIds = validPositions.map((p) => p.id);
  const [{ data: allTrans, error: transErr }, { data: importedDataRows }] = await Promise.all([
    positionIds.length > 0
      ? supabase.from('transactions')
          .select('*, positions(broker_id, assets(currency, ticker, isin))')
          .in('position_id', positionIds)
      : Promise.resolve({ data: [] }),
    supabase.from('imported_data')
      .select('broker_id, transactions, ticker_map')
      .eq('user_id', userId)
      .in('broker_id', brokerFilter),
  ]);
  if (transErr) throw new Error(`transactions: ${transErr.message}`);
  return { validPositions, validTrans: allTrans || [], importedDataRows: importedDataRows || [] };
}

/**
 * Totales históricos de las transacciones de BD. Atajo: la pantalla de brokers
 * publica los suyos en portfolio_metrics_cache; si coinciden alcance, divisa,
 * número de transacciones y huella de posiciones, se usan tal cual. Si no, se
 * recalcula con LA MISMA función que usa brokers (la caché nunca es requisito).
 */
async function loadDbHistory({ userId, scope, currency, rates, validTrans, validPositions }) {
  try {
    const { data: cacheRow } = await supabase
      .from('portfolio_metrics_cache')
      .select('currency, metrics')
      .eq('user_id', userId)
      .eq('scope', scope)
      .maybeSingle();
    if (cacheRow?.currency === currency
        && cacheRow.metrics?.txCount === validTrans.length
        && cacheRow.metrics?.posFingerprint === computePositionsFingerprint(validPositions)) {
      return cacheRow.metrics;
    }
  } catch { /* tabla de caché inaccesible — se recalcula abajo */ }

  const history = await computeHistoryTotals(validTrans, currency, rates);
  return { ...history, investedHybrid: computeInvestedHybrid(validPositions, history, rates) };
}

/**
 * Cotiza cada grupo del treemap (en pool), escribe el precio a CADA asset en SU
 * divisa (fire-and-forget, tras el guard) y devuelve baldosas + precios vivos.
 */
async function fetchLiveValuation(groups, currency, rates) {
  const treemapItems = [];
  const livePriceByTicker = {};   // ticker → { price, currency } en la divisa de la COTIZACIÓN
  const liveRates = { ...rates }; // copia: `rates` alimentó computeHistoryTotals
  let dailyChangeAbs = 0;
  let marketOpenCount = 0;

  await runPooled(groups.map((group) => async () => {
    // Fondo monetario (MyInvestor `[importe]`): la cantidad son euros y vale 1
    // por unidad. No se cotiza, pero su baldosa tiene valor; sin variación diaria.
    if (group.isMonetary) {
      const value = group.members.reduce((s, m) => s + m.quantity * Number(liveRates[m.currency] ?? 1), 0);
      treemapItems.push({
        name: group.name, ticker: group.name, isFund: true,
        size: 0.1, value, change: null, marketState: 'CLOSED',
      });
      return;
    }
    try {
      // Sin símbolo cotizable (nombre de fondo sin resolver): no se cotiza.
      const quote = !isQuotableSymbol(group.ticker)
        ? null
        : await withRetry(() => marketDataService.getQuote(group.ticker)).catch(() => null);
      if (!quote) throw new Error('No quote');

      const currentPrice = Number(quote.current || 0);
      const quoteCur = (quote.currency || group.currency || 'EUR').toUpperCase();
      if (!(quoteCur in liveRates)) {
        try { liveRates[quoteCur] = await currencyService.getExchangeRate(quoteCur, currency); }
        catch { liveRates[quoteCur] = 1; }
      }

      if (currentPrice > 0) {
        livePriceByTicker[group.ticker] = { price: currentPrice, currency: quoteCur };
      }

      const mState = quote.marketState || 'CLOSED';
      if (mState === 'REGULAR') marketOpenCount++;

      const perMember = (raw) => group.members.reduce((s, m) => {
        const rate = Number(liveRates[m.currency] ?? 1);
        return s + m.quantity * convertQuotePrice(raw, quoteCur, m.currency, liveRates) * rate;
      }, 0);
      const val = perMember(currentPrice);
      const dailyChg = perMember(Number(quote.change || 0));
      const pPct = Number(quote.percentChange || 0);

      // La variación vs el cierre anterior vale en cualquier sesión salvo PRE.
      if (mState !== 'PRE' && Number.isFinite(dailyChg)) dailyChangeAbs += dailyChg;

      treemapItems.push({
        name: group.name,
        ticker: group.ticker || group.name,
        isFund: group.isFund,
        size: Math.max(Number.isFinite(pPct) ? Math.abs(pPct) : 0, 0.1),
        value: Number.isFinite(val) ? val : 0,
        // null, NO 0: un fondo no publica variación diaria y un 0 lo pintaba de verde.
        change: Number.isFinite(pPct) ? pPct : null,
        marketState: mState,
      });
    } catch {
      treemapItems.push({
        name: group.name, ticker: group.ticker || group.name, isFund: group.isFund,
        size: 0.01, value: 0, change: null, marketState: 'CLOSED',
      });
    }
  }));

  const totalTreemapVal = treemapItems.reduce((s, i) => s + i.value, 0);
  const withWeights = treemapItems.map((item) => ({
    ...item,
    weight: totalTreemapVal > 0 ? (item.value / totalTreemapVal) * 100 : 0,
  }));
  return { treemapItems: withWeights, livePriceByTicker, liveRates, dailyChangeAbs, isMarketOpen: marketOpenCount > 0 };
}

/**
 * Rellena sector/industria/país que falten (en pool, perfil de Yahoo) y los
 * persiste vía RPC (fill-only-when-null en servidor). Devuelve asset_id → cambios.
 */
async function enrichMissingSectors(assets) {
  const uniqueAssets = Array.from(new Set(assets.map((p) => p.asset_id)))
    .map((id) => assets.find((p) => p.asset_id === id))
    .filter((p) => !p.assets?.sector || !p.assets?.country || !p.assets?.industry);
  const enriched = {};
  if (uniqueAssets.length === 0) return enriched;

  await runPooled(uniqueAssets.map((asset) => async () => {
    const rawTicker = asset.assets?.ticker || '';
    if (!rawTicker || rawTicker.startsWith('CASH')) return;
    const updates = {};

    if (!asset.assets?.country) {
      const derived = countryFromTicker(rawTicker);
      if (derived) updates.country = derived;
    }
    if (!asset.assets?.sector || !asset.assets?.industry) {
      try {
        const ticker = resolveTicker(rawTicker) || rawTicker;
        if (ticker && ticker !== 'CASH') {
          const profile = await yahooFinanceService.getProfile(ticker);
          if (profile?.sector && !asset.assets?.sector) updates.sector = profile.sector;
          if (profile?.industry && !asset.assets?.industry) updates.industry = profile.industry;
          if (profile?.country && !asset.assets?.country) updates.country = profile.country;
          if (profile?.type && !asset.assets?.asset_class) updates.asset_class = profile.type;
        }
      } catch (e) {
        console.warn(`[enrich] getProfile failed for ${rawTicker}:`, e.message);
      }
    }
    if (Object.keys(updates).length === 0) return;

    enriched[asset.asset_id] = updates;
    supabase.rpc('update_asset_metadata', {
      p_asset_id: asset.asset_id,
      p_sector: updates.sector || null,
      p_asset_class: updates.asset_class || null,
      p_country: updates.country || null,
      p_industry: updates.industry || null,
    }).then(({ error }) => { if (error) console.warn('[enrich] asset DB write:', error.message); });
  }));
  return enriched;
}

/**
 * @param {{ id: string } | null} user
 * @returns datos del Dashboard + `reload` (el botón de refrescar) y el filtro de broker
 */
export function useDashboardData(user) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { setPortfolioSnapshot } = usePortfolioData();
  const userId = user?.id;

  const [loading, setLoading] = useState(true);
  const [brokersReady, setBrokersReady] = useState(false);
  // Preferencias: la fila compartida (UserPreferencesContext), no una lectura propia.
  const { preferences, loading: prefsLoading, error: prefsError } = useUserPreferences();
  const currency = preferredCurrencyOf(preferences);
  // Gate: nada se carga antes de conocer la divisa NI la lista de brokers.
  const initReady = brokersReady && !prefsLoading;
  const [brokers, setBrokers] = useState([]);
  const brokersRef = useRef([]);
  const [selectedBrokerId, setSelectedBrokerId] = useState(readSelectedBroker);
  const [exchangeRates, setExchangeRates] = useState({});
  const [portfolioData, setPortfolioData] = useState(EMPTY_PORTFOLIO_DATA);
  // ticker → [{sector, weight}] de los fondos (Yahoo topHoldings, caché 24 h)
  const [fundSectorWeights, setFundSectorWeights] = useState({});

  const reportLoadError = (e) => toast({
    variant: 'destructive',
    title: t('dashboard.load_error_title'),
    description: e?.message || t('dashboard.load_error_desc'),
  });

  // Este fallo NO se traga: sin brokers la carga pinta ceros, indistinguibles de
  // una cuenta vacía ("solo me carga Favoritos"). Propaga y el init avisa.
  const loadBrokers = async () => {
    const { data, error } = await supabase.from('brokers').select('*').eq('user_id', userId);
    if (error) throw error;
    brokersRef.current = data || [];
    setBrokers(data || []);
  };

  // API key opcional de EODHD para el calendario de resultados.
  useEffect(() => {
    if (preferences?.eodhd_api_key) earningsService.setEodhdKey(preferences.eodhd_api_key);
  }, [preferences?.eodhd_api_key]);

  // Un fallo al leer las preferencias se avisa (la divisa caería al defecto).
  useEffect(() => {
    if (prefsError) reportLoadError(new Error(`user_preferences: ${prefsError.message}`));
  }, [prefsError]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadDashboardData = async () => {
    try {
      setLoading(true);
      const { data: portfolios, error: portfoliosErr } = await supabase
        .from('portfolios').select('id').eq('user_id', userId).limit(1);
      if (portfoliosErr) throw new Error(`portfolios: ${portfoliosErr.message}`);
      if (!portfolios?.length) return;

      const brokerFilter = selectedBrokerId === 'general'
        ? brokersRef.current.map((b) => b.id)
        : [selectedBrokerId];
      if (brokerFilter.length === 0) return;

      const { validPositions, validTrans, importedDataRows } = await fetchScopeRows(userId, brokerFilter);
      const cashAssets = validPositions.filter(isCashPosition);
      // Sin las cerradas (qty 0): el treemap dimensiona por variación diaria, no por valor.
      const investedAssets = validPositions.filter(isHeldInvestedPosition);

      // EUR siempre: las comisiones van facturadas en EUR (DeGiro/IBKR).
      const uniqueCurs = [...new Set([
        ...validPositions.map((p) => p.assets?.currency),
        ...validTrans.map((tx) => tx.positions?.assets?.currency),
        'EUR',
      ])].filter(Boolean);

      // En segundo plano: el quesito pinta su respaldo hasta que llegan.
      enrichMissingSectors(investedAssets).then((enriched) => {
        if (Object.keys(enriched).length === 0) return;
        setPortfolioData((prev) => ({
          ...prev,
          positions: prev.positions.map((p) => (enriched[p.asset_id]
            ? { ...p, assets: { ...p.assets, ...enriched[p.asset_id] } }
            : p)),
        }));
      });

      const rates = {};
      await Promise.all(uniqueCurs.map(async (cur) => {
        rates[cur] = await currencyService.getExchangeRate(cur, currency);
      }));
      setExchangeRates(rates);

      // La liquidez: la cantidad ES el importe (no multiplicar por current_price).
      const totalCashConverted = sumConverted(cashAssets, currency, rates, (p) => parseFloat(p.quantity));
      const totalInvestedConverted = sumConverted(investedAssets, currency, rates,
        (p) => parseFloat(p.quantity) * parseFloat(p.entry_price || 0));
      const investedValueConverted = computeInvestedMarketValue(investedAssets, rates).toNumber();

      // Brokers guardados (con filas en `transactions`) y sin guardar (solo en
      // imported_data) son conjuntos DISJUNTOS: nunca se procesa uno por los dos lados.
      const savedBrokerIdSet = new Set(validTrans.map((tx) => tx.positions?.broker_id).filter(Boolean));
      const dbHistory = await loadDbHistory({
        userId, scope: selectedBrokerId, currency, rates, validTrans, validPositions,
      });
      const csv = computeUnsavedCsvTotals(
        importedDataRows
          .filter((r) => !savedBrokerIdSet.has(r.broker_id))
          .flatMap((r) => (r.transactions || []).map((tx) => ({ ...tx, _brokerId: r.broker_id }))),
        currency, rates,
      );
      let portfolioStartDate = dbHistory.firstTransactionDate;
      if (csv.firstBuyDate && (!portfolioStartDate || csv.firstBuyDate < portfolioStartDate)) {
        portfolioStartDate = csv.firstBuyDate;
      }

      // Cada fuente de comisiones cuenta UNA vez (misma composición que brokers).
      const eurRate = currency === 'EUR' ? 1 : (rates.EUR || 1);
      const savedEmbeddedComisiones = computeEmbeddedCommissionsFallback({
        importedTransactionsByBroker: Object.fromEntries(importedDataRows.map((r) => [r.broker_id, r.transactions || []])),
        savedBrokerIds: savedBrokerIdSet,
        tradeCommissionsByBroker: dbHistory.tradeCommissionsByBroker,
        selectedBrokerId: 'general', // importedDataRows ya va acotado por brokerFilter
        eurRate,
      });
      const realizedGain = dbHistory.realized + csv.realizedGain;
      const totalDivs = dbHistory.dividends + csv.totalDivs;
      const totalFees = dbHistory.fees + dbHistory.tradeCommissions + savedEmbeddedComisiones
        + (csv.totalFees + csv.embeddedComisiones) * eurRate;
      const mergedBuyCost = dbHistory.totalBuyCost + csv.totalBuyCost;

      const totalValue = investedValueConverted + totalCashConverted;
      const weightsItems = investedAssets.map((p) => {
        const cur = p.assets?.currency || 'EUR';
        const rate = cur === currency ? 1 : (rates[cur] || 1);
        const val = parseFloat(p.quantity) * parseFloat(p.assets?.current_price || p.entry_price || 0) * rate;
        return {
          name: assetDisplayName(p.assets) || 'Asset',
          weight: totalValue > 0 ? (val / totalValue) * 100 : 0,
          ticker: p.assets?.ticker,
          value: val,
        };
      }).sort((a, b) => b.weight - a.weight);

      const dynamicTickerMap = mergeTickerMaps(importedDataRows);
      const live = await fetchLiveValuation(groupInvestedByTicker(investedAssets, dynamicTickerMap), currency, rates);

      // Valor con precios vivos (con respaldo al de BD), convertidos a la divisa de
      // cada posición y valorados con LA MISMA función que "Valor en Mercado".
      const livePricedPositions = investedAssets.map((p) => {
        const ticker = resolveQuoteSymbol(p.assets?.ticker, dynamicTickerMap);
        const lp = ticker ? live.livePriceByTicker[ticker] : null;
        if (!lp) return p;
        const cur = p.assets?.currency || 'EUR';
        return { ...p, assets: { ...p.assets, current_price: convertQuotePrice(lp.price, lp.currency, cur, live.liveRates) } };
      });
      const liveInvestedValue = computeInvestedMarketValue(livePricedPositions, live.liveRates).toNumber();
      const liveTotal = liveInvestedValue + totalCashConverted;

      // Coste base híbrido (igual que brokers): caché → FIFO de BD + CSV sin
      // guardar (disjuntos, se SUMAN) → entry_price como último recurso.
      const hybrid = dbHistory.investedHybrid ?? (dbHistory.openPositionCost + csv.costBasis);
      const effectiveCostBasis = hybrid > 0 ? hybrid : totalInvestedConverted;
      const totalGainAbs = (liveInvestedValue - effectiveCostBasis) + realizedGain + totalDivs - totalFees;
      const totalCapitalDeployed = mergedBuyCost > 0 ? mergedBuyCost : (effectiveCostBasis > 0 ? effectiveCostBasis : 1);
      const totalGainPct = totalGainAbs / totalCapitalDeployed * 100;
      const dailyChangePct = liveTotal > 0 ? (live.dailyChangeAbs / liveTotal) * 100 : 0;
      const totalInvested = effectiveCostBasis > 0 ? effectiveCostBasis : totalInvestedConverted;

      setPortfolioData({
        totalInvested,
        totalBuyCost: mergedBuyCost,
        totalWealth: liveTotal,
        cashPosition: totalCashConverted,
        positions: validPositions,
        weightsData: weightsItems,
        treemapData: live.treemapItems,
        dailyChangeAbs: live.dailyChangeAbs,
        dailyChangePct,
        isMarketOpen: live.isMarketOpen,
        totalGainAbs,
        totalGainPct,
        totalDividends: totalDivs,
        totalFees,
        realizedGain,
        portfolioStartDate,
      });

      // Para el chat, la puntuación y la pantalla de Gastos. `scope` dice qué
      // brokers cubre: el patrimonio de Gastos ignora un snapshot de un solo broker.
      setPortfolioSnapshot({
        scope: selectedBrokerId,
        positions: validPositions,
        brokers: brokersRef.current,
        totalWealth: liveTotal,
        totalInvested,
        totalBuyCost: mergedBuyCost,
        cashPosition: totalCashConverted,
        totalDividends: totalDivs,
        totalFees,
        totalGainAbs,
        totalGainPct,
        realizedGain,
        dailyChangePct,
        exchangeRates: rates,
        currency,
      });
    } catch (e) {
      console.error(e);
      reportLoadError(e);
    } finally {
      setLoading(false);
    }
  };

  // Init: brokers antes de abrir el gate (las preferencias las trae el contexto).
  // Por userId (string): una referencia nueva del mismo usuario no repite la carga.
  useEffect(() => {
    if (!userId) return;
    setBrokersReady(false);
    (async () => {
      try {
        await loadBrokers();
      } catch (e) {
        console.error('[dashboard] init:', e);
        reportLoadError(e);
      } finally {
        // Se abre igual: la carga corre y avisa de SUS errores en vez de dejar
        // la pantalla en ceros sin decir nada.
        setBrokersReady(true);
      }
    })();
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  // `brokers.length` es la red de seguridad: la carga lee brokersRef, así que si
  // la lista llegó tarde, sin esto el Dashboard se quedaba en ceros.
  useEffect(() => {
    if (initReady && userId) loadDashboardData();
  }, [initReady, currency, selectedBrokerId, brokers.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    try { localStorage.setItem(SELECTED_BROKER_KEY, selectedBrokerId); } catch { /* sin almacenamiento */ }
  }, [selectedBrokerId]);

  // Pesos sectoriales reales de los fondos, cuando hay posiciones. En segundo
  // plano: el quesito enseña el cubo de fundExposure hasta que llegan.
  useEffect(() => {
    const fundTickers = (portfolioData.positions || [])
      .filter((p) => parseFloat(p.quantity) > 0.0001 && getFundExposure(p.assets))
      .map((p) => p.assets?.ticker)
      .filter(Boolean);
    if (fundTickers.length === 0) return;
    let cancelled = false;
    loadFundSectorWeights(fundTickers).then((weights) => {
      if (!cancelled && Object.keys(weights).length > 0) {
        setFundSectorWeights((prev) => ({ ...prev, ...weights }));
      }
    });
    return () => { cancelled = true; };
  }, [portfolioData.positions]);

  return {
    loading,
    preferences,
    currency,
    brokers,
    selectedBrokerId,
    setSelectedBrokerId,
    exchangeRates,
    portfolioData,
    fundSectorWeights,
    reload: loadDashboardData,
  };
}
