/**
 * portfolioContextService — lo que el chat de cartera "sabe" de tu cartera.
 *
 * Convierte el snapshot que publica el Dashboard en un objeto compacto que se
 * manda a /api/portfolio-chat. Puro y testeado.
 *
 * Reescrito el 2026-10-02 por tres fallos que se veían en las respuestas:
 *  - El valor de cada posición ya iba convertido a la divisa preferida, pero el
 *    prompt le ponía delante la divisa de la POSICIÓN ("USD 9.701,30" siendo
 *    euros; "CAD 1.858,49" para una acción de 3.000 C$). Ahora cada cifra viaja
 *    con su divisa explícita en el nombre del campo.
 *  - Se mandaba una sola columna "price" (el precio ACTUAL) y el modelo la
 *    presentaba como precio de entrada. Ahora van `price` y `avgCost` por
 *    separado, cada uno con su divisa.
 *  - La misma acción comprada en dos mercados salía dos veces (Amazon USD y
 *    EUR). Se agrupa por ISIN, como la vista general de la app.
 * Y se amplía lo que el chat puede contar: reparto por broker, sector y país, y
 * rentabilidad (TWR total, anualizada, YTD, 1 mes, 1 semana) leída de la serie
 * que ya calculó el Dashboard.
 */
import { isCashPosition } from '../lib/positionKind.js';
import { resolveTicker } from '../lib/tickerMap.js';
import { firstInvestedDate, annualizeReturn } from './performanceService.js';

const MAX_POSITIONS = 25;
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}\d/;
const round = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);

const isinOf = (p) => {
  const fromAsset = p.assets?.isin;
  if (fromAsset && ISIN_RE.test(fromAsset)) return fromAsset;
  const m = String(p.assets?.ticker || '').match(ISIN_RE);
  return m ? m[0] : null;
};

// "CONSTELLATION SOFTWARE INC" → "Constellation Software Inc"; los símbolos sueltos se dejan.
function prettyName(name) {
  const s = String(name || '').trim();
  if (!s.includes(' ') || s !== s.toUpperCase() || !/[A-Z]/.test(s)) return s;
  return s.toLowerCase().replace(/(^|[\s\-./(])(\p{L})/gu, (_, sep, c) => sep + c.toUpperCase());
}
function bestName(names, fallback) {
  const list = [...new Set(names.map((n) => String(n || '').trim()).filter(Boolean))];
  if (!list.length) return fallback;
  list.sort((a, b) => (b.includes(' ') - a.includes(' ')) || (b.length - a.length));
  return prettyName(list[0]);
}

/** Tramo de la serie TWR: ((1+T_fin)/(1+T_inicio) − 1) entre el último punto ≤ `fromIso` y el final. */
function periodReturn(series, fromIso) {
  if (!series.length) return null;
  const last = series[series.length - 1];
  const endT = last.ttwror ?? last.cumulativeReturn;
  let base = null;
  for (const p of series) {
    if ((p.date || p.name) <= fromIso) base = p; else break;
  }
  if (!base || endT == null) return null;
  const startT = base.ttwror ?? base.cumulativeReturn ?? 0;
  return round(((1 + endT / 100) / (1 + startT / 100) - 1) * 100);
}

/**
 * Rentabilidad para el chat a partir de la serie de `calculateDailyTWR`.
 * @param {Array} series
 * @param {Date} [now]
 */
export function summarizePerformance(series, now = new Date()) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const last = series[series.length - 1];
  const total = last.ttwror ?? last.cumulativeReturn;
  if (total == null) return null;
  const iso = (d) => d.toISOString().slice(0, 10);
  const daysAgo = (n) => iso(new Date(now.getTime() - n * 86400000));
  const since = firstInvestedDate(series);
  return {
    since,
    asOf: last.date || last.name,
    twrTotalPct: round(total),
    annualizedPct: round(annualizeReturn(total, since, last.date || last.name)),
    ytdPct: periodReturn(series, `${now.getFullYear() - 1}-12-31`),
    oneMonthPct: periodReturn(series, daysAgo(30)),
    oneWeekPct: periodReturn(series, daysAgo(7)),
  };
}

function breakdown(groups, keyFn, total) {
  const map = new Map();
  for (const g of groups) {
    const k = keyFn(g) || '—';
    map.set(k, (map.get(k) || 0) + g.valuePref);
  }
  return [...map.entries()]
    .map(([name, value]) => ({ name, valuePref: round(value), weightPct: round(total > 0 ? (value / total) * 100 : 0, 1) }))
    .sort((a, b) => b.valuePref - a.valuePref);
}

