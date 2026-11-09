import { useState, useEffect, useRef } from 'react';
import { supabase } from '@/lib/customSupabaseClient';
import { yahooFinanceService } from '@/services/yahooFinance';
import { resolveTicker, inferTickerCurrency } from '@/lib/tickerMap';
import { performanceService } from '@/services/performanceService';
import { runPooled, sleep } from '@/lib/asyncPool';
import { createPerfHistCache, PERF_LS_PREFIX } from '@/lib/perfHistCache';
import { tickerGuard } from '@/lib/tickerGuard';

// ── localStorage persistence for historical price series ─────────────────────
// Yahoo Finance rate-limits aggressively on parallel requests. Without persistence
// a page refresh re-fetches everything and silently misses some tickers, making
// those assets invisible and producing wrong results.
const PERF_LS_TTL    = 23 * 60 * 60 * 1000; // 23 h
// 10 años: es el rango que usaba la pantalla de brokers antes de unificar. Con
// 5y una cartera más antigua perdía historia y su TWR acumulado salía distinto
// en cada pantalla. El rango va DENTRO de la clave de caché: sin él, una serie
// de 5y guardada ayer se serviría como si fuera de 10y.
const PERF_RANGE     = '10y';

/**
 * Caché en localStorage de las series históricas.
 *
 * La implementación (y el POR QUÉ: el desalojo por cuota y el guardar solo
 * time+close) vive en `lib/perfHistCache`, que está testeado — el desalojo es
 * justo la clase de lógica que falla callando.
 */
const perfCache = createPerfHistCache({
  prefix: PERF_LS_PREFIX,
  range: PERF_RANGE,
  ttl: PERF_LS_TTL,
});

const perfHistLoad = (key) => perfCache.load(key);
const perfHistSave = (key, data) => perfCache.save(key, data);


/**
 * Serie ya calculada, compartida por todas las pantallas de la sesión.
 *
 * No es sólo caché: es lo que GARANTIZA que el Dashboard y la pantalla de
 * brokers enseñen el mismo número. Aunque las dos usen ya el mismo pipeline,
 * cada una recalculaba por su cuenta y una descarga de Yahoo fallida en UNA de
 * ellas bastaba para separarlas (medido: 78,76% contra 98,79% con la misma
 * cartera). Con el memo, la segunda pantalla REUTILIZA el resultado de la
 * primera — mismos huecos, mismo número, y una pasada de red menos.
 *
 * La clave es (usuario, broker, divisa) y NO incluye `refreshKey`: cada pantalla
 * pasa el suyo (el Dashboard ni siquiera lo pasa) y meterlo en la clave las
 * separaría otra vez, que es justo lo que esto viene a evitar. Lo que invalida
 * la entrada es que el refreshKey CAMBIE dentro de una misma pantalla (acabas
 * de importar o de añadir un movimiento), no que dos pantallas usen claves
 * distintas. El TTL cubre la navegación entre pantallas, no la jornada: la
 * serie es diaria y sus precios ya vienen de la caché de 23 h.
 */
const seriesMemo = new Map(); // clave → { ts, result, missing, holdingNames }
const MEMO_TTL = 10 * 60 * 1000;

/**
 * La serie que ya calculó el Dashboard o la pantalla de brokers, SIN volver a
 * descargar nada (o null). La usa la calculadora de interés compuesto para
 * precargar la rentabilidad anualizada real en vez de calcular la suya: un
 * número así tiene que coincidir con el de la pantalla de brokers. Acepta una
 * serie de hasta 6 h — es una sugerencia editable, no una cifra de cabecera.
 */
const PEEK_TTL = 6 * 60 * 60 * 1000;
export function peekPerformanceSeries({ userId, brokerId = 'general', currency }) {
  const memo = seriesMemo.get(`${userId}|${brokerId}|${currency}`);
  return memo && Date.now() - memo.ts < PEEK_TTL ? memo.result : null;
}

/**
 * Descarga con caché, REINTENTO y registro de lo que no llegó.
 *
 * Un histórico que falta NO es inocuo: `calculateDailyTWR` valora ese activo a 0
 * durante toda la serie, así que el TWR y el ROI salen mal — y en silencio.
 * Medido en la demo (2026-09-11): la misma cartera daba 78,76% en el Dashboard
 * y 98,79% en brokers, 20 puntos de diferencia, porque en la primera pantalla
 * Yahoo falló varios tickers y en la segunda ya estaban cacheados. Por eso hay
 * reintento (el 429 de Yahoo es transitorio) y por eso lo que aun así falte se
 * DEVUELVE al llamante en vez de tragárselo.
 */
