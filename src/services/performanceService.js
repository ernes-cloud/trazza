import Decimal from 'decimal.js';
import { FIFOCalculator } from './fifoAnalytics.js';
import { inferTickerCurrency } from '../lib/tickerMap.js';
import { isoDateRange, localTodayIso } from '../lib/dates.js';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

// Sanity ceiling for the daily TWR link of a day that includes a BUY. Only that
// link mixes broker-CSV prices with market closes, so only that link can be
// poisoned by a bad row; a real one-day portfolio swing beyond this is rarer than
// a data error. Same philosophy as isPlausiblePriceUpdate: don't trust, don't drop
// the whole series — drop the suspicious link.
const MAX_BUY_DAY_SWING = 0.35;

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;

/**
 * El primer día en que la cartera tuvo ALGO invertido, no el primer día que hubo
 * un apunte.
 *
 * `calculateDailyTWR` arranca la serie en la primera transacción de CUALQUIER
 * tipo (ver "Determine range: first transaction day to today"), así que un
 * ingreso de efectivo, una comisión o un traspaso meses antes de la primera
 * compra mete en la serie un tramo de puntos con `value: 0`. Ese tramo no
 * altera el TWR —la cadena multiplica por 1 mientras no hay activos— pero sí
 * ALARGA la ventana, y la ventana es el divisor de la anualizada: con el TWR
 * fijo, cada mes de más hunde el CAGR.
 *
 * Es la misma regla que ya usa el benchmark del gráfico (`rebased.find(d =>
 * (d.value || 0) > 0)`): si el índice no puede empezar antes de que hubiera
 * dinero en mercado, la anualizada tampoco.
 *
 * `value` sale solo de las cantidades de ACTIVOS (`currentAssetQtys`, que solo
 * alimentan BUY/SELL), nunca de la liquidez — por eso `> 0` distingue de verdad
 * "invertido" de "tengo el dinero en la cuenta del broker".
 *
 * @param {Array<{value?: number, date?: string, name?: string}>} series
 * @returns {string|null} fecha ISO del primer día invertido, o null si la serie
 *                        nunca llegó a tener posiciones.
 */
export function firstInvestedDate(series = []) {
  const point = (series || []).find(d => (d?.value || 0) > 0);
  return point ? (point.date || point.name || null) : null;
}

/**
 * Los años que cubre una ventana, en años JULIANOS (365,25 días, que es lo que
 * promedian los bisiestos). Está separada de `annualizeReturn` porque la UI
 * necesita ENSEÑAR la ventana junto al número — una anualizada sin decir sobre
 * qué periodo se calcula no se puede auditar — y la ventana tiene que ser la
 * misma que se usó para calcularlo, no una segunda cuenta parecida.
 *
 * @returns {number|null} años, o null si la ventana no es válida o va hacia atrás
 */
export function windowYears(startDate, endDate = Date.now()) {
  if (!startDate) return null;
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const years = (end - start) / MS_PER_YEAR;
  return years > 0 ? years : null;
}

/**
 * Anualiza una rentabilidad ACUMULADA (composición, no media aritmética):
 * `(1 + R)^(1/años) − 1`.
 *
 * Ojo con la intuición de dividir entre los años: un +60% en dos años NO es un
 * +30% anual, porque el segundo año compone sobre el primero — son +26,5%
 * (1,265² ≈ 1,60). Dividir siempre da de más.
 *
 * Se devuelve null por debajo de `minYears` (medio año por defecto): anualizar
 * un tramo corto multiplica el ruido del periodo en vez de describir un ritmo.
 *
 * @param {number|null} cumulativePct  rentabilidad acumulada del periodo, en %
 * @param {string|number|Date|null} startDate  inicio de la ventana
 * @param {string|number|Date} endDate         fin de la ventana (por defecto, ahora)
 * @returns {number|null} rentabilidad anualizada en %, o null si no procede
 */
export function annualizeReturn(cumulativePct, startDate, endDate = Date.now(), { minYears = 0.5 } = {}) {
  if (cumulativePct == null || !Number.isFinite(cumulativePct)) return null;
  const years = windowYears(startDate, endDate);
  if (years == null || !(years >= minYears)) return null;
  const growth = 1 + cumulativePct / 100;
  // Una cartera a −100% (o peor, que sería un dato corrupto) no tiene anualizada
  // que describir: `Math.pow` de una base ≤ 0 con exponente fraccionario da NaN.
  if (!(growth > 0)) return null;
  return (Math.pow(growth, 1 / years) - 1) * 100;
}

/**
 * Rentabilidad anualizada de una serie de `calculateDailyTWR`: el TWR acumulado
 * del ÚLTIMO punto (`ttwror`, con `cumulativeReturn` para series antiguas),
 * anualizado desde el primer día INVERTIDO hasta ese punto. Es la cifra de
 * "Rentabilidad Anualizada" de la pantalla de brokers y la que precarga la
 * calculadora de interés compuesto: tienen que salir de la misma función.
 * @returns {number|null}  %, o null sin serie o con menos de `minYears`
 */
