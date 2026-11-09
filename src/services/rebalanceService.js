// Rebalancing plan for /app/rebalance.
//
// Pure module: no React, no Supabase — receives loaded DB position rows and
// returns the plan. Display-level derivation (like positionRowMetrics): value
// and weight math is delegated to the SAME shared functions the brokers screen
// uses (computePositionRowMetrics / computeTargetMetrics), so the weights and
// drifts shown here match the bullet charts by construction.

import Decimal from 'decimal.js';
import { computePositionRowMetrics, computeTargetMetrics } from './positionRowMetrics';
import { isCashPosition } from '../lib/positionKind.js';
import { positionGroupKey } from '../lib/positionGroupKey.js';
import { TICKER_MAP, resolveTicker } from '../lib/tickerMap.js';

// Nombre que no dice nada: vacío o el propio ticker (sin el sufijo de divisa).
const isPlaceholderName = (name, ticker) => {
  const n = (name || '').trim().toUpperCase();
  const tk = (ticker || '').replace(/\s*\([A-Z]{3}\)$/i, '').trim().toUpperCase();
  return !n || n === tk;
};

const D = (v) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return new Decimal(Number.isFinite(n) ? n : 0);
};

export const BAND_MODES = ['strict', 'moderate', 'swedroe'];

/**
 * Tolerance band (in percentage points of drift) before a position needs action.
 * - strict:   ±1pp
 * - moderate: ±3pp
 * - swedroe:  the 5/25 rule — rebalance when the drift exceeds 5pp absolute OR
 *             25% relative of the target, whichever is SMALLER (so small
 *             allocations still get rebalanced: target 10% → band 2.5pp).
 */
export function bandFor(bandMode, targetPct) {
  const target = parseFloat(targetPct) || 0;
  if (bandMode === 'strict') return 1;
  if (bandMode === 'moderate') return 3;
  return Math.min(5, target * 0.25);
}


/**
 * Builds the rebalance plan over raw DB position rows (`positions.select('*, assets(*)')`).
 *
 * Rows are grouped by ISIN (fallback ticker) with target = max of the group —
 * the same merge rule usePositions applies in the general view, so one asset
 * held on several brokers is one row here too.
 *
 * The total (denominator of every weight) INCLUDES cash and untargeted
 * positions, matching stats.current on the brokers screen — a target of 20%
 * means 20% of the whole portfolio, not 20% of the targeted subset.
 *
 * Cash is ALWAYS summed into the total of ANY sign — a negative cash position is
 * margin used (borrowed), so it correctly lowers the net total. With
 * `cashAsAsset` (the "all brokers" scope) cash also becomes a first-class,
 * target-editable row so it participates in the plan like any other asset;
 * otherwise it only counts toward the denominator (legacy behaviour).
 *
 * Modes:
 * - 'trade':      classic BUY/SELL/HOLD against the band; amount = |moneyDelta|.
 * - 'contribute': distributes `contribution` (new money, in preferred currency)
 *                 across underweight targets WITHOUT selling: each target's
 *                 deficit against the post-contribution total is funded
 *                 (proportionally scaled when the contribution can't cover them
 *                 all); any leftover is split proportionally to targets.
 *
 * @returns {{ rows: Array, untargetedRows: Array, totalCurrent: number,
 *             cashValue: number, targetSum: number, untargetedCount: number,
 *             untargetedValue: number }}
 */
