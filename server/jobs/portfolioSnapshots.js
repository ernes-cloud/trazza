/**
 * Daily portfolio value snapshots (server-side).
 *
 * Once an hour, values every user's open positions with live Yahoo quotes
 * (fallback: the DB's last-known assets.current_price) and upserts one row per
 * user into portfolio_snapshots for TODAY (Europe/Madrid). The day's final row
 * is therefore the last run before midnight (~23:xx — after US close), while
 * intermediate runs make the job restart-proof without any timezone scheduling.
 *
 * Efficiency: ONE quote batch per run shared across all users (an asset held
 * by N users is quoted once), one Frankfurter call for all EUR rates.
 *
 * Writes go through the service role (RLS allows SELECT-own only).
 */

import { supabaseAdmin } from '../lib/adminSupabase.js';
import { resolveTicker, getYahooQuotes } from '../lib/marketQuotes.js';
import { addLog } from '../lib/logBuffer.js';
import { planAssetPriceWrites, writeAssetPrices } from '../lib/assetPrices.js';
import { fetchAllRows } from '../lib/fetchAllRows.js';
import { isCashPosition } from '../../src/lib/positionKind.js';

const SCOPE = 'general'; // v1: general scope only (per-broker later if needed)
const QUOTE_BATCH_SIZE = 50;
const UPSERT_BATCH_SIZE = 100;
const BREAKDOWN_TOP_N = 50;
const POSITIONS_PAGE_SIZE = 1000;
const RUN_EVERY_MS = 60 * 60 * 1000; // hourly; upsert makes the last run of the day win
const STARTUP_DELAY_MS = 30 * 1000;  // let the server settle before the first run

// Europe/Madrid calendar date (YYYY-MM-DD) — en-CA locale formats as ISO
export const madridToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

const isCashRow = (p) => isCashPosition(p);

// A ticker with whitespace is an unresolved fund NAME — unquotable by design
// (same rule as usePositions/fetchPricesForImported).
const isQuotable = (ticker) => !!ticker && !/\s/.test(ticker);
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

/**
 * Símbolo de Yahoo para un `assets.ticker`, o null si no se le puede pedir.
 *
 * El filtro se aplica al ticker YA RESUELTO. Hasta el 2026-10-02 se aplicaba a
 * la clave en bruto, y las de DeGiro ("US30303M1027 (USD)") llevan espacio: se
 * descartaban antes de traducirse a META, así que todas esas posiciones se
 * valoraban con el precio guardado en la BD.
 * Un ISIN que no se pudo traducir tampoco se pide: Yahoo no cotiza ISINs.
 */
export function yahooSymbolFor(ticker) {
  const resolved = ticker ? resolveTicker(ticker) : '';
  return isQuotable(resolved) && !ISIN_RE.test(resolved) ? resolved : null;
}
// ¿Debería tener precio vivo? (para contar el miss). Un fondo monetario con
// espacios en el nombre no; un ISIN sin traducir sí — se esperaba y falta.
const expectsQuote = (ticker) => isQuotable(ticker ? resolveTicker(ticker) : '');

/**
 * Pure per-user aggregation — exported for tests.
 *
 * @param {Array} positions rows { quantity, entry_price, assets: { ticker, currency, current_price, asset_class } }
 * @param {Map}   quotes    resolvedTicker → { current, currency } (pence already normalized)
 * @param {object} ratesToEur currency → EUR value of 1 unit (EUR: 1)
 * @returns {{ totalValueEur, positionsValueEur, cashEur, breakdown, quoteMisses }}
 */
export function computeSnapshotForUser(positions, quotes, ratesToEur) {
  let positionsValueEur = 0;
  let cashEur = 0;
  let quoteMisses = 0;
  const byTicker = new Map();

  for (const p of positions || []) {
    const qty = parseFloat(p.quantity || 0);
    if (!(qty > 0)) continue;

    if (isCashRow(p)) {
      const rate = ratesToEur[p.assets?.currency || 'EUR'] ?? 1;
      cashEur += qty * rate;
      continue;
    }

    const ticker = p.assets?.ticker || '';
    const symbol = yahooSymbolFor(ticker);
    const quote = symbol ? quotes.get(symbol) : null;
    let price;
    let currency;
    if (quote?.current > 0) {
      price = quote.current;
      currency = quote.currency || p.assets?.currency || 'EUR';
    } else {
      // Last-known DB price (written by this same cron, lib/assetPrices.js). Unquotable
      // monetary fund rows land here by design and are not counted as misses.
      price = parseFloat(p.assets?.current_price ?? p.entry_price ?? 0);
      currency = p.assets?.currency || 'EUR';
      if (expectsQuote(ticker)) quoteMisses += 1;
    }

    const rate = ratesToEur[currency] ?? 1;
    const valueEur = qty * price * rate;
    positionsValueEur += valueEur;
    byTicker.set(ticker, (byTicker.get(ticker) || 0) + valueEur);
  }

  const breakdown = [...byTicker.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, BREAKDOWN_TOP_N)
    .map(([t, v]) => ({ t, v: Math.round(v * 100) / 100 }));

  return {
    totalValueEur: positionsValueEur + cashEur,
    positionsValueEur,
    cashEur,
    breakdown,
    quoteMisses,
  };
}

// ── EUR rates (Frankfurter/ECB — same source as the client's FX proxy) ───────