export function annualizedTwrFromSeries(series, { minYears = 0.5 } = {}) {
  if (!Array.isArray(series) || !series.length) return null;
  const last = series[series.length - 1];
  const pct = last?.ttwror ?? last?.cumulativeReturn;
  if (pct == null) return null;
  return annualizeReturn(pct, firstInvestedDate(series), last.date || last.name, { minYears });
}

/**
 * Cruza una serie de cartera (ya filtrada y rebasada) con un índice de referencia
 * y añade a cada punto `sp500Return` (% desde la base). Es la ÚNICA definición de
 * la regla del benchmark: la usan el gráfico del Dashboard (`PortfolioGrowthChart`,
 * puntos con `date`) y la pantalla de brokers (`CarteraPage`, puntos con `name`).
 * Antes estaba duplicada y había que tocar las dos a la vez.
 *
 * Tres reglas, todas medidas:
 * - La base es el primer día INVERTIDO (`value > 0`), no el primer punto: entre
 *   ambos puede haber meses de solo caja, y basar ahí le regala al índice la
 *   subida de un tramo que la cartera no podía capturar (el S&P arrancaba en +25%).
 * - El precio base es el cierre ESTRICTAMENTE ANTERIOR a ese día: la cartera ya
 *   cuenta el movimiento de su primera sesión, así que basar en el cierre del
 *   mismo día hace que el índice empiece una sesión tarde (en 1D, la mitad).
 *   Sin barra anterior se usa la primera disponible, sin desfase inventado.
 * - Antes del primer día invertido el índice es `null` (no se pinta), y los días
 *   sin barra (festivos) arrastran el último valor; el primero arranca en 0.
 *
 * @param {Array<object>} points    serie de la cartera, ordenada por fecha
 * @param {Array<{date: string, close: number}>} benchmark  cierres del índice
 * @param {{ dateKey?: 'date'|'name' }} [opts]  campo de fecha de `points`
 * @returns {Array<object>} copia de `points` con `sp500Return`, o `points` tal cual
 *                          si no hay índice o no se puede basar
 */
export function mergeBenchmarkSeries(points, benchmark, { dateKey = 'date' } = {}) {
  if (!Array.isArray(points) || !points.length || !Array.isArray(benchmark) || !benchmark.length) return points;

  const startDate = (points.find(d => (d.value || 0) > 0) || points[0])[dateKey];
  const sorted = [...benchmark].sort((a, b) => a.date.localeCompare(b.date));

  let baseClose = null;
  for (const p of sorted) {
    if (p.date < startDate) baseClose = p.close;
    else break;
  }
  if (!baseClose) baseClose = sorted.find(p => p.date >= startDate)?.close ?? sorted[0]?.close;
  if (!baseClose) return points;

  const pctByDate = {};
  sorted.forEach(p => { pctByDate[p.date] = ((p.close / baseClose) - 1) * 100; });
  let last = null;
  return points.map(d => {
    const day = d[dateKey];
    if (day < startDate) return { ...d, sp500Return: null };
    if (pctByDate[day] !== undefined) last = pctByDate[day];
    return { ...d, sp500Return: last ?? 0 };
  });
}