export function buildRebalancePlan(positions, {
  preferredCurrency = 'EUR',
  exchangeRates = {},
  bandMode = 'swedroe',
  mode = 'trade',
  contribution = 0,
  cashAsAsset = false,
} = {}) {
  const ctx = { preferredCurrency, exchangeRates };

  let cashValue = new Decimal(0);
  let cashTarget = 0;
  const cashPositionIds = [];
  const groups = new Map(); // ISIN/ticker → aggregated row (value as Decimal)

  for (const p of positions || []) {
    const qty = parseFloat(p.quantity || 0);
    const m = computePositionRowMetrics(p, ctx);
    // Cash first, BEFORE the qty>0 guard: a negative cash position (margin used)
    // must count toward the total instead of being dropped as a "closed" row.
    if (isCashPosition(p)) {
      cashValue = cashValue.plus(D(m.valConverted));
      cashTarget = Math.max(cashTarget, parseFloat(p.target_percentage) || 0);
      cashPositionIds.push(p.id);
      continue;
    }
    // Virtual rows (assets you don't hold yet, added on the screen to plan a new
    // purchase) come in with qty 0 and must still be planned; real closed
    // positions (qty 0, not virtual) stay excluded as before.
    if (!(qty > 0) && !p.isVirtual) continue;
    // MISMA clave que la vista general de brokers (lib/positionGroupKey): por
    // `isin || ticker` el Amazon de DeGiro (con ISIN) y el de IBKR (sin ISIN, el
    // parser solo lo saca de los dividendos) eran dos filas con dos targets.
    const key = positionGroupKey(p, { tickerMap: TICKER_MAP, resolveTicker });
    const target = parseFloat(p.target_percentage) || 0;
    const g = groups.get(key);
    if (g) {
      groups.set(key, {
        ...g,
        value: g.value.plus(D(m.valConverted)),
        qty: g.qty + qty,
        // Same rule as the general-view merge in usePositions
        target: Math.max(g.target, target),
        positionIds: [...g.positionIds, p.id],
        isVirtual: g.isVirtual && !!p.isVirtual,
        // La fila unida enseña el ISIN y el nombre real de cualquier broker que
        // los tenga: IBKR guarda a veces el ticker como nombre ('AMZN').
        isin: g.isin || p.assets?.isin || '',
        name: isPlaceholderName(g.name, g.ticker) && p.assets?.company_name ? p.assets.company_name : g.name,
      });
    } else {
      groups.set(key, {
        key,
        ticker: p.assets?.ticker || '',
        isin: p.assets?.isin || '',
        name: p.assets?.company_name || '',
        currency: p.assets?.currency || preferredCurrency,
        pricePref: m.currentPrice * (m.fxRate || 1),
        value: D(m.valConverted),
        qty,
        target,
        // DB position ids of the group — lets the UI persist an inline target
        // edit to every broker row of the asset at once.
        positionIds: [p.id],
        isVirtual: !!p.isVirtual,
      });
    }
  }

  const invested = [...groups.values()];
  const totalCurrent = invested.reduce((s, g) => s.plus(g.value), new Decimal(0)).plus(cashValue);

  const targeted = [];
  const untargeted = [];
  for (const g of invested) {
    if (g.target > 0) targeted.push(g);
    else untargeted.push(g);
  }

  // Cash as a first-class row (only in the "all brokers" scope). It carries the
  // CASH position ids so an inline target edit persists to them, and price 1 so
  // its trade qty reads in currency units. Value may be negative (margin used).
  if (cashAsAsset && cashPositionIds.length > 0) {
    const cashGroup = {
      key: 'CASH',
      ticker: 'CASH',
      isin: '',
      name: '',
      currency: preferredCurrency,
      pricePref: 1,
      value: cashValue,
      qty: cashValue.toNumber(),
      target: cashTarget,
      positionIds: cashPositionIds,
      isCash: true,
    };
    if (cashTarget > 0) targeted.push(cashGroup);
    else untargeted.push(cashGroup);
  }

  const untargetedCount = untargeted.length;
  const untargetedValue = untargeted.reduce((s, g) => s.plus(g.value), new Decimal(0));
  const targetSum = targeted.reduce((s, g) => s + g.target, 0);

  // Untargeted rows are NOT part of the plan (no action/amount), but the UI
  // shows them so the user can set their target inline from this screen.
  const untargetedRows = untargeted
    .map(g => ({
      ...g,
      value: g.value.toNumber(),
      currentWeight: totalCurrent.gt(0) ? g.value.div(totalCurrent).times(100).toNumber() : 0,
    }))
    .sort((a, b) => b.value - a.value);

  // ── Contribution allocation (contribute mode) ──────────────────────────────
  const amount = Decimal.max(0, D(contribution));
  const allocByKey = new Map(); // key → Decimal
  if (mode === 'contribute' && amount.gt(0) && targeted.length > 0) {
    const newTotal = totalCurrent.plus(amount);
    const deficits = targeted.map(g => ({
      key: g.key,
      deficit: Decimal.max(0, D(g.target).div(100).times(newTotal).minus(g.value)),
    }));
    const sumDeficits = deficits.reduce((s, d) => s.plus(d.deficit), new Decimal(0));
    const scale = sumDeficits.gt(0) ? Decimal.min(1, amount.div(sumDeficits)) : new Decimal(0);
    let allocated = new Decimal(0);
    for (const d of deficits) {
      const a = d.deficit.times(scale);
      allocByKey.set(d.key, a);
      allocated = allocated.plus(a);
    }
    // Contribution exceeds every deficit. Direct the rest to targets that are
    // NOT already over their target weight (proportional to target) — pouring
    // more into an already-overweight asset is the opposite of rebalancing.
    // Only if EVERY target is already over (nowhere underweight to grow into) do
    // we fall back to splitting across all targets so the money lands somewhere.
    const leftover = amount.minus(allocated);
    if (leftover.gt(1e-9) && targetSum > 0) {
      const notOver = targeted.filter(g => {
        const alloc = allocByKey.get(g.key) || new Decimal(0);
        const targetValue = D(g.target).div(100).times(newTotal);
        return g.value.plus(alloc).lte(targetValue.plus(1e-9));
      });
      const pool = notOver.length > 0 ? notOver : targeted;
      const poolTargetSum = pool.reduce((s, g) => s + g.target, 0);
      if (poolTargetSum > 0) {
        for (const g of pool) {
          const prev = allocByKey.get(g.key) || new Decimal(0);
          allocByKey.set(g.key, prev.plus(leftover.times(D(g.target).div(poolTargetSum))));
        }
      }
    }
  }

  // ── Per-row plan ───────────────────────────────────────────────────────────
  const rows = targeted.map(g => {
    const tm = computeTargetMetrics(g.value.toNumber(), g.target, totalCurrent.toNumber());
    const band = bandFor(bandMode, g.target);
    let action;
    let rowAmount;
    if (mode === 'contribute') {
      const alloc = allocByKey.get(g.key) || new Decimal(0);
      rowAmount = alloc.toNumber();
      action = alloc.gt(0.005) ? 'BUY' : 'HOLD';
    } else {
      const needsAction = Math.abs(tm.drift) >= band;
      action = !needsAction ? 'HOLD' : (tm.drift < 0 ? 'BUY' : 'SELL');
      rowAmount = action === 'HOLD' ? 0 : D(tm.moneyDelta || 0).abs().toNumber();
    }
    return {
      ...g,
      ...tm,
      value: g.value.toNumber(),
      band,
      action,
      amount: rowAmount,
      tradeQty: g.pricePref > 0 ? D(rowAmount).div(g.pricePref).toNumber() : 0,
    };
  }).sort((a, b) => a.drift - b.drift); // most underweight first

  return {
    rows,
    untargetedRows,
    totalCurrent: totalCurrent.toNumber(),
    cashValue: cashValue.toNumber(),
    targetSum,
    untargetedCount,
    untargetedValue: untargetedValue.toNumber(),
  };
}