const fetchWithCache = async (key, fetchFn, target, field, missing) => {
  const cached = perfHistLoad(key);
  if (cached && !cached.stale) { target[field] = cached.data; return; }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = await fetchFn();
      if (data?.length > 0) {
        target[field] = data;
        perfHistSave(key, data);
        return;
      }
    } catch { /* reintenta abajo */ }
    // Espalda con jitter: dos pestañas reintentando a la vez no deben sincronizarse.
    if (attempt === 0) await sleep(500 + Math.random() * 500);
  }
  if (cached) {
    target[field] = cached.data; // stale, pero infinitamente mejor que valorar a 0
    console.warn(`[perf] ${key}: sin respuesta, uso la caché vencida`);
    return;
  }
  missing.push(field);
  console.warn(`[perf] ${key}: sin histórico y sin caché — el activo se valoraría a 0`);
};

/**
 * Fetches all transaction data and computes daily TWR / TTWROR / ROI series.
 * Uses CSV-primary transaction strategy (matching the original PortfolioGrowthChart logic).
 *
 * ÚNICA implementación del TWR de cartera en el cliente (2026-09-11). La pantalla
 * de brokers tenía la suya propia y los dos números del mismo indicador no
 * cuadraban: medido con la cartera del owner, 54,80% en el Dashboard contra
 * 54,69% en brokers. Si necesitas la serie en una pantalla nueva, consume este
 * hook — no vuelvas a llamar a `calculateDailyTWR` por tu cuenta.
 *
 * `refreshKey`: valor opcional que fuerza el recálculo cuando las transacciones
 * cambian sin cambiar de broker ni de divisa (un import, un alta manual). El
 * Dashboard no lo necesita porque se monta con los datos ya cargados.
 */