async function getEurRates(currencies) {
  const rates = { EUR: 1 };
  const needed = [...new Set(currencies)].filter(c => c && c !== 'EUR');
  if (!needed.length) return rates;
  try {
    const r = await fetch('https://api.frankfurter.app/latest?from=EUR', {
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`Frankfurter HTTP ${r.status}`);
    const json = await r.json();
    for (const c of needed) {
      // json.rates.USD = USD per 1 EUR → EUR value of 1 USD is the inverse
      if (json.rates?.[c] > 0) rates[c] = 1 / json.rates[c];
    }
  } catch (e) {
    console.warn('[portfolioSnapshots] FX rates unavailable:', e.message);
  }
  return rates;
}

// ── Run ──────────────────────────────────────────────────────────────────────

export async function runPortfolioSnapshots() {
  if (!supabaseAdmin) return { skipped: true, reason: 'supabase not configured' };
  const startedAt = Date.now();
  const snapshotDate = madridToday();

  // PostgREST corta en 1000 filas sin error: con más posiciones abiertas en
  // toda la plataforma los usuarios del final dejarían de recibir snapshot.
  const { data: positions, error } = await fetchAllRows(
    () => supabaseAdmin
      .from('positions')
      .select('id, quantity, entry_price, assets(id, ticker, currency, current_price, asset_class), brokers!inner(user_id)')
      .gt('quantity', 0)
      .order('id'),
    POSITIONS_PAGE_SIZE,
  );
  if (error) {
    console.error('[portfolioSnapshots] Failed to load positions:', error.message);
    return { error: error.message };
  }

  // Group by user + collect distinct quotable tickers and currencies
  const byUser = new Map();
  const tickers = new Set();
  const currencies = new Set(['EUR']);
  for (const p of positions || []) {
    const userId = p.brokers?.user_id;
    if (!userId) continue;
    if (!byUser.has(userId)) byUser.set(userId, []);
    byUser.get(userId).push(p);
    if (p.assets?.currency) currencies.add(p.assets.currency);
    const t = p.assets?.ticker;
    const symbol = isCashRow(p) ? null : yahooSymbolFor(t);
    if (symbol) tickers.add(symbol);
  }
  if (byUser.size === 0) return { users: 0, tickers: 0 };

  // ONE shared quote pass (sequential batches — Yahoo dislikes parallel bursts)
  const quotes = new Map();
  const tickerList = [...tickers];
  for (let i = 0; i < tickerList.length; i += QUOTE_BATCH_SIZE) {
    const batch = await getYahooQuotes(tickerList.slice(i, i + QUOTE_BATCH_SIZE));
    for (const [k, v] of batch) quotes.set(k, v);
  }
  for (const q of quotes.values()) if (q.currency) currencies.add(q.currency);

  const ratesToEur = await getEurRates([...currencies]);

  // Precio de la tabla compartida `assets`: el cron es su ÚNICO escritor
  // (lib/assetPrices.js). Se valora con las cotizaciones de esta pasada, así
  // que escribir antes o después del upsert no cambia el snapshot.
  const { writes, implausible } = planAssetPriceWrites(positions, quotes, ratesToEur, yahooSymbolFor);
  for (const w of implausible) {
    console.warn(`[portfolioSnapshots] Implausible price for ${w.ticker}: ${w.stored} → ${w.price} — write skipped`);
  }
  const assetPrices = await writeAssetPrices(supabaseAdmin, writes);

  // Compute + upsert
  const rows = [];
  let totalMisses = 0;
  for (const [userId, userPositions] of byUser) {
    const snap = computeSnapshotForUser(userPositions, quotes, ratesToEur);
    totalMisses += snap.quoteMisses;
    rows.push({
      user_id: userId,
      scope: SCOPE,
      snapshot_date: snapshotDate,
      total_value_eur: Math.round(snap.totalValueEur * 100) / 100,
      positions_value_eur: Math.round(snap.positionsValueEur * 100) / 100,
      cash_eur: Math.round(snap.cashEur * 100) / 100,
      breakdown: snap.breakdown,
      quote_misses: snap.quoteMisses,
      computed_at: new Date().toISOString(),
    });
  }

  let upserted = 0;
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const { error: upsertError } = await supabaseAdmin
      .from('portfolio_snapshots')
      .upsert(batch, { onConflict: 'user_id, scope, snapshot_date' });
    if (upsertError) {
      console.error('[portfolioSnapshots] Upsert failed:', upsertError.message);
      return { error: upsertError.message, upserted };
    }
    upserted += batch.length;
  }

  const summary = {
    date: snapshotDate,
    users: byUser.size,
    upserted,
    tickers: tickerList.length,
    quotesResolved: quotes.size,
    quoteMisses: totalMisses,
    assetPricesWritten: assetPrices.written,
    assetPricesRejected: assetPrices.rejected + implausible.length,
    assetPricesFailed: assetPrices.failed,
    ms: Date.now() - startedAt,
  };
  console.log('[portfolioSnapshots]', JSON.stringify(summary));
  addLog('info', 'snapshots', `Snapshots ${snapshotDate}: ${upserted} users, ${quotes.size}/${tickerList.length} quotes`);
  return summary;
}

// ── Scheduler ────────────────────────────────────────────────────────────────

export function startPortfolioSnapshotsCron() {
  if (!supabaseAdmin) {
    console.warn('[portfolioSnapshots] Supabase admin client not configured — cron disabled.');
    return;
  }
  const run = () => runPortfolioSnapshots()
    .catch(e => console.error('[portfolioSnapshots] run error:', e.message));
  setTimeout(run, STARTUP_DELAY_MS);
  setInterval(run, RUN_EVERY_MS);
  console.log('[portfolioSnapshots] Cron scheduled (hourly, last run of the day wins).');
}
