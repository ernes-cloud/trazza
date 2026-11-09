/**
 * Reconstruye fotos de `portfolio_snapshots` de días pasados con CIERRES
 * oficiales de Yahoo y el tipo de cambio del BCE de cada día.
 *
 * Nació para rehacer las fotos del 25-sep al 1-oct-2026, que el cron había
 * valorado con precios guardados (ver CLAUDE.md, "Las fotos de
 * portfolio_snapshots anteriores al 2026-10-02 NO valen precio de mercado").
 *
 * Cantidades de cada día: las de hoy deshaciendo las compras y ventas
 * posteriores a ese día (`transactions` BUY/SELL), así que también es exacto
 * para quien operó. Aproximación consciente: la LIQUIDEZ se toma con el valor
 * de hoy (no hay un saldo de caja histórico fiable por día).
 *
 * Uso (en /srv/trazza-server):
 *   node scripts/backfillSnapshots.mjs 2026-09-25 2026-10-01 [--write] [--user=<uuid>]
 * Sin --write solo imprime lo que escribiría.
 */

import '../loadEnv.js';
import { supabaseAdmin } from '../lib/adminSupabase.js';
import { isPenceCurrency } from '../lib/marketQuotes.js';
import { computeSnapshotForUser, yahooSymbolFor } from '../jobs/portfolioSnapshots.js';

const [from, to] = process.argv.slice(2).filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const WRITE = process.argv.includes('--write');
const ONLY_USER = process.argv.find((a) => a.startsWith('--user='))?.slice(7) || null;
if (!from || !to || from > to) {
  console.error('Uso: node scripts/backfillSnapshots.mjs AAAA-MM-DD AAAA-MM-DD [--write] [--user=<uuid>]');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const days = [];
for (let d = new Date(`${from}T12:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
  days.push(d.toISOString().slice(0, 10));
}

// ── Datos de la BD ───────────────────────────────────────────────────────────
// Todas las posiciones, también las que hoy están a 0: pudieron tenerse en el pasado.
const { data: positions, error: posErr } = await supabaseAdmin
  .from('positions')
  .select('id, quantity, entry_price, assets(ticker, currency, current_price, asset_class), brokers!inner(user_id)');
if (posErr) throw new Error(posErr.message);

const ids = positions.map((p) => p.id);
const txs = [];
for (let i = 0; i < ids.length; i += 200) {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('position_id, transaction_type, quantity, transaction_date')
    .in('position_id', ids.slice(i, i + 200))
    .in('transaction_type', ['BUY', 'SELL'])
    .gt('transaction_date', `${from}T00:00:00Z`);
  if (error) throw new Error(error.message);
  txs.push(...data);
}

/** Cantidad de una posición al CIERRE del día `day`: la de hoy menos lo que se movió después. */
function quantityAt(p, day) {
  let q = Number(p.quantity) || 0;
  for (const t of txs) {
    if (t.position_id !== p.id || String(t.transaction_date).slice(0, 10) <= day) continue;
    const n = Math.abs(Number(t.quantity) || 0);
    q += t.transaction_type === 'BUY' ? -n : n;
  }
  return Math.max(0, q);
}

// ── Cierres de Yahoo ─────────────────────────────────────────────────────────
const symbols = [...new Set(positions.map((p) => yahooSymbolFor(p.assets?.ticker)).filter(Boolean))];
const p1 = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000) - 10 * 86400;
const p2 = Math.floor(Date.parse(`${to}T23:59:59Z`) / 1000) + 86400;
const closes = new Map();   // símbolo → { currency, byDay: Map<YYYY-MM-DD, close> }

for (const sym of symbols) {
  let json = null;
  for (let attempt = 0; attempt < 4 && !json; attempt++) {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${p2}&interval=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } },
    );
    if (r.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    if (r.ok) json = await r.json();
    break;
  }
  await sleep(400);
  const res = json?.chart?.result?.[0];
  if (!res?.timestamp) { console.warn(`sin histórico: ${sym}`); continue; }
  const off = res.meta?.gmtoffset || 0;   // fecha LOCAL de la barra (ver barDateFromTimestamp)
  const pence = isPenceCurrency(res.meta?.currency);
  const byDay = new Map();
  res.timestamp.forEach((ts, i) => {
    const c = res.indicators?.quote?.[0]?.close?.[i];
    if (c > 0) byDay.set(new Date((ts + off) * 1000).toISOString().slice(0, 10), pence ? c / 100 : c);
  });
  closes.set(sym, { currency: pence ? 'GBP' : (res.meta?.currency || null), byDay });
}

/** Último cierre en o antes de `day` (fin de semana → viernes). */
function closeAt(sym, day) {
  const c = closes.get(sym);
  if (!c) return null;
  let best = null;
  for (const [d, v] of c.byDay) if (d <= day && (!best || d > best[0])) best = [d, v];
  return best ? { current: best[1], currency: c.currency } : null;
}

// ── Tipos del BCE por día (Frankfurter; un fin de semana devuelve el viernes) ──
const currencies = new Set(['EUR']);
for (const p of positions) if (p.assets?.currency) currencies.add(p.assets.currency);
for (const c of closes.values()) if (c.currency) currencies.add(c.currency);

async function ratesAt(day) {
  const r = await fetch(`https://api.frankfurter.app/${day}?from=EUR`);
  if (!r.ok) throw new Error(`Frankfurter ${day}: HTTP ${r.status}`);
  const json = await r.json();
  const rates = { EUR: 1 };
  for (const c of currencies) if (c !== 'EUR' && json.rates?.[c] > 0) rates[c] = 1 / json.rates[c];
  return rates;
}

// ── Cálculo ──────────────────────────────────────────────────────────────────
const byUser = new Map();
for (const p of positions) {
  const u = p.brokers?.user_id;
  if (!u || (ONLY_USER && u !== ONLY_USER)) continue;
  if (!byUser.has(u)) byUser.set(u, []);
  byUser.get(u).push(p);
}

const rows = [];
for (const day of days) {
  const rates = await ratesAt(day);
  const quotes = new Map(symbols.map((s) => [s, closeAt(s, day)]).filter(([, q]) => q));
  for (const [userId, list] of byUser) {
    const atDay = list.map((p) => ({ ...p, quantity: quantityAt(p, day) })).filter((p) => p.quantity > 0);
    if (!atDay.length) continue;
    const snap = computeSnapshotForUser(atDay, quotes, rates);
    rows.push({
      user_id: userId,
      scope: 'general',
      snapshot_date: day,
      total_value_eur: Math.round(snap.totalValueEur * 100) / 100,
      positions_value_eur: Math.round(snap.positionsValueEur * 100) / 100,
      cash_eur: Math.round(snap.cashEur * 100) / 100,
      breakdown: snap.breakdown,
      quote_misses: snap.quoteMisses,
      computed_at: new Date().toISOString(),
    });
  }
}

for (const r of rows.filter((r) => !ONLY_USER || r.user_id === ONLY_USER).slice(0, ONLY_USER ? 50 : 20)) {
  console.log(r.snapshot_date, r.user_id.slice(0, 8), r.total_value_eur, `misses=${r.quote_misses}`);
}
console.log(`${rows.length} filas · ${symbols.length} símbolos · ${closes.size} con histórico · ${WRITE ? 'ESCRIBIENDO' : 'modo prueba (sin --write)'}`);

if (WRITE) {
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabaseAdmin
      .from('portfolio_snapshots')
      .upsert(rows.slice(i, i + 200), { onConflict: 'user_id, scope, snapshot_date' });
    if (error) throw new Error(error.message);
  }
  console.log('escrito');
}
process.exit(0);
