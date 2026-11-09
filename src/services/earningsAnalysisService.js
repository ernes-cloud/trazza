/**
 * Datos de detalle de una presentación de resultados + la acción "Analizar".
 *
 *  1. fetchEarningsDetail(ticker) — UNA sola llamada a quoteSummary que alimenta
 *     tanto el historial trimestral del widget como el contexto del análisis IA.
 *     Va por `/api/yahoo-profile` (crumb proxy), NO por `/api/yahoo`: Yahoo exige
 *     cookie+crumb en v10/quoteSummary y el proxy plano devuelve
 *     `{"error":{"code":"Unauthorized","description":"Invalid Crumb"}}` — que es
 *     por lo que el widget mostraba "Sin datos históricos" para TODOS los tickers.
 *     El parseo es puro (`parseEarningsDetail`) y está testeado.
 *  2. requestEarningsAnalysis(payload) — POST /api/analyze-earnings con el JWT de
 *     Supabase, mapeando los códigos HTTP a una unión de estados pequeña para que
 *     el componente no toque fetch ni status codes.
 */

import { supabase } from '@/lib/customSupabaseClient';
import { isPenceCurrency } from '@/services/yahooFinance';

const DETAIL_TTL = 30 * 60 * 1000; // 30 min — Yahoo rate-limita quoteSummary con facilidad
const detailCache = new Map(); // ticker → { ts, data }

const MODULES = 'earningsHistory,earningsTrend,earnings,price';

