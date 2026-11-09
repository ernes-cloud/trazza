/**
 * GET /share-data/:token  — public endpoint, no auth required.
 *
 * For mode='snapshot': returns the pre-computed snapshot_data stored on creation.
 * For mode='live':     fetches current positions from DB and computes full metrics.
 *
 * All monetary metrics are returned in EUR. The client converts to the display
 * currency chosen by the visitor using the `rates` object included in the response.
 */

import { supabaseAdmin } from '../lib/adminSupabase.js';
// Shared FIFO pipeline — the SAME implementation the brokers screen and Dashboard use.
// Requires the server to be deployed alongside the repo's src/ directory (monorepo).
import { computeHistoryTotals, scaleOpenCostToHeldQty, computeInvestedHybrid } from '../../src/services/portfolioHistory.js';
import { computeEmbeddedCommissionsFallback } from '../../src/services/portfolioStats.js';
// Per-position row math — THE same function PositionsDesktopTable/MobileList use,
// so the shared page's per-position % matches the brokers screen by construction.
import { computePositionRowMetrics } from '../../src/services/positionRowMetrics.js';
import { annualizeReturn } from '../../src/services/performanceService.js';
import { isCashPosition } from '../../src/lib/positionKind.js';

export const includesInvestedSharePosition = (position) => !isCashPosition(position);

// ── Historical FX rates (mirrors src/services/currencyService.getHistoricalRate) ──
// Yahoo chart endpoint first, Frankfurter (ECB) fallback. Cached in-process forever
// (historical rates don't change).
const _histRateCache = new Map();

async function getHistoricalRateEur(from, to, dateStr) {
  if (!from || !to || from === to || !dateStr) return null;
  const cacheKey = `${from}_${to}_${dateStr}`;
  if (_histRateCache.has(cacheKey)) return _histRateCache.get(cacheKey);

  const target = new Date(dateStr);
  const period1 = Math.floor((target.getTime() - 5 * 86400000) / 1000);
  const period2 = Math.floor(Math.min(target.getTime() + 7 * 86400000, Date.now()) / 1000);

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(`${from}${to}=X`)}?period1=${period1}&period2=${period2}&interval=1d`;
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (resp.ok) {
      const data = await resp.json();
      const result = data?.chart?.result?.[0];
      if (result) {
        const timestamps = result.timestamp || [];
        const closes = result.indicators?.quote?.[0]?.close || [];
        const targetTs = Math.floor(target.getTime() / 1000);
        let bestIdx = -1, minDist = Infinity;
        timestamps.forEach((ts, i) => {
          if (closes[i] == null) return;
          const dist = Math.abs(ts - targetTs);
          if (dist < minDist) { minDist = dist; bestIdx = i; }
        });
        if (bestIdx !== -1) {
          _histRateCache.set(cacheKey, closes[bestIdx]);
          return closes[bestIdx];
        }
      }
    }
  } catch { /* fall through to Frankfurter */ }

  try {
    const fResp = await fetch(`https://api.frankfurter.dev/v1/${dateStr}?from=${from}&to=${to}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (fResp.ok) {
      const fData = await fResp.json();
      const rate = fData?.rates?.[to];
      if (rate) {
        _histRateCache.set(cacheKey, rate);
        return rate;
      }
    }
  } catch (e2) {
    console.error(`[sharePortfolio] historical rate ${from}→${to} @ ${dateStr} failed:`, e2.message);
  }
  return null;
}

// ── Ticker resolution (mirrors src/lib/tickerMap.js) ──────────────────────────
const TICKER_MAP = {
  GB00BVGBY890:'ZEG.L', US02079K3059:'GOOGL', US02079K1079:'GOOGL', GOOG:'GOOGL',
  US0231351067:'AMZN',  US57636Q1040:'MA',    US30303M1027:'META',  US5949181045:'MSFT',
  CA21037X1006:'CSU.TO',CSU:'CSU.TO',          US0378331005:'AAPL', US88160R1014:'TSLA',
  US67066G1040:'NVDA',  US01609W1027:'BABA',  IE00B4L5Y983:'IWDA.AS',
  IE00B1YZSC51:'VUSA.AS',IE00B3RBWM25:'VWCE.AS',
  FR0000121014:'MC.PA', FR0000131104:'BNP.PA', FR0000120271:'TOTAL.PA',
  FR0000120073:'AI.PA', FR0000120628:'ACA.PA', FR0000131757:'CAP.PA',
  NL0011585146:'RACE',  IT0003132476:'ENI.MI', NL0010273215:'ASML.AS',
  GB0031348658:'III.L', RMS:'RMS.PA',          IB1T:'IB1T.DE',       AMZ:'AMZ.DE',
};