export function buildPortfolioContext({
  positions = [], brokers = [], summary = {}, rates = {}, currency = 'EUR', performanceSeries = null, now = new Date(),
}) {
  const rateOf = (cur) => (!cur || cur === currency ? 1 : (rates[cur] || 1));
  const brokerName = new Map(brokers.map((b) => [b.id, b.name]));

  // ── Agrupar por ISIN (o ticker) ─────────────────────────────────────────
  const groups = new Map();
  for (const p of positions) {
    if (isCashPosition(p)) continue;
    const qty = parseFloat(p.quantity || 0);
    if (!(qty > 0.0001)) continue;
    const a = p.assets || {};
    const cur = a.currency || currency;
    const price = parseFloat(a.current_price ?? p.entry_price ?? 0);
    const entry = parseFloat(p.entry_price || 0);
    const key = isinOf(p) || a.ticker || p.id;
    const g = groups.get(key) || {
      key, isin: isinOf(p), names: [], members: [], brokers: new Set(),
      qty: 0, valuePref: 0, costPref: 0, sector: null, country: null, assetClass: null,
    };
    g.names.push(a.company_name, a.name);
    g.members.push({ cur, price, entry, qty, valueNative: qty * price, ticker: a.ticker });
    if (p.broker_id && brokerName.has(p.broker_id)) g.brokers.add(brokerName.get(p.broker_id));
    g.qty += qty;
    g.valuePref += qty * price * rateOf(cur);
    g.costPref += qty * entry * rateOf(cur);
    g.sector = g.sector || a.sector || null;
    g.country = g.country || a.country || (g.isin ? g.isin.slice(0, 2) : null);
    g.assetClass = g.assetClass || p.custom_classification || a.asset_class || null;
    groups.set(key, g);
  }

  const list = [...groups.values()].filter((g) => g.valuePref > 0).sort((a, b) => b.valuePref - a.valuePref);
  const total = list.reduce((s, g) => s + g.valuePref, 0);

  const rows = list.map((g) => {
    // Precio y coste medio en la divisa del listado PRINCIPAL. Si el grupo mezcla
    // divisas (la misma acción comprada en dos mercados) el coste medio nativo no
    // tiene sentido: se omite y quedan los totales en la divisa preferida.
    const main = [...g.members].sort((a, b) => b.valueNative * rateOf(b.cur) - a.valueNative * rateOf(a.cur))[0];
    const oneCurrency = g.members.every((m) => m.cur === main.cur);
    const avgCost = oneCurrency && g.qty > 0 ? g.members.reduce((s, m) => s + m.entry * m.qty, 0) / g.qty : null;
    const gainPref = g.valuePref - g.costPref;
    return {
      name: bestName(g.names, main.ticker || g.key),
      symbol: resolveTicker(g.isin || main.ticker) || main.ticker,
      quantity: round(g.qty, 4),
      price: round(main.price, 4),
      priceCurrency: main.cur,
      avgCost: avgCost != null ? round(avgCost, 4) : null,
      avgCostCurrency: avgCost != null ? main.cur : null,
      valuePref: round(g.valuePref),
      costPref: round(g.costPref),
      gainPref: round(gainPref),
      gainPct: round(g.costPref > 0 ? (gainPref / g.costPref) * 100 : 0),
      weightPct: round(total > 0 ? (g.valuePref / total) * 100 : 0),
      brokers: [...g.brokers],
      assetClass: g.assetClass,
      sector: g.sector,
      country: g.country,
    };
  });

  const byGain = [...rows].sort((a, b) => b.gainPct - a.gainPct);

  return {
    date: now.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' }),
    currency,
    brokers: brokers.map((b) => ({ id: b.id, name: b.name })),
    totalWealth: summary.totalWealth ?? 0,
    investedValue: round(total),
    totalInvested: summary.totalInvested ?? round(rows.reduce((s, r) => s + r.costPref, 0)),
    cashPosition: summary.cashPosition ?? 0,
    totalGainAbs: summary.totalGainAbs ?? 0,
    totalGainPct: summary.totalGainPct ?? 0,
    dailyChangePct: summary.dailyChangePct ?? 0,
    totalDividends: summary.totalDividends ?? 0,
    totalFees: summary.totalFees ?? 0,
    realizedGain: summary.realizedGain ?? 0,
    positionCount: rows.length,
    positions: rows.slice(0, MAX_POSITIONS),
    byBroker: breakdown(list, (g) => (g.brokers.size === 1 ? [...g.brokers][0] : g.brokers.size ? 'Varios brokers' : null), total),
    bySector: breakdown(list, (g) => g.sector || g.assetClass, total).slice(0, 8),
    byCountry: breakdown(list, (g) => g.country, total).slice(0, 8),
    best3: byGain.slice(0, 3).map((r) => ({ name: r.name, gainPct: r.gainPct })),
    worst3: byGain.slice(-3).reverse().map((r) => ({ name: r.name, gainPct: r.gainPct })),
    performance: summarizePerformance(performanceSeries, now),
  };
}