const rawNum = (node) => {
  const n = node?.raw;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

// Yahoo no es coherente con las fechas: `earningsHistory.quarter` llega como
// { raw, fmt } pero `earningsTrend.endDate` como texto plano ("2026-09-30").
// Leer solo `.fmt` dejaba la fila del próximo trimestre rotulada "0q".
const dateOf = (node) => {
  if (typeof node === 'string') return node || null;
  return typeof node?.fmt === 'string' ? node.fmt : null;
};

/**
 * quoteSummary reports percentages as a FRACTION (raw: 0.0342 / fmt: "3.42%")
 * in BOTH the `price` module (change %) and `earningsHistory` (surprisePercent)
 * — unlike the v7 quote endpoint, which already returns percent points. Trust
 * `fmt` when Yahoo sends it and only scale `raw` as a fallback, so a format
 * change can't turn +3% into +342% (or, read raw, +215% into +2.1%).
 */
export function extractChangePct(node) {
  const fmt = node?.fmt;
  if (typeof fmt === 'string') {
    const parsed = parseFloat(fmt.replace('%', '').replace(',', '.'));
    if (Number.isFinite(parsed)) return parsed;
  }
  const raw = rawNum(node);
  return raw === null ? null : raw * 100;
}

export const EMPTY_DETAIL = { history: [], revenue: [], priceReaction: {} };

/**
 * Trimestre NATURAL en que acaba un periodo ('2026-06-30' → { quarter: 2, year: 2026 }).
 * Es el del cierre del periodo, no el fiscal de la empresa: para la mayoría coinciden,
 * y la fecha de cierre sigue a la vista por si no. null si la fecha no es ISO.
 */
export function calendarQuarterOf(iso) {
  const m = typeof iso === 'string' ? iso.match(/^(\d{4})-(\d{2})-\d{2}/) : null;
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { quarter: Math.ceil(month / 3), year: Number(m[1]) };
}

// Sorpresa en puntos porcentuales calculada a partir de los dos BPA, para cuando
// Yahoo no la manda. Con estimación 0 no hay porcentaje que dar.
const surpriseFrom = (actual, estimate) =>
  actual !== null && estimate !== null && estimate !== 0
    ? ((actual - estimate) / Math.abs(estimate)) * 100
    : null;

/**
 * Reduce la respuesta de quoteSummary a { history, revenue, priceReaction }.
 * PURA — sin red — para poder fijarla con tests.
 */
export function parseEarningsDetail(json) {
  const result = json?.quoteSummary?.result?.[0];
  if (!result) return EMPTY_DETAIL;

  // Fecha en que se PUBLICÓ cada trimestre, indexada por su cierre de periodo.
  const reportedByPeriod = new Map(
    (result.earnings?.earningsChart?.quarterly || [])
      .map(q => [dateOf(q?.periodEndDate), dateOf(q?.reportedDate)])
      .filter(([period, reported]) => period && reported)
  );

  // earningsHistory: trimestres ya publicados (Yahoo los da del más antiguo al más reciente)
  const histQuarters = (result.earningsHistory?.history || []).map(q => {
    const date = dateOf(q?.quarter);
    const epsActual = rawNum(q?.epsActual);
    const epsEstimate = rawNum(q?.epsEstimate);
    return {
      date,
      reportedDate: (date && reportedByPeriod.get(date)) || null,
      epsActual,
      epsEstimate,
      surprisePct: extractChangePct(q?.surprisePercent) ?? surpriseFrom(epsActual, epsEstimate),
    };
  }).reverse(); // más reciente primero

  // earningsTrend: estimación del trimestre en curso
  const trendQuarters = (result.earningsTrend?.trend || [])
    .filter(tr => tr?.period && tr.period.startsWith('0q'))
    .slice(0, 1)
    .map(tr => ({
      date: dateOf(tr.endDate),
      epsActual: null,
      epsEstimate: rawNum(tr.earningsEstimate?.avg),
      analysts: rawNum(tr.earningsEstimate?.numberOfAnalysts),
      surprisePct: null,
      upcoming: true,
    }));

  const revenue = (result.earnings?.financialsChart?.quarterly || []).map(q => ({
    quarter: typeof q?.date === 'string' ? q.date : String(q?.date ?? ''),
    revenue: rawNum(q?.revenue),
    earnings: rawNum(q?.earnings),
  }));

  const price = result.price || {};
  const isGBX = isPenceCurrency(price.currency);
  const quotePrice = rawNum(price.regularMarketPrice);

  return {
    history: [...trendQuarters, ...histQuarters],
    revenue,
    priceReaction: {
      changePct: extractChangePct(price.regularMarketChangePercent),
      // Tickers en peniques: a libras, para que el prompt nunca vea 11120 GBp
      price: quotePrice === null ? null : (isGBX ? quotePrice / 100 : quotePrice),
      currency: isGBX ? 'GBP' : (typeof price.currency === 'string' ? price.currency : null),
    },
  };
}

// Una empresa publica sus resultados como mucho ~3 meses después del cierre.
const MAX_REPORT_LAG_DAYS = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Una sola estimación por trimestre en la tarjeta. La cabecera ("EPS est.") sale
 * del calendario (Nasdaq → EODHD → Yahoo, ver earningsService) y la fila
 * "Próximo" del historial de `earningsTrend` de Yahoo: dos paneles de analistas
 * distintos para el MISMO trimestre (META oct-2026: $6,39 arriba, $5,94 abajo).
 * Manda la cabecera, que se ve sin desplegar y es la que llega al prompt de la
 * IA como `event.epsForecast`; el nº de analistas era del otro proveedor y se quita.
 * Solo actúa si el evento es la presentación de ese trimestre: aún sin publicar
 * y con fecha dentro de los ~100 días siguientes al cierre del periodo.
 * PURA: devuelve el mismo `detail` si no hay nada que alinear.
 */
export function withEventEstimate(detail, event) {
  if (!event || event.epsActual !== null || event.epsForecast === null || event.epsForecast === undefined) return detail;
  const idx = (detail?.history || []).findIndex(q => q.upcoming);
  if (idx === -1) return detail;
  const row = detail.history[idx];
  const lagDays = (Date.parse(event.date) - Date.parse(row.date)) / DAY_MS;
  if (!Number.isFinite(lagDays) || lagDays < 0 || lagDays > MAX_REPORT_LAG_DAYS) return detail;
  const history = detail.history.map((q, i) => (i === idx ? { ...q, epsEstimate: event.epsForecast, analysts: null } : q));
  return { ...detail, history };
}

/**
 * Historial trimestral + ingresos + reacción de la cotización. Nunca lanza:
 * el widget debe seguir mostrando la fila aunque Yahoo falle o rate-limite.
 */
export async function fetchEarningsDetail(ticker) {
  if (!ticker) return EMPTY_DETAIL;

  const cached = detailCache.get(ticker);
  if (cached && Date.now() - cached.ts < DETAIL_TTL) return cached.data;

  try {
    const r = await fetch(
      `/api/yahoo-profile/${encodeURIComponent(ticker)}?modules=${MODULES}`,
      { signal: AbortSignal.timeout(15_000) }
    );
    if (!r.ok) return EMPTY_DETAIL; // 429 de Yahoo incluido — no cachear el fallo
    const data = parseEarningsDetail(await r.json());
    detailCache.set(ticker, { ts: Date.now(), data });
    return data;
  } catch {
    return EMPTY_DETAIL;
  }
}

/**
 * Calls the AI route.
 * Returns one of:
 *   { status: 'ok',    insight }
 *   { status: 'limit', reason: 'daily' | 'monthly' }
 *   { status: 'auth' }                                   (401 — demo or expired session)
 *   { status: 'error' }                                  (Groq fallback / network)
 */
export async function requestEarningsAnalysis(payload) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const resp = await fetch('/api/analyze-earnings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45_000),
    });

    if (resp.status === 429) {
      const errData = await resp.json().catch(() => ({}));
      return { status: 'limit', reason: errData.reason === 'monthly' ? 'monthly' : 'daily' };
    }
    if (resp.status === 401) return { status: 'auth' };
    if (!resp.ok) return { status: 'error' };

    const data = await resp.json();
    if (data.isFallback || !data.insight) return { status: 'error' };
    return { status: 'ok', insight: data.insight };
  } catch {
    return { status: 'error' };
  }
}