function resolveTicker(t) {
  if (!t) return t;
  const clean = t.replace(/\s*\[.*?\]/g,'').replace(/\s*\([A-Z]{3}\)$/i,'').trim();
  return TICKER_MAP[clean.toUpperCase()] || clean;
}

// ── Country / Region helpers ──────────────────────────────────────────────────
const ISIN_COUNTRY = {
  US:'United States', CA:'Canada',         GB:'United Kingdom', DE:'Germany',
  FR:'France',        ES:'Spain',          IT:'Italy',          NL:'Netherlands',
  CH:'Switzerland',   SE:'Sweden',         NO:'Norway',         DK:'Denmark',
  FI:'Finland',       BE:'Belgium',        PT:'Portugal',       AT:'Austria',
  LU:'Luxembourg',    IE:'Ireland',        JP:'Japan',          CN:'China',
  HK:'Hong Kong',     AU:'Australia',      IN:'India',          KR:'South Korea',
  TW:'Taiwan',        SG:'Singapore',      BR:'Brazil',         AR:'Argentina',
  MX:'Mexico',        SA:'Saudi Arabia',   AE:'UAE',            IL:'Israel',
};

const REGION_MAP = {
  'United States':'Norteamérica','Canada':'Norteamérica',
  'United Kingdom':'Europa',   'Germany':'Europa',     'France':'Europa',
  'Spain':'Europa',            'Italy':'Europa',       'Netherlands':'Europa',
  'Switzerland':'Europa',      'Sweden':'Europa',      'Norway':'Europa',
  'Denmark':'Europa',          'Finland':'Europa',     'Belgium':'Europa',
  'Portugal':'Europa',         'Austria':'Europa',     'Luxembourg':'Europa',
  'Ireland':'Europa',
  'Japan':'Asia-Pacífico',     'China':'Asia-Pacífico','Hong Kong':'Asia-Pacífico',
  'Australia':'Asia-Pacífico', 'India':'Asia-Pacífico','South Korea':'Asia-Pacífico',
  'Taiwan':'Asia-Pacífico',    'Singapore':'Asia-Pacífico',
  'Brazil':'Latinoamérica',    'Argentina':'Latinoamérica','Mexico':'Latinoamérica',
  'Saudi Arabia':'Oriente Medio','UAE':'Oriente Medio','Israel':'Oriente Medio',
};

function countryFromIsin(isin) {
  if (!isin || isin.length < 2) return null;
  return ISIN_COUNTRY[isin.slice(0,2).toUpperCase()] || null;
}

function countryFromTicker(ticker) {
  if (!ticker) return null;
  const t = ticker.toUpperCase();
  if (t.endsWith('.L'))                           return 'United Kingdom';
  if (t.endsWith('.PA'))                          return 'France';
  if (t.endsWith('.AS'))                          return 'Netherlands';
  if (t.endsWith('.DE') || t.endsWith('.XETRA')) return 'Germany';
  if (t.endsWith('.MI'))                          return 'Italy';
  if (t.endsWith('.MC'))                          return 'Spain';
  if (t.endsWith('.SW'))                          return 'Switzerland';
  if (t.endsWith('.TO'))                          return 'Canada';
  if (t.includes('-'))                            return null; // crypto
  return 'United States';
}

// ── Exchange rates cache (30-min TTL) ─────────────────────────────────────────
// Rates are EUR-based: rates[USD] = 1.08 means 1 EUR = 1.08 USD.
// To convert nativeValue → EUR: nativeValue / rates[nativeCurrency].
// To convert eurValue → displayCurrency: eurValue * rates[displayCurrency].
const STATIC_RATES = {
  EUR:1, USD:1.08, GBP:0.85, CHF:0.97, CAD:1.47,
  JPY:163, AUD:1.66, SEK:11.0, DKK:7.46, NOK:11.5,
};

let _ratesCache = null;
let _ratesCacheTs = 0;

