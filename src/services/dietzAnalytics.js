import Decimal from 'decimal.js';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

/**
 * Calculates the Modified Dietz return for a single calendar month.
 *
 * Formula: R = (V_end − V_start − NetFlows) / (V_start + WeightedFlows)
 * where WeightedFlows = Σ (flow_i × (D − d_i) / D) and D = total days in month.
 *
 * Cash flows are time-weighted by how many days they were invested: a deposit on
 * day 1 gets weight ≈ 1, a deposit on the last day gets weight ≈ 0.  This prevents
 * new capital injections from artificially inflating or deflating the return.
 *
 * @param {number} startValue   - Portfolio value at the start of the month.
 * @param {number} endValue     - Portfolio value at the end of the month.
 * @param {Array}  cashFlows    - Array of { date: 'YYYY-MM-DD', amount_in_eur: number, type: 'deposit'|'withdrawal' }.
 * @param {number} daysInMonth  - Total calendar days in the month (28–31).
 * @returns {number} Return percentage (e.g. 8 means +8%).
 */
export function calculateModifiedDietz(startValue, endValue, cashFlows, daysInMonth) {
  const D = new Decimal(daysInMonth);
  let netFlows = new Decimal(0);
  let weightedFlows = new Decimal(0);

  cashFlows.forEach(cf => {
    const raw = new Decimal(cf.amount_in_eur ?? 0);
    const amount = cf.type === 'withdrawal' ? raw.abs().negated() : raw.abs();

    netFlows = netFlows.plus(amount);

    const dayOfMonth = parseInt(cf.date.split('-')[2], 10);
    const weight = D.minus(dayOfMonth).dividedBy(D);
    weightedFlows = weightedFlows.plus(amount.times(weight));
  });

  const S = new Decimal(startValue);
  const E = new Decimal(endValue);
  const numerator = E.minus(S).minus(netFlows);
  const denominator = S.plus(weightedFlows);

  if (denominator.isZero()) return 0;

  return numerator.dividedBy(denominator.abs()).times(100).toNumber();
}

