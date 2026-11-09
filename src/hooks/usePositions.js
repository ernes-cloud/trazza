import { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/customSupabaseClient';
import { useToast } from '@/components/ui/use-toast';
import { currencyService } from '@/services/currencyService';
import { marketDataService } from '@/services/marketDataService';
import { computeHistoryTotals, scaleOpenCostToHeldQty, computeInvestedHybrid, computePositionsFingerprint } from '@/services/portfolioHistory';
import { convertQuotePrice, stalePriceDate } from '@/services/quotePricing';
import { runPooledSettled } from '@/lib/asyncPool';
import { resolveTicker, TICKER_MAP } from '@/lib/tickerMap';
import { positionGroupKey } from '@/lib/positionGroupKey';
import { resolveQuoteSymbol } from '@/services/quoteSymbol';
import { isCashPosition, isHeldInvestedPosition } from '@/lib/positionKind';

/**
 * Encapsulates all positions data-fetching logic extracted from CarteraPage.
 *
 * @param {object} opts
 *   user                  - authenticated user object
 *   brokersRef            - ref to current broker list (from useBrokers)
 *   preferredCurrencyRef  - ref synced with preferredCurrency state
 *   importedTransactionsRef - ref synced with currentImportedTransactions
 *   importPricesRef       - ref synced with importPrices state
 *   setImportPrices       - state setter for importPrices
 *   dynamicTickerMapRef   - ref synced with dynamicTickerMap state
 */
export function usePositions({
  user,
  brokersRef,
  preferredCurrencyRef,
  importedTransactionsRef,
  importPricesRef,
  setImportPrices,
  dynamicTickerMapRef,
}) {
  const { toast } = useToast();
  const { t } = useTranslation();

  const [positions, setPositions] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [exchangeRates, setExchangeRates] = useState({});
  const [historyTotals, setHistoryTotals] = useState({ realized: 0, dividends: 0, fees: 0, totalBuyCost: 0, openPositionCost: 0, tradeCommissions: 0, tradeCommissionsByBroker: {} });
  const [dbTransactions, setDbTransactions] = useState([]);

  // Internal refs for async callbacks
  const positionsRef = useRef([]);
  const exchangeRatesRef = useRef({});
  const refreshingRef = useRef(false);
  // Último día de NAV conocido por símbolo de cotización (fondos con NAV de un
  // día anterior). Sobrevive a las recargas SIN refresco de precios (añadir una
  // operación, una aportación…): sin esto, el "VL 13 oct" desaparecía aunque el
  // precio pintado siguiera siendo ese mismo NAV.
  const priceDateRef = useRef({});

  const _setPositions = useCallback((valOrUpdater) => {
    setPositions(prev => {
      const next = typeof valOrUpdater === 'function' ? valOrUpdater(prev) : valOrUpdater;
      positionsRef.current = next;
      return next;
    });
  }, []);

  const _setExchangeRates = useCallback((rates) => {
    exchangeRatesRef.current = rates;
    setExchangeRates(rates);
  }, []);

  // ── refreshPrices ───────────────────────────────────────────────────────────
  const refreshPrices = useCallback(async (manualPositions = null) => {
    if (refreshingRef.current) return;
    const targetPositions = manualPositions || positionsRef.current;
    const importedTrans = importedTransactionsRef.current || [];
    const dynamicTickerMap = dynamicTickerMapRef.current || {};

    const importedTickers = [...new Set(
      importedTrans
        // noQuote: MyInvestor movimientos funds (monetary qty, no ISIN) — a
        // name-based Yahoo match would price EUR quantities with a real NAV
        .filter(t => t.type !== 'Cash' && t.type !== 'CASH' && !t.noQuote)
        .map(t => t.displayTicker || t.isin || t.producto)
    )];

    if (!targetPositions?.length && !importedTickers.length) return;

    refreshingRef.current = true;
    setRefreshing(true);

    try {
      const quotedTickers = (targetPositions || [])
        .filter(p => p.assets?.ticker && !isCashPosition(p))
        .map(p => p.assets.ticker);

      // Misma resolución que el Dashboard (prioridades documentadas en quoteSymbol).
      const resolveT = (t) => resolveQuoteSymbol(t, dynamicTickerMap);

      // Include non-representative component tickers (e.g. AMZN.DE when AMZN is the representative)
      const extraComponentTickers = (targetPositions || [])
        .flatMap(p => (p._valueComponents || []).map(c => c.ticker))
        .filter(t => t && t !== 'CASH' && !t?.startsWith('CASH'));

      const allTickers = [...new Set([
        ...quotedTickers.map(resolveT),
        ...extraComponentTickers.map(t => resolveT(t)),
        ...importedTickers.map(t => resolveT(t)),
      // A ticker with whitespace is an unresolved fund NAME — no provider can
      // quote it, and letting it through burns the EODHD fallback quota.
      ])].filter(t => t && !/\s/.test(t));

      if (allTickers.length === 0) return;

      // marketDataService (Yahoo → EODHD): EUFUND fund symbols from
      // the MyInvestor NAV enricher only quote via the EODHD fallback.
      // Pool, no ráfaga (regla del proyecto): un Promise.allSettled sobre toda la
      // cartera hacía que Yahoo estrangulara y dejara precios sin refrescar.
      const quotes = await runPooledSettled(allTickers.map(t => () => marketDataService.getQuote(t)));

      // quoteMap: resolved-ticker → raw price (in Yahoo's currency)
      // quoteCurMap: resolved-ticker → Yahoo's currency code
      const quoteMap = {};
      const quoteCurMap = {};
      const quoteDateMap = {}; // fondos con NAV de un día anterior (ver stalePriceDate)
      quotes.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value?.current > 0) {
          const sym = (r.value.symbol || allTickers[i]).toUpperCase();
          const req = allTickers[i].toUpperCase();
          const price = r.value.current;
          const cur = (r.value.currency || 'USD').toUpperCase();
          const asOf = stalePriceDate(r.value);
          quoteMap[sym] = price;
          quoteCurMap[sym] = cur;
          quoteDateMap[sym] = asOf;
          // Also key by the requested ticker so lookups always hit
          quoteMap[req] = price;
          quoteCurMap[req] = cur;
          quoteDateMap[req] = asOf;
        }
      });

      const rates = { ...exchangeRatesRef.current };
      const preferredCurrency = preferredCurrencyRef.current || 'EUR';

      // Ensure every currency that appears in quotes has an exchange rate loaded.
      // loadPositions only fetches rates for currencies present in stored positions,
      // so a USD quote for an EUR-stored asset (e.g. GOOGL on DeGiro) would be missing.
      const quoteCurrencies = [...new Set(Object.values(quoteCurMap))];
      const missingCurrencies = quoteCurrencies.filter(c => !(c in rates));
      if (missingCurrencies.length > 0) {
        await Promise.all(missingCurrencies.map(async c => {
          try { rates[c] = await currencyService.getExchangeRate(c, preferredCurrency); }
          catch { rates[c] = 1; }
        }));
      }

      // Converts a price from the quote's currency to the target stored currency.
      // Shared with the Dashboard (services/quotePricing.js) — the Dashboard used
      // to skip this step and valued USD quotes with the asset's EUR rate.
      const toPriceCur = (rawPrice, fromCur, toCur) => convertQuotePrice(rawPrice, fromCur, toCur, rates);

      // Update positions state
      _setPositions(prev => prev.map(p => {
        const key = (resolveT(p.assets?.ticker) || '').toUpperCase();
        const rawPrice = quoteMap[key];
        if (!rawPrice) return p; // skip missing and zero prices

        const assetCur = (p.assets?.currency || 'USD').toUpperCase();
        const quoteCur = quoteCurMap[key] || assetCur;
        const newPrice = toPriceCur(rawPrice, quoteCur, assetCur);

        priceDateRef.current = { ...priceDateRef.current, [key]: quoteDateMap[key] || null };
        const updated = { ...p, assets: { ...p.assets, current_price: newPrice }, _priceDate: quoteDateMap[key] || null };
        if (p._valueComponents) {
          // Merged position: update each component's price individually, then recompute total
          const updatedComponents = p._valueComponents.map(c => {
            const compKey = (resolveT(c.ticker) || '').toUpperCase();
            const compRaw = quoteMap[compKey];
            if (compRaw === undefined) return c;
            const compCur = (c.cur || 'USD').toUpperCase();
            const compQCur = quoteCurMap[compKey] || compCur;
            return { ...c, price: toPriceCur(compRaw, compQCur, compCur) };
          });
          updated._valueComponents = updatedComponents;
          updated._totalValueInPref = updatedComponents.reduce((s, c) => s + c.qty * c.price * (rates[c.cur] || 1), 0);
        } else if (p._totalValueInPref !== undefined) {
          const cur = p.assets?.currency || 'EUR';
          updated._totalValueInPref = parseFloat(p.quantity) * newPrice * (rates[cur] || 1);
        }
        return updated;
      }));

      // No price write-back to the DB from here: `assets` is shared and its
      // price is written ONLY by the server cron (server/lib/assetPrices.js,
      // audit 7f2c915d A1). The screen already shows the live prices above.

      // Update importPrices for the preview table
      if (importedTickers.length > 0) {
        const newImportPrices = { ...(importPricesRef.current || {}) };
        importedTickers.forEach(ticker => {
          const key = (resolveT(ticker) || '').toUpperCase();
          if (quoteMap[key] !== undefined) newImportPrices[ticker] = quoteMap[key];
        });
        setImportPrices(newImportPrices);
      }

      if (!manualPositions) {
        toast({ title: t('cartera.prices_updated_title'), description: t('cartera.prices_updated_desc') });
      }
    } catch (error) {
      console.error('refreshPrices error:', error);
      toast({ variant: 'destructive', title: t('cartera.prices_update_error_title'), description: t('cartera.prices_update_error_desc') });
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [_setPositions, _setExchangeRates, setImportPrices, importedTransactionsRef, importPricesRef, dynamicTickerMapRef, toast, t]);

  // ── loadPositions ───────────────────────────────────────────────────────────
  const loadPositions = useCallback(async (bId, shouldRefreshPrices = false) => {
    // Clear immediately so the dedup useMemo in CarteraPage never runs against
    // a previous broker's transactions during the async fetch window.
    // Without this, switching brokers produces a flash of doubled stats because
    // processedImportData fires synchronously with stale dbTransactions before
    // setDbTransactions(transformedTrans) is called after the two awaits below.
    setDbTransactions([]);

    const brokers = brokersRef.current || [];
    const preferredCurrency = preferredCurrencyRef.current || 'EUR';
    const importedTrans = importedTransactionsRef.current || [];

    let currentPositionsData = [];

    const { data: posData, error: posErr } = await supabase.from('positions')
      .select('*, assets(*)')
      .in('broker_id', bId === 'general' ? brokers.map(b => b.id) : [bId])
      .order('created_at', { ascending: false });

    // A failed fetch must never render as "empty portfolio": surface it and keep
    // whatever was on screen instead of silently wiping the positions state.
    if (posErr) {
      console.error('loadPositions: error loading positions:', posErr);
      toast({
        variant: 'destructive',
        title: t('cartera.positions_load_error_title'),
        description: posErr.message || t('cartera.positions_load_error_desc'),
      });
      return;
    }

    // Keep held assets AND every cash row (a 0-balance cash row still exists).
    const validPosData = (posData || []).filter(p =>
      p.assets && (isHeldInvestedPosition(p) || isCashPosition(p))
    );

    // Load all transactions for analytics.
    // Filter by position_id directly (posData covers all positions including closed qty=0 ones).
    // The embedded-resource filter .in('positions.broker_id', ...) is unreliable in some
    // PostgREST versions and returns empty results — using position_id avoids that issue.
    const allPositionIds = (posData || []).map(p => p.id);

    const { data: transData, error: transErr } = allPositionIds.length > 0
      ? await supabase.from('transactions')
          .select('*, positions(broker_id, assets(ticker, company_name, currency, isin))')
          .in('position_id', allPositionIds)
      : { data: [], error: null };

    if (transErr) {
      console.error('loadPositions: error loading transactions:', transErr);
      // Non-fatal: positions still render, but P&L/dividend/fee totals would be
      // silently zero — warn so the user doesn't trust incomplete numbers.
      toast({
        variant: 'destructive',
        title: t('cartera.transactions_load_error_title'),
        description: t('cartera.transactions_load_error_desc'),
      });
    }

    const transformedTrans = (transData || []).map(t => {
      const [fecha, horaFull] = (t.transaction_date || '').split('T');
      const hora = (horaFull || '00:00:00').substring(0, 5);
      const [y = '1970', m = '01', d = '01'] = fecha ? fecha.split('-') : [];
      return {
        ...t,
        fecha: `${d}-${m}-${y}`,
        hora,
        type: t.transaction_type,
        cantidad: t.quantity,
        precio: t.price,
        total: t.transaction_type === 'CASH' ? t.total_amount
          : (t.transaction_type === 'SELL' || t.transaction_type === 'DIVIDEND'
            ? t.total_amount : -t.total_amount),
        moneda: t.positions?.assets?.currency || 'EUR',
        descripcion: t.notes,
        isEndingCash: t.is_ending_cash || false,
        isConsolidated: false,
        nombre: t.positions?.assets?.company_name || null,
        producto: t.positions?.assets?.ticker || t.positions?.assets?.isin,
        isin: t.positions?.assets?.isin || null,
        isFromDB: true,
      };
    });
    setDbTransactions(transformedTrans);

    if (validPosData.length === 0) {
      _setPositions([]);
      _setExchangeRates({});
      return;
    }

    // Latest transaction date per position — derived from transData (already fetched
    // above for analytics); no second transactions query needed.
    const latestDates = {};
    (transData || []).forEach(t => {
      if (!t.transaction_date) return;
      const dateStr = t.transaction_date.split('T')[0];
      if (!latestDates[t.position_id] || dateStr > latestDates[t.position_id])
        latestDates[t.position_id] = dateStr;
    });

    // Group positions (general view: by resolved ticker; specific broker: as-is)
    if (bId === 'general') {
      const groupedData = validPosData.reduce((acc, pos) => {
        const isCash = isCashPosition(pos);
        // Misma clave que el rebalanceo: lib/positionGroupKey (UNA definición).
        const resolvedKey = positionGroupKey(pos, {
          tickerMap: TICKER_MAP, resolveTicker, dynamicTickerMap: dynamicTickerMapRef.current || {},
        });
        const key = isCash ? (pos.assets?.ticker || pos.asset_id) : resolvedKey;
        const efficientDate = latestDates[pos.id] || pos.created_at?.split('T')[0];
        const qty = parseFloat(pos.quantity) || 0;

        if (!acc[key]) {
          acc[key] = {
            ...pos, quantity: 0,
            _costComponents: [], _valueComponents: [], _maxQty: 0,
            target_percentage: 0, last_operation_date: efficientDate,
            underlyingIds: [], all_asset_ids: [],
          };
        }

        acc[key].quantity += qty;
        acc[key]._costComponents.push({ qty, price: parseFloat(pos.entry_price || 0), cur: pos.assets?.currency || 'EUR' });
        acc[key]._valueComponents.push({ qty, price: parseFloat(pos.assets?.current_price || 0), cur: pos.assets?.currency || 'EUR', ticker: pos.assets?.ticker });
        acc[key].target_percentage = Math.max(acc[key].target_percentage || 0, parseFloat(pos.target_percentage) || 0);
        acc[key].underlyingIds.push(pos.id);
        if (!acc[key].all_asset_ids.includes(pos.asset_id)) acc[key].all_asset_ids.push(pos.asset_id);

        if (qty > (acc[key]._maxQty || 0)) {
          acc[key]._maxQty = qty;
          acc[key].assets = pos.assets;
          acc[key].asset_id = pos.asset_id;
        }

        if (efficientDate && (!acc[key].last_operation_date || new Date(efficientDate) > new Date(acc[key].last_operation_date)))
          acc[key].last_operation_date = efficientDate;

        return acc;
      }, {});
      currentPositionsData = Object.values(groupedData);
    } else {
      currentPositionsData = validPosData.map(p => ({
        ...p,
        last_operation_date: latestDates[p.id] || p.created_at?.split('T')[0],
      }));
    }

    // Fetch exchange rates
    const importedCurrencies = [...new Set(importedTrans.map(t => t.moneda).filter(Boolean))];
    const positionCurrencies = currentPositionsData.flatMap(p =>
      p._costComponents ? p._costComponents.map(c => c.cur) : [p.assets?.currency]
    ).filter(Boolean);
    // Always include EUR: trade commissions are EUR-invoiced (DeGiro/IBKR) and need a rate
    // even when no position is denominated in EUR.
    const uniqueCurrencies = [...new Set([...positionCurrencies, ...importedCurrencies, 'EUR'])];

    const rates = {};
    await Promise.all(uniqueCurrencies.map(async cur => {
      rates[cur] = await currencyService.getExchangeRate(cur, preferredCurrency);
    }));
    _setExchangeRates(rates);

    // Resolve entry_price for merged positions (step 3.5)
    if (bId === 'general') {
      currentPositionsData = currentPositionsData.map(g => {
        if (!g._costComponents) return g;
        const { _costComponents, _maxQty, ...rest } = g; // _valueComponents kept in rest
        const repCur = rest.assets?.currency || 'EUR';
        const totalQty = parseFloat(rest.quantity) || 0;
        const repRate = rates[repCur] || 1;
        const totalCostInPref = _costComponents.reduce((s, c) => s + c.qty * c.price * (rates[c.cur] || 1), 0);
        const totalValueInPref = (rest._valueComponents || []).reduce((s, c) => s + c.qty * c.price * (rates[c.cur] || 1), 0);
        const totalCostInRepCur = repRate > 0 ? totalCostInPref / repRate : totalCostInPref;
        return {
          ...rest,
          entry_price: totalQty > 0 ? totalCostInRepCur / totalQty : 0,
          _totalCostInPref: totalCostInPref,
          _totalValueInPref: totalValueInPref,
        };
      });
    }

    // Historical totals using FIFO — shared pipeline with Dashboard (single source
    // of truth for cost basis / P&L; see services/portfolioHistory.js).
    // Reuses transData (already fetched above) — no second query needed.
    const history = await computeHistoryTotals(transData || [], preferredCurrency, rates);

    // Attach per-asset FIFO metrics to positions for FX-aware gain%/profit display.
    // Try ISIN key first, then ticker key — the transaction's asset may lack an ISIN
    // even though the position's asset has one (or vice-versa), causing a key mismatch.
    // _histCost (all-time AVCO buy totals) comes from the same pipeline — it replaced
    // the old per-position lazy preload that fired one query per non-EUR position.
    const { perAssetMetrics, buyTotalsByAsset, buyTotalsByPosition } = history;
    currentPositionsData = currentPositionsData.map(pos => {
      const isin = pos.assets?.isin;
      const ticker = pos.assets?.ticker;
      const cur = pos.assets?.currency || 'EUR';
      const keyByIsin = isin ? `${isin}_${cur}` : null;
      const keyByTicker = ticker ? `${ticker}_${cur}` : null;
      const lookup = (map) => (keyByIsin && map[keyByIsin]) || (keyByTicker && map[keyByTicker]) || null;

      const metrics = lookup(perAssetMetrics);

      // Buy totals: position_id join first (authoritative; sums all sub-positions of a
      // merged general-view row), string-key lookup as fallback.
      let posTotals = null;
      for (const pid of pos.underlyingIds || [pos.id]) {
        const bt = buyTotalsByPosition[pid];
        if (!bt) continue;
        if (!posTotals) posTotals = { totalHistCost: 0, totalBoughtQty: 0 };
        posTotals.totalHistCost += bt.totalHistCost;
        posTotals.totalBoughtQty += bt.totalBoughtQty;
      }
      const buyTotals = posTotals || lookup(buyTotalsByAsset);

      // FIFO open cost / realized for the row. Merged general-view rows can span
      // MULTIPLE currency queues of the same ISIN (e.g. AMZN bought in EUR on Xetra
      // and in USD on NASDAQ → queues ISIN_EUR and ISIN_USD): sum ALL component
      // queues — using only the representative's queue dropped the other currency's
      // cost basis and inflated the general view's latent gain vs the broker tabs.
      let openPrefCost = metrics && metrics.openPrefCost > 0 ? metrics.openPrefCost : 0;
      let openQty = metrics ? metrics.openQty || 0 : 0;
      let realizedConverted = metrics ? metrics.realizedNative * (rates[cur] || 1) : 0;
      if (pos._valueComponents?.length) {
        const seenQueues = new Set();
        let summedCost = 0;
        let summedQty = 0;
        let summedRealized = 0;
        let anyQueue = false;
        for (const c of pos._valueComponents) {
          const keyA = isin ? `${isin}_${c.cur}` : null;
          const keyB = c.ticker ? `${c.ticker}_${c.cur}` : null;
          const m = (keyA && perAssetMetrics[keyA]) || (keyB && perAssetMetrics[keyB]) || null;
          const queueId = keyA || keyB;
          if (!m || !queueId || seenQueues.has(queueId)) continue;
          seenQueues.add(queueId);
          anyQueue = true;
          summedCost += m.openPrefCost;
          summedQty += m.openQty || 0;
          summedRealized += m.realizedNative * (rates[c.cur] || 1);
        }
        if (anyQueue) {
          openPrefCost = summedCost;
          openQty = summedQty;
          realizedConverted = summedRealized;
        }
      }
      // FIFO lots may cover FEWER shares than the position holds (histories
      // damaged by the old unique-key import dedupe, manual edits, partial
      // saves). Pairing that partial cost with the full market value inflated
      // the gain% and dumped the shortfall into "G/P Moneda" as a fake FX gain
      // — scale the cost to the held quantity (AVCO per remaining share).
      openPrefCost = scaleOpenCostToHeldQty(openPrefCost, openQty, parseFloat(pos.quantity || 0));

      let enriched = pos;
      if (buyTotals && buyTotals.totalBoughtQty > 0) {
        enriched = { ...enriched, _histCost: buyTotals };
      }
      if (openPrefCost > 0) {
        enriched = {
          ...enriched,
          _prefCostTotal: openPrefCost,
          _realizedGain: realizedConverted,
        };
      }
      return enriched;
    });

    // Single _setPositions call — positions are enriched with FIFO data when available.
    // El día del NAV del último refresco se conserva (ver priceDateRef).
    const priceDates = priceDateRef.current;
    _setPositions(currentPositionsData.map((p) => {
      const key = (resolveQuoteSymbol(p.assets?.ticker, dynamicTickerMapRef.current || {}) || '').toUpperCase();
      return priceDates[key] ? { ...p, _priceDate: priceDates[key] } : p;
    }));

    // Hybrid open-position cost — shared function with the Dashboard fallback
    // (services/portfolioHistory.js) so "Invertido" is identical on both screens
    // with or without a metrics-cache hit. Computed over the RAW rows (not the
    // general-view merged ones): the queue-level grouping inside the function is
    // equivalent for merged rows and avoids depending on merge artifacts.
    const investedHybrid = computeInvestedHybrid(validPosData, history, rates);

    setHistoryTotals({
      realized: history.realized,
      dividends: history.dividends,
      fees: history.fees,
      totalBuyCost: history.totalBuyCost,
      openPositionCost: history.openPositionCost,
      investedHybrid,
      tradeCommissions: history.tradeCommissions,
      tradeCommissionsByBroker: history.tradeCommissionsByBroker,
    });

    // Publish the computed totals so the Dashboard and the share server display
    // EXACTLY these numbers without recomputing (fire-and-forget; consumers
    // validate freshness via txCount + currency before trusting the cache).
    // Never publish a run with unresolved historical FX rates — its cost basis is
    // incomplete and would poison every consumer until the next clean run.
    if (user?.id && !(history.histRateMisses > 0)) {
      supabase.from('portfolio_metrics_cache').upsert({
        user_id: user.id,
        scope: bId,
        currency: preferredCurrency,
        metrics: {
          realized: history.realized,
          dividends: history.dividends,
          fees: history.fees,
          totalBuyCost: history.totalBuyCost,
          openPositionCost: history.openPositionCost,
          investedHybrid,
          tradeCommissions: history.tradeCommissions,
          tradeCommissionsByBroker: history.tradeCommissionsByBroker,
          firstTransactionDate: history.firstTransactionDate,
          txCount: (transData || []).length,
          // Detects cost-basis mutations that don't change txCount (manual position
          // edits/adds) — consumers recompute on mismatch instead of serving stale data.
          posFingerprint: computePositionsFingerprint(posData || []),
        },
        computed_at: new Date().toISOString(),
      }, { onConflict: 'user_id, scope' }).then(({ error }) => {
        if (error) console.warn('[metrics-cache] upsert failed:', error.message);
      });
    }

    if (shouldRefreshPrices) refreshPrices(currentPositionsData);
  }, [brokersRef, preferredCurrencyRef, importedTransactionsRef, _setPositions, _setExchangeRates, refreshPrices, toast, t]);

  return {
    positions,
    setPositions: _setPositions,
    refreshing,
    exchangeRates,
    historyTotals,
    dbTransactions,
    loadPositions,
    refreshPrices,
  };
}