// Fetch a single EUR-based rate from Yahoo Finance (same source as the app's currencyService).
// Returns "1 EUR = X currency" (same convention as open.er-api).
async function fetchYahooRate(currency) {
  if (currency === 'EUR') return 1;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    // EUR/CUR=X gives "1 EUR in CUR" — exactly the rate we need.
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/EUR${currency}=X?interval=1d&range=1d`;
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    const json = await resp.json();
    const price = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return price && price > 0 ? price : null;
  } catch {
    return null;
  }
}

async function getExchangeRates() {
  const now = Date.now();
  if (_ratesCache && now - _ratesCacheTs < 10 * 60 * 1000) return _ratesCache;

  // Primary: Yahoo Finance (same source as the app) for each major currency.
  // Falls back to open.er-api.com for any currency Yahoo can't serve.
  const CURRENCIES = ['USD', 'GBP', 'CHF', 'CAD', 'JPY', 'AUD', 'SEK', 'DKK', 'NOK'];
  try {
    const entries = await Promise.all(
      CURRENCIES.map(async cur => {
        const rate = await fetchYahooRate(cur);
        return [cur, rate];
      })
    );
    const yahooRates = { EUR: 1 };
    const missing = [];
    for (const [cur, rate] of entries) {
      if (rate != null) yahooRates[cur] = rate;
      else missing.push(cur);
    }

    // Fill missing currencies from open.er-api fallback
    if (missing.length > 0) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch('https://open.er-api.com/v6/latest/EUR', { signal: controller.signal });
        clearTimeout(timeout);
        if (resp.ok) {
          const json = await resp.json();
          if (json.result === 'success') {
            for (const cur of missing) {
              if (json.rates[cur]) yahooRates[cur] = json.rates[cur];
            }
          }
        }
      } catch { /* use STATIC_RATES for missing */ }
      for (const cur of missing) {
        if (!yahooRates[cur] && STATIC_RATES[cur]) yahooRates[cur] = STATIC_RATES[cur];
      }
    }

    _ratesCache = yahooRates;
    _ratesCacheTs = now;
    return _ratesCache;
  } catch (e) {
    console.error('[sharePortfolio] FX rates failed:', e.message);
    // Last resort: try open.er-api then static
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch('https://open.er-api.com/v6/latest/EUR', { signal: controller.signal });
      clearTimeout(timeout);
      if (resp.ok) {
        const json = await resp.json();
        if (json.result === 'success') {
          _ratesCache = { EUR: 1, ...json.rates };
          _ratesCacheTs = now;
          return _ratesCache;
        }
      }
    } catch { /* fall through */ }
    return _ratesCache || { ...STATIC_RATES };
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getShare(req, res) {
  const { token } = req.params;
  if (!token || !UUID_RE.test(token)) return res.status(400).json({ error: 'Invalid token' });
  if (!supabaseAdmin) return res.status(503).json({ error: 'Service not configured' });

  const { data: share, error } = await supabaseAdmin
    .from('portfolio_shares')
    .select('*')
    .eq('id', token)
    .maybeSingle();

  if (error) {
    console.error('[sharePortfolio] DB error:', error.message);
    return res.status(500).json({ error: 'Internal error' });
  }
  if (!share) return res.status(404).json({ error: 'not_found' });

  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    return res.status(410).json({ error: 'expired' });
  }

  const cfg = share.config || {};

  // `show_chart` apagado ⇒ la serie NO sale de aquí. El cliente ya no la guarda
  // desde el arreglo del interruptor, pero los shares creados ANTES sí la
  // llevan en la fila: filtrarla en el server es lo que los tapa sin migración.
  // Ojo: esta es la única defensa para un share antiguo — la respuesta pública
  // es legible con curl, así que no basta con que la página no la pinte.
  const sharedPerformance = cfg.show_chart === false ? null : (share.performance_data || null);

  // Snapshot — return stored payload as-is (already includes metrics + rates if saved with new format)
  if (share.mode === 'snapshot') {
    return res.json({
      label: share.label, mode: 'snapshot', config: cfg,
      expires_at: share.expires_at,
      performance_data: sharedPerformance,
      ...(share.snapshot_data || {}),
    });
  }

  // ── Live mode ──────────────────────────────────────────────────────────────
  try {
    const rates = await getExchangeRates();

    // Helper: native value → EUR
    const toEur = (val, cur) => {
      const r = rates[cur] || rates[(cur||'').toUpperCase()] || 1;
      return val / r;
    };

    // Fetch brokers
    let brokersQuery = supabaseAdmin
      .from('brokers').select('id, name').eq('user_id', share.user_id);
    if (share.broker_ids?.length) brokersQuery = brokersQuery.in('id', share.broker_ids);

    const { data: brokers } = await brokersQuery;
    const brokerIds     = (brokers || []).map(b => b.id);
    const brokerNameMap = Object.fromEntries((brokers || []).map(b => [b.id, b.name]));

    if (!brokerIds.length) {
      return res.json({
        label: share.label, mode: 'live', config: cfg, expires_at: share.expires_at,
        positions: [], is_mixed_currency: false, rates,
        metrics: null, updated_at: new Date().toISOString(),
      });
    }

    // Fetch open positions (qty > 0, non-cash)
    const { data: rawPositions, error: posErr } = await supabaseAdmin
      .from('positions')
      .select(`
        id, quantity, entry_price, broker_id,
        assets(id, ticker, company_name, current_price, currency,
               asset_class, sector, industry, country, isin)
      `)
      .in('broker_id', brokerIds)
      .gt('quantity', 0);

    if (posErr) {
      console.error('[sharePortfolio] positions error:', posErr.message);
      return res.status(500).json({ error: 'Failed to fetch positions' });
    }

    const invested = (rawPositions || []).filter(includesInvestedSharePosition);

    // ── Transactions + FIFO pipeline (SIEMPRE, antes del map de posiciones) ──
    // Fetch ALL positions (including qty=0) so we capture closed-position transactions.
    const { data: allPositions, error: allPosErr } = await supabaseAdmin
      .from('positions')
      .select('id')
      .in('broker_id', brokerIds);
    if (allPosErr) console.error('[sharePortfolio] allPositions error:', allPosErr.message);
    const allPositionIds = (allPositions || []).map(p => p.id);

    let txData = [];
    if (allPositionIds.length > 0) {
      const { data, error: txErr } = await supabaseAdmin
        .from('transactions')
        // `company_name` hace falta para el NOMBRE de cada venta realizada. Sin
        // él, `computeHistoryTotals` cae a `assets.ticker`, y en las filas que
        // creó el import por ISIN el ticker ES el ISIN ("US57636Q1040 (USD)"),
        // así que la tabla de ventas ponía el ISIN donde va "Mastercard Inc".
        .select('id, transaction_type, quantity, price, total_amount, transaction_date, eur_total, notes, transaction_currency, commission, position_id, positions(broker_id, assets(ticker, company_name, currency, isin))')
        .in('position_id', allPositionIds)
        .order('transaction_date', { ascending: true });
      if (txErr) console.error('[sharePortfolio] transactions error:', txErr.message);
      txData = data || [];
    }

    // Spot rates for the pipeline: it expects "EUR per 1 cur"; the server's `rates`
    // map is the inverse ("cur per 1 EUR").
    const spotRatesToEur = {};
    for (const [cur, r] of Object.entries(rates)) {
      if (r > 0) spotRatesToEur[cur] = 1 / r;
    }

    // FULL history always computed: the per-position enrichment below needs
    // perAssetMetrics/buyTotals, which the aggregates cache doesn't carry.
    // (Historical FX fetches are cached in-process forever, so repeat views are fast.)
    const fullHistory = await computeHistoryTotals(txData, 'EUR', spotRatesToEur, {
      getExchangeRate: async (from) => spotRatesToEur[from] ?? 1,
      getHistoricalRate: getHistoricalRateEur,
    });

    // Per-position FIFO cost lookup — mirrors usePositions' enrichment exactly:
    // perAssetMetrics by `${isin|ticker}_${cur}` (queue may span several brokers →
    // scale to this position's held qty, AVCO per remaining share), buy totals by
    // position_id first (authoritative) with the string key as fallback.
    const rowMetricsFor = (p) => {
      const cur = p.assets?.currency || 'USD';
      const isin = p.assets?.isin;
      const tk = p.assets?.ticker;
      const lookup = (map) => (isin && map[`${isin}_${cur}`]) || (tk && map[`${tk}_${cur}`]) || null;
      const am = lookup(fullHistory.perAssetMetrics || {});
      const heldQty = parseFloat(p.quantity) || 0;
      let prefCost = am && am.openPrefCost > 0
        ? scaleOpenCostToHeldQty(am.openPrefCost, am.openQty || 0, heldQty)
        : 0;
      const bt = (fullHistory.buyTotalsByPosition || {})[p.id] || lookup(fullHistory.buyTotalsByAsset || {});
      return computePositionRowMetrics(
        {
          quantity: heldQty,
          entry_price: p.entry_price || 0,
          assets: { currency: cur, current_price: p.assets?.current_price ?? null },
          ...(prefCost > 0 ? { _prefCostTotal: prefCost } : {}),
          ...(bt ? { _histCost: bt } : {}),
        },
        { preferredCurrency: 'EUR', exchangeRates: spotRatesToEur }
      );
    };

    // Compute per-position values and portfolio totals
    let totalEurValue = 0;

    const positions = invested.map(p => {
      const ticker    = resolveTicker(p.assets?.ticker);
      const price     = p.assets?.current_price || 0;
      const qty       = parseFloat(p.quantity) || 0;
      const currency  = p.assets?.currency || 'USD';
      const entry     = p.entry_price || 0;

      const nativeValue = qty * price;
      const eurValue    = toEur(nativeValue, currency);

      totalEurValue += eurValue;

      const country = p.assets?.country || countryFromIsin(p.assets?.isin) || countryFromTicker(ticker);
      const region  = country ? (REGION_MAP[country] || 'Otros') : null;

      // Same row math as the brokers screen (FIFO→AVCO→entry cost in EUR, FX
      // included) — the old `(price − entry)/entry` was price-only vs entry_price
      // and diverged from the app by whole points on FX-heavy positions.
      const rm = rowMetricsFor(p);

      return {
        ticker,
        name:          p.assets?.company_name || ticker || '',
        quantity:      qty,
        current_price: cfg.show_values     ? price   : null,
        currency,
        value:         cfg.show_values     ? nativeValue : null,
        entry_price:   cfg.show_cost_basis ? entry    : null,
        pnl:           cfg.show_pnl ? +(rm.profitConverted ?? 0).toFixed(2) : null,
        pnl_pct:       cfg.show_pnl && (rm.prefCostTotal > 0 || entry > 0) ? +rm.gainPct.toFixed(2) : null,
        broker_name:   cfg.show_broker_names ? (brokerNameMap[p.broker_id] || null) : null,
        sector:        p.assets?.sector   || null,
        industry:      p.assets?.industry || null,
        country,
        region,
        // _eurValue is internal — used for weights, removed before response
        _eurValue:     eurValue,
        weight:        0,
      };
    });

    // Weights always computed from EUR values (accurate for multi-currency portfolios)
    for (const p of positions) {
      p.weight = totalEurValue > 0 ? (p._eurValue / totalEurValue) * 100 : 0;
      delete p._eurValue;
    }

    positions.sort((a, b) => b.weight - a.weight);

    // Aggregates fast path: the brokers screen publishes its computed totals to
    // portfolio_metrics_cache on every load. When the share covers the full
    // portfolio and the cache is EUR-denominated and matches the live transaction
    // count, prefer those numbers — guaranteed identical to the app and immune
    // to this server's cold FX caches. Otherwise the fullHistory computed above
    // (same shared pipeline the app runs client-side).
    let history = fullHistory;
    if (!share.broker_ids?.length) {
      const { data: cacheRow } = await supabaseAdmin
        .from('portfolio_metrics_cache')
        .select('currency, metrics')
        .eq('user_id', share.user_id)
        .eq('scope', 'general')
        .maybeSingle();
      if (cacheRow?.currency === 'EUR' && cacheRow.metrics?.txCount === txData.length) {
        history = cacheRow.metrics;
      }
    }

    const dividendsEur    = history.dividends;
    const totalBuyCostEur = history.totalBuyCost;
    const realizedPnlEur  = history.realized;
    const firstTradeDate  = history.firstTransactionDate;
    const openPositionCostEur = history.openPositionCost;

    // Fees composition mirrors computePortfolioStats on the brokers screen:
    // DB FEE/TAX rows + DB commission column + embedded-JSON fallback for saved
    // brokers whose rows predate the commission column + unsaved-CSV commissions.
    const { data: importedRows } = await supabaseAdmin
      .from('imported_data')
      .select('broker_id, transactions')
      .eq('user_id', share.user_id)
      .in('broker_id', brokerIds);

    const savedBrokerIdSet = new Set(txData.map(t => t.positions?.broker_id).filter(Boolean));
    const savedEmbeddedComisionesEur = computeEmbeddedCommissionsFallback({
      importedTransactionsByBroker: Object.fromEntries(
        (importedRows || []).map(r => [r.broker_id, r.transactions || []])
      ),
      savedBrokerIds: savedBrokerIdSet,
      tradeCommissionsByBroker: history.tradeCommissionsByBroker,
      selectedBrokerId: 'general', // importedRows is already scoped by brokerIds
      eurRate: 1,                  // metrics are EUR-denominated here
    });

    // Unsaved brokers (CSV loaded but not confirmed): their standalone FEE/TAX rows and
    // embedded comisiones only exist in imported_data — EUR-invoiced, counted at 1:1.
    let unsavedCsvCommissionsEur = 0;
    for (const row of (importedRows || [])) {
      if (savedBrokerIdSet.has(row.broker_id)) continue;
      for (const t of (row.transactions || [])) {
        const type = t.type || t.transaction_type;
        if (type === 'BUY' || type === 'SELL') {
          unsavedCsvCommissionsEur += Math.abs(parseFloat(t.comisiones || 0));
        } else if (['FEE', 'FEES', 'TAX'].includes(type)) {
          unsavedCsvCommissionsEur += Math.abs(parseFloat(t.total ?? t.total_amount ?? 0));
        }
      }
    }

    const feesEur = history.fees + history.tradeCommissions
      + savedEmbeddedComisionesEur + unsavedCsvCommissionsEur;

    // Cost basis: hybrid value published by the brokers screen when available
    // (per-position FIFO/entry mix — complete even with partially-saved history);
    // otherwise the SAME computeInvestedHybrid over fullHistory the app computes
    // (FIFO→AVCO→entry per position), so a cache miss no longer degrades to
    // entry-only cost. Never use the raw FIFO openPositionCostEur alone: it only
    // covers brokers whose history is in the transactions table, and the partial
    // cost inflates unrealized P&L.
    const costBasisForUnrealized = (history.investedHybrid > 0)
      ? history.investedHybrid
      : computeInvestedHybrid(invested, fullHistory, spotRatesToEur);

    const unrealizedPnlEur = totalEurValue - costBasisForUnrealized;
    const totalGainEur     = unrealizedPnlEur + realizedPnlEur + dividendsEur - feesEur;
    const effectiveCost    = totalBuyCostEur > 0 ? totalBuyCostEur : costBasisForUnrealized;
    const roiSimple        = effectiveCost > 0 ? (totalGainEur / effectiveCost) * 100 : null;
    const roiCartera       = costBasisForUnrealized > 0 ? (unrealizedPnlEur / costBasisForUnrealized) * 100 : null;

    const hasHistory = totalBuyCostEur > 0 || realizedPnlEur !== 0 || dividendsEur !== 0;
    const cached = share.cached_metrics || {};

    // ── Display-stats fast path — EXACTITUD con lo que ve el que comparte ────
    // La pantalla de brokers publica sus stats de cabecera tal cual las muestra
    // (scope '<bId>:display'), junto con su propio eurRate de cliente. Cuando el
    // share cubre ese mismo scope y el txCount coincide (nada cambió desde la
    // última visita del dueño), servimos ESOS números convertidos a EUR con SU
    // rate — idénticos por construcción a su pantalla. Si el dueño operó sin
    // volver a abrir la app, txCount difiere y caemos al recálculo de abajo.
    let displayStats = null;
    const displayScope = !share.broker_ids?.length
      ? 'general:display'
      : (share.broker_ids.length === 1 ? `${share.broker_ids[0]}:display` : null);
    if (displayScope) {
      const { data: displayRow } = await supabaseAdmin
        .from('portfolio_metrics_cache')
        .select('metrics')
        .eq('user_id', share.user_id)
        .eq('scope', displayScope)
        .maybeSingle();
      const dm = displayRow?.metrics;
      if (dm && dm.txCount === txData.length && dm.eurRate > 0) {
        displayStats = dm;
      }
    }
    const toEurD = (v) => (v == null || displayStats == null) ? null : +(v / displayStats.eurRate).toFixed(2);

    // Annualized return: prefer annualizing the cached TWR (same basis as the brokers
    // screen's "Rentabilidad Anualizada" since the CAGR fix); Simple-ROI only as fallback.
    // La ventana arranca en el primer día INVERTIDO (`invested_since`, que el
    // cliente guarda en el cache desde la serie). `first_trade_date` es la
    // transacción más antigua de CUALQUIER tipo, así que un ingreso de efectivo
    // previo a la primera compra alargaba la ventana y hundía la anualizada.
    // Los shares creados antes de esto no traen el campo y caen al de siempre.
    const annualizeFrom = cached.invested_since || firstTradeDate;
    const annualizedReturn = cached.twr != null
      ? annualizeReturn(cached.twr, annualizeFrom)
      : annualizeReturn(roiSimple, annualizeFrom);

    // LIVE mode strategy:
    // - displayStats frescas (ver arriba): los números EXACTOS de la pantalla del
    //   dueño — máxima prioridad.
    // - ALL metrics recomputed fresh from DB whenever hasHistory=true (transactions exist).
    //   This reflects current prices and recent trades, matching what the Brokers screen shows.
    // - cached_metrics used ONLY as fallback when hasHistory=false (no transactions in DB yet,
    //   e.g. portfolio loaded from CSV but not yet saved). They should NOT override fresh data.
    // - Exception: twr — server cannot compute true TTWROR; always use cached if available.
    const metrics = displayStats ? {
      market_value_eur:   cfg.show_values ? toEurD(displayStats.investedValue) : null,
      open_invested_eur:  cfg.show_values ? toEurD(displayStats.invested)      : null,
      unrealized_pnl_eur: cfg.show_pnl    ? toEurD(displayStats.latentGain)    : null,
      realized_pnl_eur:   cfg.show_pnl    ? toEurD(displayStats.realizedGain)  : null,
      dividends_eur:      cfg.show_pnl    ? toEurD(displayStats.dividendsGain) : null,
      fees_eur:           cfg.show_pnl    ? toEurD(displayStats.feesTotal)     : null,
      total_buy_cost_eur: cfg.show_values ? toEurD(displayStats.totalCapitalDeployed) : null,
      total_gain_eur:     cfg.show_pnl    ? toEurD(displayStats.gain)          : null,
      // Porcentajes: adimensionales, se sirven tal cual (idénticos a la pantalla)
      roi_simple:         cfg.show_pnl ? (displayStats.gainPercent != null ? +displayStats.gainPercent.toFixed(2) : null) : null,
      roi_cartera:        cfg.show_pnl && displayStats.invested > 0
        ? +((displayStats.latentGain / displayStats.invested) * 100).toFixed(2) : null,
      annualized_return:  cfg.show_pnl ? (hasHistory && annualizedReturn != null ? +annualizedReturn.toFixed(2) : (cached.annualized_return ?? null)) : null,
      twr:                cfg.show_pnl ? (cached.twr ?? null) : null,
      first_trade_date:   firstTradeDate || cached.first_trade_date || null,
      has_history:        hasHistory || cached.has_history || false,
    } : {
      market_value_eur:   cfg.show_values ? +totalEurValue.toFixed(2)           : null,
      open_invested_eur:  cfg.show_values ? +costBasisForUnrealized.toFixed(2)  : null,
      unrealized_pnl_eur: cfg.show_pnl   ? +unrealizedPnlEur.toFixed(2)        : null,
      // Historical: fresh from DB when available, cached as last resort
      realized_pnl_eur:   cfg.show_pnl ? (hasHistory ? +realizedPnlEur.toFixed(2)  : (cached.realized_pnl_eur  ?? null)) : null,
      dividends_eur:      cfg.show_pnl ? (hasHistory ? +dividendsEur.toFixed(2)    : (cached.dividends_eur     ?? null)) : null,
      fees_eur:           cfg.show_pnl ? (hasHistory ? +feesEur.toFixed(2)         : (cached.fees_eur          ?? null)) : null,
      total_buy_cost_eur: cfg.show_values ? (hasHistory ? +totalBuyCostEur.toFixed(2) : (cached.total_buy_cost_eur ?? null)) : null,
      // Total gain: fresh unrealized (current prices) + fresh historical components
      total_gain_eur: cfg.show_pnl ? (() => {
        if (hasHistory) return +totalGainEur.toFixed(2);
        // No DB transactions: reconstruct from cached components + fresh unrealized
        const r = cached.realized_pnl_eur ?? 0;
        const d = cached.dividends_eur    ?? 0;
        const f = cached.fees_eur         ?? 0;
        return (r || d || f) ? +(unrealizedPnlEur + r + d - f).toFixed(2) : null;
      })() : null,
      // ROI metrics: fresh when DB has data; cached only when no transactions
      roi_simple:        cfg.show_pnl ? (hasHistory && roiSimple != null ? +roiSimple.toFixed(2)         : (cached.roi_simple        ?? null)) : null,
      roi_cartera:       cfg.show_pnl && roiCartera != null ? +roiCartera.toFixed(2)                                                           : null,
      annualized_return: cfg.show_pnl ? (hasHistory && annualizedReturn != null ? +annualizedReturn.toFixed(2) : (cached.annualized_return ?? null)) : null,
      twr:               cfg.show_pnl ? (cached.twr ?? null) : null,
      first_trade_date:  firstTradeDate || cached.first_trade_date || null,
      has_history:       hasHistory || cached.has_history || !!(cached.realized_pnl_eur != null || cached.total_buy_cost_eur != null),
    };

    // ── Ventas realizadas (P&L) ────────────────────────────────────────────
    // Sale del MISMO FIFO que produce `realized` (portfolioHistory.realizedSales),
    // así que la lista y el total de la cabecera no pueden contar cosas
    // distintas. Se toma de `fullHistory` y no de `history`: éste puede venir
    // del caché de métricas, que solo guarda agregados.
    // Doble puerta: `show_realized_sales` (opt-in, apagado por defecto) Y
    // `show_pnl`, porque esto ES resultado — sin la segunda, apagar "Ganancia /
    // Pérdida" dejaría el P&L de cada venta a la vista.
    // Los importes viajan en EUR, como el resto del payload.
    const REALIZED_SALES_LIMIT = 100;
    const allSales = (cfg.show_realized_sales && cfg.show_pnl)
      ? (fullHistory.realizedSales || [])
      : [];
    // Más recientes primero: es lo que se mira, y el recorte cae en las viejas.
    const sortedSales = [...allSales].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    // Un nombre que NO añade nada (vacío, el propio ticker, o un ISIN suelto
    // porque el import creó la fila por ISIN) se manda vacío en vez de repetir
    // ruido debajo del ticker: la tabla decide no pintar el subtítulo.
    const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}\d(\s*\([A-Z]{3}\))?$/i;
    const displayName = (raw, storedTicker, shownTicker) => {
      const n = (raw || '').trim();
      if (!n || n === storedTicker || n === shownTicker || ISIN_RE.test(n)) return '';
      return n;
    };

    const realizedSales = sortedSales.slice(0, REALIZED_SALES_LIMIT).map(s => ({
      date:     s.date,
      ticker:   resolveTicker(s.ticker),
      name:     displayName(s.name, s.ticker, resolveTicker(s.ticker)),
      currency: s.currency,
      // Cantidad y precios son importes: siguen a `show_values`, igual que la
      // tabla de posiciones. El % y el resultado siguen a `show_pnl`.
      quantity:     cfg.show_values ? s.quantity : null,
      price:        cfg.show_values ? s.price : null,
      avg_buy_price: cfg.show_values ? s.avgBuyPrice : null,
      profit_eur:   +(s.profitPref ?? 0).toFixed(2),
      profit_pct:   s.profitPercent == null ? null : +s.profitPercent.toFixed(2),
      partial_cost: !!s.isMissingBuyData, // sin histórico de compra: el % no es fiable
    }));

    const currencies   = [...new Set(invested.map(p => p.assets?.currency).filter(Boolean))];
    const isMixed      = currencies.length > 1;

    return res.json({
      label:      share.label,
      mode:       'live',
      config:     cfg,
      expires_at: share.expires_at,
      positions,
      realized_sales:       realizedSales,
      realized_sales_total: allSales.length, // para avisar si la lista va recortada
      performance_data: sharedPerformance,
      // total_value / currency kept for backwards-compat with older page code;
      // new code uses metrics.market_value_eur + rates instead.
      total_value:       cfg.show_values
        ? (displayStats ? toEurD(displayStats.investedValue) : +totalEurValue.toFixed(2))
        : null,
      currency:          'EUR',
      is_mixed_currency: isMixed,
      rates,
      metrics,
      updated_at:        new Date().toISOString(),
    });
  } catch (e) {
    console.error('[sharePortfolio] Live fetch error:', e.message);
    return res.status(500).json({ error: 'Failed to fetch portfolio data' });
  }
}