export const performanceService = {
  /**
   * Calculates a daily Time-Weighted Return (TWR) series for the portfolio.
   *
   * TWR chains the return of each calendar day as a sub-period, so large cash flows
   * (new deposits, reinvested dividends) cannot inflate or deflate the measured return.
   * The series runs from the date of the first transaction through today.
   *
   * In parallel it tracks a simple ROI via a FIFO calculator (roiFifo) that mirrors the
   * Dashboard's FIFOCalculator.getOpenPositionPrefCost() denominator, giving the
   * "ROI Actual" figure shown in the performance chart tooltip.
   *
   * @param {Array}  transactions        - List of BUY/SELL/DIVIDEND transactions.  Accepts
   *                                       both DB format (transaction_date, transaction_type)
   *                                       and CSV-import format (fecha, type).
   * @param {object} historicalPrices    - Map of ticker → [{time: 'YYYY-MM-DD', close: number}].
   *                                       Missing days fall back to the most recent prior close.
   * @param {object} [historicalFX={}]   - Map of currency → [{time, close}] for FX-denominated assets.
   * @param {object} [ratesMap={}]       - Fallback spot rates map (currency → number) used when
   *                                       historicalFX has no entry for a given day.
   * @param {string} [baseCurrency='EUR'] - Currency in which portfolio value is expressed.
   * @param {object} [dynamicTickerMap={}] - ISIN → Yahoo Finance ticker overrides built during import.
   * @param {function} [resolveTicker]   - Fallback ticker resolver; defaults to identity.
   * @param {Array|null} [roiTransactions] - Separate DB-sourced list that carries eur_total for
   *                                         accurate preferred-currency cost tracking.  Falls back
   *                                         to `transactions` when null.
   *
   * @returns {Array<{
   *   date: string,           // 'YYYY-MM-DD'
   *   value: number,          // End-of-day portfolio value in baseCurrency
   *   yield: number,          // Cumulative TWR % from inception
   *   dailyReturn: number,    // Single-day weighted return (fraction)
   *   simpleROI: number,      // (marketValue − openCost) / openCost × 100
   *   breakdown: object,      // Per-asset daily return keyed by display name
   *   displayYield: string    // yield formatted to 2 decimal places
   * }>}
   */
  calculateDailyTWR(transactions, historicalPrices, historicalFX = {}, ratesMap = {}, baseCurrency = 'EUR', dynamicTickerMap = {}, resolveTicker = (t) => t, roiTransactions = null) {
    if (!transactions || transactions.length === 0) return [];

    // 1. Group transactions by day (YYYY-MM-DD)
    const dayGroups = {};
    const assetCurrencyMap = {};
    const assetNameMap = {}; // ticker → display name
    const assetNameFromTrade = new Set(); // tickers whose name came from a BUY/SELL

    transactions.forEach(t => {
      let dateStr;
      if (t.transaction_date) {
        dateStr = t.transaction_date.split('T')[0];
      } else if (t.fecha) {
        const parts = t.fecha.split('-');
        if (parts.length === 3) {
          if (parts[0].length === 4) dateStr = `${parts[0]}-${parts[1]}-${parts[2]}`;
          else dateStr = `${parts[2]}-${parts[1]}-${parts[0]}`;
        }
      }

      if (!dateStr) return;

      if (!dayGroups[dateStr]) dayGroups[dateStr] = [];
      dayGroups[dateStr].push(t);

      // DB transactions store tickers as "ISIN (CUR)" — not valid YF tickers.
      // Try ISIN first via dynamicTickerMap (ISIN → real YF ticker from import).
      const isin = t.isin || t.positions?.assets?.isin;
      const rawIdentifier = t.positions?.assets?.ticker || t.producto;
      const identifier = rawIdentifier || isin;
      // Try ISIN-based resolution before identifier to handle CSV transactions
      // where producto may be a full company name (e.g. "Meta Platforms Inc Class A (USD)")
      const ticker = (isin && resolveTicker(isin))
        || (isin && dynamicTickerMap[isin])
        || resolveTicker(identifier)
        || dynamicTickerMap[identifier];
      const isTrade = t.type === 'BUY' || t.type === 'SELL' || t.transaction_type === 'BUY' || t.transaction_type === 'SELL';
      // Derive price currency from ticker format, not from moneda (trade settlement currency).
      // moneda can be 'EUR' for Xetra/Tradegate trades of US stocks (e.g. AMZN bought via
      // DeGiro Xetra), but Yahoo Finance still quotes AMZN in USD. Using moneda='EUR' would
      // skip the USD→EUR conversion in market-value calculations → inflated ROI numerator.
      // For .L tickers the DB asset currency disambiguates USD-denominated LSE ETFs
      // (SMH.L, VUAA.L) from pence-quoted stocks.
      assetCurrencyMap[ticker] = inferTickerCurrency(ticker, t.positions?.assets?.currency);

      // Build display name: DB company_name always wins; CSV BUY/SELL names beat DIVIDEND/FEE names
      const companyName = t.positions?.assets?.company_name;
      if (companyName) {
        assetNameMap[ticker] = companyName;
      } else if (isTrade) {
        if (!assetNameFromTrade.has(ticker)) {
          assetNameMap[ticker] = t.nombre || ticker;
          assetNameFromTrade.add(ticker);
        }
      } else if (!assetNameMap[ticker]) {
        assetNameMap[ticker] = t.nombre || ticker;
      }
    });

    const allDaysWithTrans = Object.keys(dayGroups).sort();
    if (allDaysWithTrans.length === 0) return [];

    // 2. Determine range: first transaction day to today (LOCAL).
    // isoDateRange y no un bucle con setDate + toISOString: mezclar hora local
    // y UTC hacía que en horario de verano cada día saliera con la fecha de
    // AYER (y su cierre), y que hoy no apareciera — el "1D" enseñaba el
    // movimiento de ayer. Ver lib/dates.
    const dateRange = isoDateRange(allDaysWithTrans[0], localTodayIso());

    // Build roiDayGroups from the DB-primary list (roiTransactions) which carries eur_total.
    // Falls back to the main transactions list when no separate ROI list is provided.
    const roiDayGroups = {};
    (roiTransactions || transactions).forEach(t => {
      let dateStr;
      if (t.transaction_date) {
        dateStr = t.transaction_date.split('T')[0];
      } else if (t.fecha) {
        const parts = t.fecha.split('-');
        if (parts.length === 3) {
          if (parts[0].length === 4) dateStr = `${parts[0]}-${parts[1]}-${parts[2]}`;
          else dateStr = `${parts[2]}-${parts[1]}-${parts[0]}`;
        }
      }
      if (!dateStr) return;
      if (!roiDayGroups[dateStr]) roiDayGroups[dateStr] = [];
      roiDayGroups[dateStr].push(t);
    });

    // 3. Iterative TWR + Simple ROI calculation
    const currentAssetQtys = {};
    // roiFifo: FIFO calculator for the ROI pipeline (DB-primary transactions with eur_total).
    // Mirrors Dashboard's FIFOCalculator.getOpenPositionPrefCost() exactly.
    const roiFifo = new FIFOCalculator();
    // roiCurrentQtys: mirrors roiFifo's open position quantities, updated on every BUY/SELL
    // from roiTransactions. Ensures roiEndValueBase uses the same tickers AND quantities
    // as openCostBase — isolating the ROI numerator from the CSV-primary TWR pipeline's
    // currentAssetQtys, which can diverge due to consolidated Binance seeds or CSV/DB
    // quantity differences when positions are partially sold.
    const roiCurrentQtys = {};
    let cumulativePerformance = new Decimal(1);
    let cumulativeTTWROR = new Decimal(1); // True Time-Weighted Rate of Return
    let cumulativeCost = 0; // total BUY amounts in baseCurrency (all assets, for reference)
    let cumulativeNetFlow = 0; // net external flows: buys + seeds − sell proceeds (baseCurrency)
    const lastPrices = {};
    const lastFX = {};
    const performanceData = [];

    dateRange.forEach((day) => {
      const assetsAtStart = { ...currentAssetQtys };

      // Calculate startTotalValueBase and endPureValueBase using prices/FX from the END of PREVIOUS day
      let startTotalValueBase = 0;
      let endPureValueBase = 0;
      Object.entries(assetsAtStart).forEach(([ticker, qty]) => {
        if (qty > 0.0001) {
          const cur = assetCurrencyMap[ticker] || 'EUR';
          let startFX = 1;
          let endFX = 1;
          
          if (cur !== baseCurrency) {
            const fxHistory = historicalFX[cur] || [];
            startFX = lastFX[cur] || ratesMap[cur] || 1;
            const todayFxData = fxHistory.find(h => h.time === day) || fxHistory.filter(h => h.time < day).pop();
            endFX = todayFxData?.close || startFX;
          }

          let startPrice = lastPrices[ticker];
          if (startPrice === undefined) {
            const history = historicalPrices[ticker] || [];
            const exact = history.find(h => h.time === day);
            startPrice = exact?.close ?? history.filter(h => h.time < day).pop()?.close ?? 0;
          }
          
          const history = historicalPrices[ticker] || [];
          const todayData = history.find(h => h.time === day) || history.filter(h => h.time < day).pop();
          const endPrice = todayData?.close || startPrice || 0;

          startTotalValueBase += (qty * (startPrice || 0) * startFX);
          endPureValueBase += (qty * (endPrice || 0) * endFX);
        }
      });

      // Process transactions for TODAY (flows)
      let dailyNetCashFlow = 0;
      // Today's REAL buys, valued twice: what they cost at the execution price and
      // what they were worth at the close. They are the missing first sub-period of
      // the TTWROR chain — see the isolatedTTWROR block below.
      let buysCostBase = 0;
      let buysEndValueBase = 0;
      // Today's REAL sells, mirrored: what the sold units were worth at the close
      // (endPureValueBase already counts them — they were held at the start) and
      // what was actually cashed at the execution price. See isolatedTTWROR.
      let sellsCloseValueBase = 0;
      let sellsProceedsBase = 0;

      if (dayGroups[day]) {
        dayGroups[day].forEach(t => {
          const isin = t.isin || t.positions?.assets?.isin;
          const rawIdentifier = t.positions?.assets?.ticker || t.producto;
          const identifier = rawIdentifier || isin;
          const ticker = (isin && resolveTicker(isin))
            || (isin && dynamicTickerMap[isin])
            || resolveTicker(identifier)
            || dynamicTickerMap[identifier];
          const qty = parseFloat(t.cantidad || t.quantity || 0);

          if (t.type === 'BUY' || t.transaction_type === 'BUY') {
            currentAssetQtys[ticker] = (currentAssetQtys[ticker] || 0) + qty;
            
            const cur_t = assetCurrencyMap[ticker] || 'EUR';
            const price_t = parseFloat(t.precio || t.price || 0);
            const fxHistory_t = historicalFX[cur_t] || [];
            const fxData_t = fxHistory_t.find(h => h.time === day) || fxHistory_t.filter(h => h.time < day).pop();
            const fxRate_t = cur_t !== baseCurrency ? (fxData_t?.close || lastFX[cur_t] || ratesMap[cur_t] || 1) : 1;

            // Seed lastFX for ALL BUYs (including consolidated) before any early return.
            // If this is the first trade in this currency, record today's FX so the NEXT
            // day's startTotalValueBase uses the correct rate instead of defaulting to 1.
            // (Without this, a consolidated Binance seed that is the first USD asset would
            // leave lastFX['USD'] undefined, causing an artificial ~-12% drop on day 2.)
            if (cur_t !== baseCurrency && !lastFX[cur_t] && fxData_t?.close) {
              lastFX[cur_t] = fxData_t.close;
            }

            if (t.isConsolidated) {
              // Consolidated BUY = CSV export snapshot. Treat as a cash injection for TTWROR to prevent artificial spikes.
              const history = historicalPrices[ticker] || [];
              const seedData = history.find(h => h.time === day) || history.filter(h => h.time < day).pop();
              const seedPrice = seedData?.close || price_t;
              if (seedPrice > 0) {
                lastPrices[ticker] = seedPrice;
                dailyNetCashFlow += (qty * seedPrice * fxRate_t);
              }
              return; // Skip standard cost accounting
            }

            // Standard BUY: Track cumulative invested cost in baseCurrency
            let buyCost = 0;
            if (t.eur_total != null && baseCurrency === 'EUR') {
              buyCost = Math.abs(parseFloat(t.eur_total));
            } else if (price_t > 0) {
              buyCost = qty * price_t * fxRate_t;
            }
            cumulativeCost += buyCost;
            dailyNetCashFlow += buyCost;

            // Use the historical adjclose (split-adjusted) as the reference price for lastPrices.
            // Yahoo Finance retroactively adjusts ALL historical prices for stock splits via adjclose.
            // Broker CSV prices are the ACTUAL price paid (pre-split). Using the trade price causes
            // a catastrophic artificial TTWROR crash on the day after the first pre-split buy
            // (e.g. NVDA 10:1 split June 2024: buy at $610, adjclose shows $61 → -90% crash).
            //
            // Beyond preventing the crash, we also detect the split ratio and inflate the stored
            // quantity to post-split units. This ensures TTWROR weights are proportional to the
            // actual position value from this day forward, not 10× understated.
            const nativePrice = price_t > 0 ? price_t : (buyCost / qty / fxRate_t);
            {
              const hist = historicalPrices[ticker] || [];
              const seedBar = hist.find(h => h.time === day) || hist.filter(h => h.time < day).pop();
              const adjClose = seedBar?.close;
              if (!lastPrices[ticker]) {
                lastPrices[ticker] = adjClose > 0 ? adjClose : (nativePrice > 0 ? nativePrice : 0);
              }
              // Split detection: trade_price / adjclose ≈ N means this is a pre-split transaction.
              // Adjust qty to post-split equivalent. Tolerance 10% handles intraday price drift.
              let splitFactor = null;
              if (adjClose > 0 && nativePrice > 0) {
                const priceRatio = nativePrice / adjClose;
                splitFactor = [2, 3, 4, 5, 7, 10, 20].find(r => Math.abs(priceRatio - r) / r < 0.10) || null;
                if (splitFactor) currentAssetQtys[ticker] += qty * (splitFactor - 1);
              }

              // Buy-day sub-period legs. Cost uses the EXECUTION price (not eur_total:
              // that carries the commission, which belongs to the cost basis, not to
              // the day's market move); value uses the same close the rest of the
              // chain uses, so the two legs differ ONLY by the intraday move.
              // Split-invariant: qty×nativePrice ≡ (qty×split)×adjClose.
              //
              // ONLY when the execution price and the quote are in the same currency.
              // They often are not: AMZN bought on Xetra settles in EUR while Yahoo
              // quotes it in USD, and a mislabelled crypto buy can carry a USD price
              // tagged EUR. Comparing those two prices measures the exchange rate, not
              // the market — a fake ±15% link that the magnitude guard would wave
              // through. When they disagree, skip the leg (old behaviour: no link).
              const execCurrency = (t.transaction_currency || t.moneda || '').toUpperCase();
              const sameCurrency = !execCurrency || execCurrency === (cur_t || '').toUpperCase();
              if (adjClose > 0 && nativePrice > 0 && sameCurrency) {
                buysCostBase += qty * nativePrice * fxRate_t;
                buysEndValueBase += qty * (splitFactor || 1) * adjClose * fxRate_t;
              }
            }
          } else if (t.isConsolidated) {
            return; // Skip consolidated SELL/FEE/DIVIDEND — they are historical snapshots, not replay events
          } else if (t.type === 'SELL' || t.transaction_type === 'SELL') {
            // Split detection for SELLs: same logic as BUYs.
            // Pre-split SELL qty must be inflated to post-split equivalent so currentAssetQtys
            // stays consistent with the inflated BUY qty.
            // Note: SELL proceeds (qty × price) are value-equivalent pre/post split and need
            // no adjustment (10 shares × $700 = 100 shares × $70 = $7,000).
            const price_t = parseFloat(t.precio || t.price || 0);
            const cur_t = assetCurrencyMap[ticker] || 'EUR';
            const fxHistory_t = historicalFX[cur_t] || [];
            const fxData_t = fxHistory_t.find(h => h.time === day) || fxHistory_t.filter(h => h.time < day).pop();
            const fxRate_t = cur_t !== baseCurrency ? (fxData_t?.close || lastFX[cur_t] || ratesMap[cur_t] || 1) : 1;
            {
              const hist = historicalPrices[ticker] || [];
              const seedBar = hist.find(h => h.time === day) || hist.filter(h => h.time < day).pop();
              const adjClose = seedBar?.close;
              let effectiveSellQty = qty;
              let splitFactor = null;
              if (adjClose > 0 && price_t > 0) {
                const priceRatio = price_t / adjClose;
                splitFactor = [2, 3, 4, 5, 7, 10, 20].find(r => Math.abs(priceRatio - r) / r < 0.10) || null;
                if (splitFactor) effectiveSellQty = qty * splitFactor;
              }
              currentAssetQtys[ticker] = (currentAssetQtys[ticker] || 0) - effectiveSellQty;

              // Sell-day sub-period legs (2026-10-02). The sold units were valued
              // at the CLOSE by endPureValueBase, as if sold at the last instant:
              // selling at 104 a stock that closes at 95 booked a −5% that never
              // happened. Replace that close value with what was actually cashed.
              // Same guards as the buy legs: execution price (not eur_total — the
              // commission is cost, not market), same currency as the quote, and
              // only for units held at the START of the day (an intraday round trip
              // is left to the old maths). Split-invariant: qty×price ≡ (qty×split)×adjClose.
              const execCurrency = (t.transaction_currency || t.moneda || '').toUpperCase();
              const sameCurrency = !execCurrency || execCurrency === (cur_t || '').toUpperCase();
              const heldAtStart = (assetsAtStart[ticker] || 0) + 1e-6 >= effectiveSellQty;
              if (adjClose > 0 && price_t > 0 && sameCurrency && heldAtStart) {
                const closeBar = hist.find(h => h.time === day) || hist.filter(h => h.time < day).pop();
                const endPrice = closeBar?.close || 0;
                const endFX = cur_t !== baseCurrency ? (fxData_t?.close || lastFX[cur_t] || 1) : 1;
                sellsCloseValueBase += effectiveSellQty * endPrice * endFX;
                sellsProceedsBase += qty * price_t * fxRate_t;
              }
            }

            // Calculate SELL proceeds for net cash flow

            let sellProceeds = 0;
            if (t.eur_total != null && baseCurrency === 'EUR') {
              sellProceeds = Math.abs(parseFloat(t.eur_total));
            } else if (price_t > 0) {
              sellProceeds = qty * price_t * fxRate_t;
            }
            dailyNetCashFlow -= sellProceeds;
          }
        });
      }

      // ROI Actual: process this day's transactions through the FIFO calculator.
      // Uses the DB-primary pipeline (roiTransactions) which carries eur_total — the actual
      // EUR amount paid at the historical FX rate. This matches Dashboard's loadDashboardData
      // exactly: FIFOCalculator + eur_total → getOpenPositionPrefCost() as denominator.
      if (roiDayGroups[day]) {
        roiDayGroups[day].forEach(t => {
          if (t.isConsolidated) return;
          const txType = t.transaction_type || t.type;
          const isin = t.positions?.assets?.isin || t.isin;
          const prod = t.positions?.assets?.ticker || t.producto;
          const cur = t.positions?.assets?.currency || t.moneda || 'EUR';
          const qty = parseFloat(t.quantity || t.cantidad || 0);
          const price = parseFloat(t.price || t.precio || 0);

          if (txType === 'BUY' && qty > 0) {
            // Priority 1: eur_total from DB transaction (actual EUR paid at historical FX).
            // Priority 2: qty × price × YF historical FX (CSV fallback for unsaved brokers).
            let prefCost = 0;
            if (t.eur_total != null && baseCurrency === 'EUR') {
              prefCost = Math.abs(parseFloat(t.eur_total));
            } else if (price > 0) {
              const fxHist = historicalFX[cur] || [];
              const fxEntry = fxHist.find(h => h.time === day) || fxHist.filter(h => h.time < day).pop();
              const fxRate = cur !== baseCurrency ? (fxEntry?.close || lastFX[cur] || ratesMap[cur] || 1) : 1;
              prefCost = qty * price * fxRate;
            }
            if (prefCost > 0) {
              roiFifo.processBuy({ isin, producto: prod, cantidad: qty, precio: price, moneda: cur, _prefCost: prefCost });
              const resolvedTicker = (isin && resolveTicker(isin)) || (isin && dynamicTickerMap[isin]) || resolveTicker(prod) || dynamicTickerMap[prod];
              if (resolvedTicker) {
                roiCurrentQtys[resolvedTicker] = (roiCurrentQtys[resolvedTicker] || 0) + qty;
              }
            }
          } else if (txType === 'SELL' && qty > 0) {
            roiFifo.processSell({ isin, producto: prod, cantidad: qty, precio: price, moneda: cur });
            const resolvedTicker = (isin && resolveTicker(isin)) || (isin && dynamicTickerMap[isin]) || resolveTicker(prod) || dynamicTickerMap[prod];
            if (resolvedTicker) roiCurrentQtys[resolvedTicker] = Math.max(0, (roiCurrentQtys[resolvedTicker] || 0) - qty);
          }
        });
      }

      // Calculate Return for TODAY
      let totalWeightedReturn = 0;
      const individualPerformance = {};

      Object.entries(assetsAtStart).forEach(([ticker, qty]) => {
        if (qty > 0.0001 && startTotalValueBase > 0) {
          const cur = assetCurrencyMap[ticker] || 'EUR';

          // FX Rates
          let startFX = 1;
          let endFX = 1;
          if (cur !== baseCurrency) {
            startFX = lastFX[cur] || ratesMap[cur] || 1;
            const fxHistory = historicalFX[cur] || [];
            const fxData = fxHistory.find(h => h.time === day) || fxHistory.filter(h => h.time < day).pop();
            endFX = fxData?.close || startFX;
            lastFX[cur] = endFX;
          }

          // Prices
          const history = historicalPrices[ticker] || [];
          const priceData = history.find(h => h.time === day) || history.filter(h => h.time < day).pop();

          let startPrice = lastPrices[ticker];
          if (startPrice === undefined) {
            const todayData = history.find(h => h.time === day);
            startPrice = todayData?.close || 0;
          }

          const endPrice = priceData?.close || startPrice || 0;

          const weight = (qty * startPrice * startFX) / startTotalValueBase;
          const rawAssetRet = startPrice > 0 ? (endPrice / startPrice) - 1 : 0;
          const assetRet = Number.isFinite(rawAssetRet) ? rawAssetRet : 0;

          totalWeightedReturn += (assetRet * weight);
          lastPrices[ticker] = endPrice;

          // Use company name as key so the breakdown tooltip shows readable names
          const displayName = assetNameMap[ticker] || ticker;
          individualPerformance[displayName] = assetRet;
        } else if (qty > 0.0001) {
          // startTotalValueBase is 0 (first day of first asset): just seed lastPrices/lastFX
          const cur = assetCurrencyMap[ticker] || 'EUR';
          const fxHistory = historicalFX[cur] || [];
          const fxData = fxHistory.find(h => h.time === day) || fxHistory.filter(h => h.time < day).pop();
          if (cur !== baseCurrency) lastFX[cur] = fxData?.close || ratesMap[cur] || 1;

          const history = historicalPrices[ticker] || [];
          const priceData = history.find(h => h.time === day) || history.filter(h => h.time < day).pop();
          lastPrices[ticker] = priceData?.close || 0;
        }
      });

      // Chain the return using Decimal to prevent float drift over hundreds of daily compounding steps
      cumulativePerformance = cumulativePerformance.times(new Decimal(1).plus(new Decimal(totalWeightedReturn)));

      // End-of-day portfolio valuation in base currency
      let endTotalValueBase = 0;
      Object.entries(currentAssetQtys).forEach(([ticker, qty]) => {
        if (qty > 0.0001) {
          const cur = assetCurrencyMap[ticker] || 'EUR';
          const fxRate = lastFX[cur] || ratesMap[cur] || 1;

          // lastPrices[ticker] may not be set yet on the very first buy day;
          // fall back to today's close from historical data.
          let price = lastPrices[ticker];
          if (!price) {
            const history = historicalPrices[ticker] || [];
            const fallback = history.find(h => h.time === day) || history.filter(h => h.time < day).pop();
            price = fallback?.close || 0;
            // Seed lastPrices so the next day's startTotalValueBase uses this value
            if (price > 0) lastPrices[ticker] = price;
          }

          endTotalValueBase += (qty * price * fxRate);
        }
      });

      // roiEndValueBase: market value using roiCurrentQtys — the same BUY/SELL source as roiFifo.
      // Numerator and denominator now use identical tickers AND identical quantities,
      // fully isolated from the CSV-primary TWR pipeline's currentAssetQtys.
      let roiEndValueBase = 0;
      Object.entries(roiCurrentQtys).forEach(([ticker, qty]) => {
        if (qty > 0.0001) {
          const cur = assetCurrencyMap[ticker] || 'EUR';
          const fxRate = lastFX[cur] || ratesMap[cur] || 1;
          const price = lastPrices[ticker] || 0;
          roiEndValueBase += (qty * price * fxRate);
        }
      });

      const hasAssets = Object.values(currentAssetQtys).some(q => q > 0.0001) || Object.values(assetsAtStart).some(q => q > 0.0001);
      
      // Calculate True Time-Weighted Rate of Return (TTWROR) for today.
      //
      // Base method (days with no buys): EOD value of yesterday's assets vs their
      // Start-of-Day value — skips cash-flow noise and broker fees entirely.
      //
      // Days WITH a real buy add that buy's own sub-period, which is the canonical
      // TWR link  R = V_f / (V_i + C) − 1  (GIPS). Without it the move between the
      // execution price and that day's close was silently thrown away FOREVER: a
      // single CSU.TO share bought at the 2026-02-26 open (C$2465.01, close
      // C$2607.72) lost 5.67 pp of a real +22.5% — the chart showed +15.94%.
      //
      // Consolidated seeds (CSV snapshots) are deliberately NOT part of this: they
      // are old positions re-declared at the close, not money entering today, so
      // adding them to the denominator would dilute the real assets' return.
      //
      // Days WITH a real sell are the mirror image: the sold units leave at the
      // EXECUTION price (proceeds treated as an end-of-day outflow, which is
      // what lets TWR work without modelling a cash account), so their close
      // value is swapped for what was cashed:
      //   R = (V_end_held + proceeds + V_end_bought − (V_start + C)) / (V_start + C)
      let isolatedTTWROR = 0;
      const flowDenominator = startTotalValueBase + buysCostBase;
      if (flowDenominator > 0) {
        const endValue = endPureValueBase - sellsCloseValueBase + sellsProceedsBase + buysEndValueBase;
        const rawDailyReturn = (endValue - flowDenominator) / flowDenominator;
        // The buy/sell legs are the only part fed by broker CSV prices — the dirty
        // input (pre-split rows, wrong currency, typo'd price). A day that swings more
        // than MAX_BUY_DAY_SWING is data, not market: drop the link instead of injecting
        // a fake spike into a compounding chain. Days without trades keep the old maths.
        const isSuspect = (buysCostBase > 0 || sellsProceedsBase > 0)
          && (!Number.isFinite(rawDailyReturn) || Math.abs(rawDailyReturn) > MAX_BUY_DAY_SWING);
        isolatedTTWROR = isSuspect ? 0 : (Number.isFinite(rawDailyReturn) ? rawDailyReturn : 0);
      }

      cumulativeTTWROR = cumulativeTTWROR.times(new Decimal(1).plus(new Decimal(isolatedTTWROR)));

      // Net external flows accumulate buys (incl. consolidated seeds) minus sell
      // proceeds — the correct baseline for "period gain = ΔV − Δflows".
      cumulativeNetFlow += dailyNetCashFlow;

      if (hasAssets || dayGroups[day]) {
        const currentYield = cumulativePerformance.minus(1).times(100).toNumber();
        const currentTTWROR = cumulativeTTWROR.minus(1).times(100).toNumber();
        // ROI Actual = Latente / Coste Posiciones Abiertas × 100
        // openCostBase = FIFO preferred-currency cost of currently-held lots (after SELLs consumed lots).
        // Mirrors Dashboard's: dbOpenPositionCost = fifo.getOpenPositionPrefCost()
        const openCostBase = roiFifo.getOpenPositionPrefCost();
        const simpleROI = openCostBase > 0 ? (roiEndValueBase - openCostBase) / openCostBase * 100 : 0;
        // Beta ROI = Realized gains / Cost basis of sold assets × 100
        // Only reflects completed (sold) trades — ignores unrealized positions.
        const soldCostBasis = roiFifo.getTotalSoldCostBasis();
        const realizedGain = roiFifo.getTotalRealizedGain();
        const betaROI = soldCostBasis > 0 ? (realizedGain / soldCostBasis) * 100 : null;
        performanceData.push({
          name: day,
          date: day,
          value: endTotalValueBase,
          cumulativeCost,
          cumulativeNetFlow,
          simpleROI,
          betaROI,
          isolatedTTWROR,
          ttwror: currentTTWROR,
          dailyReturn: totalWeightedReturn,
          yield: currentYield,
          displayYield: currentYield.toFixed(2),
          displayPerformance: currentYield,  // TWR is the chart line — unaffected by cash flows
          cumulativeReturn: currentYield,
          breakdown: individualPerformance
        });
      }
    });

    // Attach the display names of currently-open positions to the last data point so
    // the chart tooltip can filter "Movimientos del día" to only show held assets.
    // Uses display names (assetNameMap values) because breakdown keys are display names.
    if (performanceData.length > 0) {
      performanceData[performanceData.length - 1]._finalHoldingNames = new Set(
        Object.entries(currentAssetQtys)
          .filter(([, qty]) => qty > 0.0001)
          .map(([ticker]) => assetNameMap[ticker] || ticker)
      );
    }

    return performanceData;
  }
};

/**
 * Los números para EXPLICAR una anualizada compuesta con los datos del usuario:
 * el TWR que reconstruye, la media "TWR ÷ años" que uno haría de cabeza (y que
 * siempre da de más con rentabilidad positiva) y cómo crecen 100 de base.
 * Caso real: +75,08 % en 1,99 años → +32,45 % anual, no +37,7 %.
 * @param {{ cagrPct: number|null, years: number|null }} p
 * @returns {{ twrPct: number, naiveAvgPct: number, afterFirstYear: number|null, final: number } | null}
 */
export function cagrWorkedExample({ cagrPct, years }) {
  if (!Number.isFinite(cagrPct) || !(years > 0)) return null;
  const growth = 1 + cagrPct / 100;
  const twrPct = (Math.pow(growth, years) - 1) * 100;
  return {
    twrPct,
    naiveAvgPct: twrPct / years,
    afterFirstYear: years >= 1 ? 100 * growth : null,
    final: 100 + twrPct,
  };
}
