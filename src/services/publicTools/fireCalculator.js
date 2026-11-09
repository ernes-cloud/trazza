/**
 * Calculadora FIRE (página pública /calculadora-fire) — PURA.
 *
 * FIRE = independencia financiera: tener invertido lo suficiente para cubrir
 * tus gastos con lo que rinde la cartera. La cifra objetivo sale de la regla de
 * la tasa de retirada (el 4 % clásico → 25 veces los gastos anuales).
 *
 * Se trabaja en euros de HOY: la rentabilidad que pide la calculadora es REAL
 * (descontada la inflación), así que gastos y objetivo no hay que inflarlos.
 * La evolución se simula mes a mes con aportación al final de cada mes.
 */

export const MAX_YEARS = 100;

/**
 * @param {{ annualExpenses: number, currentSavings?: number, monthlyContribution?: number, realReturnPct?: number, withdrawalRatePct?: number }} input
 * @returns {{ target: number, reached: boolean, months: number|null, years: number|null, series: Array<{ year: number, value: number, contributed: number }> }}
 */
export function computeFire({ annualExpenses, currentSavings = 0, monthlyContribution = 0, realReturnPct = 5, withdrawalRatePct = 4 }) {
  const expenses = Math.max(0, Number(annualExpenses) || 0);
  const wr = Math.max(0, Number(withdrawalRatePct) || 0) / 100;
  const target = wr > 0 ? expenses / wr : Infinity;
  const r = Math.pow(1 + (Number(realReturnPct) || 0) / 100, 1 / 12) - 1; // mensual equivalente
  const contrib = Math.max(0, Number(monthlyContribution) || 0);

  let value = Math.max(0, Number(currentSavings) || 0);
  let contributed = value;
  const series = [{ year: 0, value: round(value), contributed: round(contributed) }];
  let months = value >= target ? 0 : null;

  for (let m = 1; m <= MAX_YEARS * 12; m++) {
    value = value * (1 + r) + contrib;
    contributed += contrib;
    if (months === null && value >= target) months = m;
    if (m % 12 === 0) {
      series.push({ year: m / 12, value: round(value), contributed: round(contributed) });
      // Se dibuja hasta alcanzar el objetivo y unos años más, para ver la curva.
      if (months !== null && m >= months + 60) break;
    }
  }

  return {
    target: Number.isFinite(target) ? round(target) : null,
    reached: months !== null,
    months,
    years: months === null ? null : Math.round((months / 12) * 10) / 10,
    series,
  };
}

function round(x) {
  return Math.round(x * 100) / 100;
}