export function usePortfolioPerformance({ userId, brokerId, currency, onCalculated, refreshKey }) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [currentHoldingNames, setCurrentHoldingNames] = useState(null);
  // Tickers sin histórico NI caché: su activo vale 0 en toda la serie, así que
  // el % que se pinta es incompleto. El llamante tiene que poder decirlo.
  const [missingTickers, setMissingTickers] = useState([]);
  const prevRefreshRef = useRef(refreshKey);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    const memoKey = `${userId}|${brokerId}|${currency}`;
    // El refreshKey cambió DESDE LA ÚLTIMA VEZ que corrió este hook → los datos
    // de origen se movieron (import, alta manual): tira la serie memorizada
    // para que todas las pantallas recalculen. En el primer montaje no invalida
    // nada, que es lo que permite reutilizar lo que dejó la otra pantalla.
    if (prevRefreshRef.current !== refreshKey) {
      seriesMemo.delete(memoKey);
      prevRefreshRef.current = refreshKey;
    }

    const run = async () => {
      setLoading(true);
      try {
        const memo = seriesMemo.get(memoKey);
        if (memo && Date.now() - memo.ts < MEMO_TTL) {
          setData(memo.result);
          if (memo.holdingNames) setCurrentHoldingNames(memo.holdingNames);
          if (onCalculated) onCalculated(memo.result);
          return; // el finally de abajo apaga el loading
        }
        // 1. Resolve broker list
        const { data: portfolios } = await supabase
          .from('portfolios').select('id').eq('user_id', userId).limit(1);
        if (!portfolios?.length) return;

        const { data: allBrokers } = await supabase
          .from('brokers').select('id').eq('user_id', userId);
        const brokerList = brokerId === 'general'
          ? (allBrokers || []).map(b => b.id)
          : [brokerId];

        // 2. Fetch DB transactions
        const { data: dbTransactions } = await supabase
          .from('transactions')
          .select('*, positions!inner(broker_id, asset_id, assets!inner(ticker, company_name, currency, isin))')
          .in('positions.broker_id', brokerList)
          .order('transaction_date', { ascending: true });

        // 3. Fetch CSV import data — deduplicate per broker keeping most complete import
        const { data: rawImportedRows } = await supabase
          .from('imported_data')
          .select('broker_id, transactions, ticker_map')
          .in('broker_id', brokerList);
        const importedByBroker = new Map();
        for (const row of (rawImportedRows || [])) {
          const existing = importedByBroker.get(row.broker_id);
          if (!existing || (row.transactions?.length || 0) > (existing.transactions?.length || 0)) {
            importedByBroker.set(row.broker_id, row);
          }
        }
        const importedRows = [...importedByBroker.values()];

        // 4. Build dynamic ticker map (broker ticker_map from import)
        const dynamicTickerMap = {};
        importedRows.forEach(row => {
          if (row.ticker_map) Object.assign(dynamicTickerMap, row.ticker_map);
        });

        // 5. Helper: resolve canonical YF ticker for a transaction
        const resolveTxnTicker = (t) => {
          const isin = t.positions?.assets?.isin || t.isin;
          const identifier = t.positions?.assets?.ticker || t.producto;
          return (isin && resolveTicker(isin))
            || (isin && dynamicTickerMap[isin])
            || resolveTicker(identifier)
            || dynamicTickerMap[identifier];
        };

        // 6. Build TWR transaction list (CSV-first strategy)
        // - Non-consolidated CSV rows = full individual trade history (DeGiro/IBKR)
        // - Consolidated BUY seeds = Binance snapshots for tickers not in non-consolidated
        // - extraDbTxns = DB transactions for tickers absent from CSV (manually added)
        const nonConsolidatedTxns = importedRows
          .flatMap(row => (row.transactions || []).filter(t => !t.isConsolidated));

        const nonConsolidatedTickerSet = new Set(
          nonConsolidatedTxns.map(resolveTxnTicker).filter(Boolean)
        );

        const consolidatedBuySeeds = importedRows
          .flatMap(row => (row.transactions || []).filter(t =>
            t.isConsolidated && t.type === 'BUY' &&
            !nonConsolidatedTickerSet.has(resolveTxnTicker(t))
          ));

        const importedTxns = [...nonConsolidatedTxns, ...consolidatedBuySeeds];

        const importedTickerSet = new Set(
          importedTxns.map(resolveTxnTicker).filter(Boolean)
        );

        const extraDbTxns = (dbTransactions || []).filter(t => {
          const ticker = resolveTxnTicker(t);
          return ticker && !importedTickerSet.has(ticker);
        });

        const twrTxns = importedTxns.length > 0
          ? [...importedTxns, ...extraDbTxns]
          : (dbTransactions || []);

        if (!twrTxns.length) return;

        // 7. Build ROI transaction list (DB-primary for accurate eur_total cost basis)
        const savedBrokerIdSet = new Set(
          (dbTransactions || []).map(t => t.positions?.broker_id).filter(Boolean)
        );
        const csvForUnsavedBrokers = importedRows
          .filter(row => !savedBrokerIdSet.has(row.broker_id))
          .flatMap(row => (row.transactions || []).filter(t => !t.isConsolidated));
        const csvSellsForSavedBrokers = importedRows
          .filter(row => savedBrokerIdSet.has(row.broker_id))
          .flatMap(row => (row.transactions || []).filter(t =>
            !t.isConsolidated && (t.type === 'SELL' || t.transaction_type === 'SELL')
          ));
        const roiTxns = [...(dbTransactions || []), ...csvForUnsavedBrokers, ...csvSellsForSavedBrokers];

        // 8. Collect tickers and currencies to fetch
        const tickers = new Set();
        const currencies = new Set(['EUR']);
        twrTxns.forEach(t => {
          const isin = t.positions?.assets?.isin || t.isin;
          const identifier = t.positions?.assets?.ticker || t.producto;
          const ticker = (isin && resolveTicker(isin))
            || (isin && dynamicTickerMap[isin])
            || resolveTicker(identifier)
            || dynamicTickerMap[identifier];
          // `tickerGuard` decide: liquidez, acentos, espacios y lo que Yahoo ya
          // rechazó con un 404. Filtrar AQUÍ (y no solo en la capa de red) evita
          // además que un no-activo cuente como "histórico que falta" y marque el
          // porcentaje como incompleto sin motivo.
          if (ticker && !tickerGuard.shouldSkip(ticker)) {
            tickers.add(ticker);
          }
          if (ticker) currencies.add(inferTickerCurrency(ticker, t.positions?.assets?.currency));
          const tradeCur = t.positions?.assets?.currency || t.moneda;
          if (tradeCur) currencies.add(tradeCur);
        });

        // 9. Fetch historical prices and FX with localStorage caching
        const historicalPrices = {};
        const historicalFX = {};
        const missing = [];

        await runPooled([
          ...[...tickers].map(ticker => () =>
            fetchWithCache(
              ticker,
              () => yahooFinanceService.getHistoricalData(ticker, PERF_RANGE, '1d'),
              historicalPrices, ticker, missing
            )
          ),
          ...[...currencies]
            .filter(cur => cur !== currency)
            .map(cur => () => {
              const key = `${cur}${currency}=X`;
              return fetchWithCache(
                key,
                () => yahooFinanceService.getHistoricalData(key, PERF_RANGE, '1d'),
                historicalFX, cur, missing
              );
            }),
        ]);

        // 10. Run performance calculation
        const result = performanceService.calculateDailyTWR(
          twrTxns, historicalPrices, historicalFX, {}, currency,
          dynamicTickerMap, resolveTicker, roiTxns
        );

        if (cancelled) return;

        seriesMemo.set(memoKey, {
          ts: Date.now(), result, missing,
          holdingNames: result[result.length - 1]?._finalHoldingNames,
        });
        setData(result);
        const last = result[result.length - 1];
        if (last?._finalHoldingNames) setCurrentHoldingNames(last._finalHoldingNames);
        if (onCalculated) onCalculated(result);
      } catch (err) {
        console.error('[usePortfolioPerformance]', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    run();
    return () => { cancelled = true; };
  }, [userId, brokerId, currency, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return { data, loading, currentHoldingNames, missingTickers };
}
