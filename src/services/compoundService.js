// Motor de la calculadora de interés compuesto.
//
// Módulo puro: sin React ni Supabase — recibe los parámetros y devuelve la
// proyección completa (gráfico, tabla, KPIs, hitos y objetivo). Toda la
// matemática de la calculadora vive aquí para poder testearla.

const FREQ_PERIODS = { monthly: 12, quarterly: 4, annual: 1 };

export const MILESTONE_TARGETS = [10000, 25000, 50000, 100000, 250000, 500000, 1000000];

const GOAL_SEARCH_MAX_YEARS = 100;

/**
 * Simula el crecimiento año a año.
 *
 * - La aportación `monthly` es SIEMPRE mensual de cara al usuario; con
 *   frecuencia trimestral/anual se agrupa (×3 / ×12) y se aporta al final de
 *   cada periodo de capitalización, después del interés del periodo.
 * - `stepUpPct` incrementa la aportación un % cada año (a partir del año 2).
 * - `inflationPct` NO cambia la rentabilidad nominal: añade la serie/valores
 *   "en dinero de hoy" deflactando por (1+i)^año. Es la forma correcta de
 *   mostrar poder adquisitivo (el atajo de restar la inflación al tipo
 *   infravalora el resultado).
 */
export function buildProjection({
  initial = 0,
  monthly = 0,
  annualRate = 0,
  years = 1,
  freq = 'monthly',
  stepUpPct = 0,
  inflationPct = null, // null → sin serie real
} = {}) {
  const n = FREQ_PERIODS[freq] || 12;
  const r = (parseFloat(annualRate) || 0) / 100;
  const stepUp = 1 + (parseFloat(stepUpPct) || 0) / 100;
  const inf = inflationPct == null ? null : (parseFloat(inflationPct) || 0) / 100;
  const horizon = Math.max(1, Math.round(years));

  let balance = parseFloat(initial) || 0;
  let periodicContribution = (parseFloat(monthly) || 0) * (12 / n);
  let totalContrib = balance;
  let totalInt = 0;

  const table = [];
  const chart = [{ year: 0, contributions: totalContrib, interest: 0, total: balance, totalReal: balance }];
  const milestones = [];
  const hit = new Set();

  for (let y = 1; y <= horizon; y++) {
    if (y > 1) periodicContribution *= stepUp;
    let yearInterest = 0;
    for (let p = 0; p < n; p++) {
      const periodInterest = balance * (r / n);
      yearInterest += periodInterest;
      balance += periodInterest + periodicContribution;
    }
    const yearContrib = periodicContribution * n;
    totalContrib += yearContrib;
    totalInt += yearInterest;

    const deflator = inf == null ? 1 : Math.pow(1 + inf, y);
    const totalReal = balance / deflator;

    table.push({
      year: y,
      contribution: yearContrib,
      totalContrib,
      interest: yearInterest,
      totalInterest: totalInt,
      balance,
      balanceReal: totalReal,
    });
    chart.push({ year: y, contributions: totalContrib, interest: totalInt, total: balance, totalReal });

    for (const m of MILESTONE_TARGETS) {
      if (balance >= m && !hit.has(m)) {
        hit.add(m);
        milestones.push({ year: y, value: m });
      }
    }
  }

  const finalDeflator = inf == null ? 1 : Math.pow(1 + inf, horizon);
  return {
    table,
    chart,
    finalValue: balance,
    finalValueReal: balance / finalDeflator,
    totalContributed: totalContrib,
    totalInterest: totalInt,
    milestones,
  };
}

/** Valor final para unos parámetros (atajo interno para el goal seek). */
const finalValueFor = (params) => buildProjection(params).finalValue;

/**
 * Primer año (contando desde hoy) en el que el plan actual alcanza `goal`,
 * simulando más allá del horizonte si hace falta. null si no se alcanza en
 * GOAL_SEARCH_MAX_YEARS años.
 */
export function yearGoalReached(params, goal) {
  const target = parseFloat(goal) || 0;
  if (target <= 0) return null;
  if ((parseFloat(params.initial) || 0) >= target) return 0;
  const { table } = buildProjection({ ...params, years: GOAL_SEARCH_MAX_YEARS });
  const row = table.find(rw => rw.balance >= target);
  return row ? row.year : null;
}

/**
 * Aportación mensual (base, antes de step-up) necesaria para alcanzar `goal`
 * exactamente en el horizonte `params.years`. Búsqueda binaria — robusta con
 * cualquier combinación de step-up/frecuencia. null si ni una aportación
 * enorme (1M/mes) llega (horizonte demasiado corto).
 */
export function requiredMonthlyFor(params, goal) {
  const target = parseFloat(goal) || 0;
  if (target <= 0) return null;
  if (finalValueFor({ ...params, monthly: 0 }) >= target) return 0;

  let lo = 0;
  let hi = 1_000_000;
  if (finalValueFor({ ...params, monthly: hi }) < target) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (finalValueFor({ ...params, monthly: mid }) >= target) hi = mid;
    else lo = mid;
  }
  return hi;
}
