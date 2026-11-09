/**
 * COPIA CONGELADA de services/publicTools/capitalGains.js tal y como estaba en
 * b7e6893d (2026-10-22), ANTES de extraer el núcleo de la regla de los dos
 * meses a services/tax/twoMonthRule.js.
 *
 * SOLO para tests: capitalGains.equivalence.test.js compara esta versión con la
 * nueva sobre miles de carteras pseudoaleatorias. No la importes desde la app y
 * no la "arregles": su valor es que no cambia. Si la regla cambia a propósito,
 * se actualiza esta copia en el mismo commit y se explica por qué.
 */
import { FIFOCalculator } from '@/services/fifoAnalytics';
import { incrementalSavingsTax } from '../savingsTax';

const EPS = 1e-9;
const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

/** 'YYYY-MM-DD' ± n meses, con el día recortado al último del mes (30-abr − 2 → 28-feb). */
export function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

const isIsoDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const assetKey = (name) => String(name || '').trim().toUpperCase() || '—';

function prepare(operations) {
  const valid = [];
  const invalid = [];
  operations.forEach((op, index) => {
    const qty = Number(op.qty);
    const price = Number(op.price);
    const fee = Number(op.fee) || 0;
    let reason = null;
    if (!isIsoDate(op.date)) reason = 'date';
    else if (!(qty > 0)) reason = 'qty';
    else if (!(price >= 0)) reason = 'price';
    else if (fee < 0) reason = 'fee';
    if (reason) { invalid.push({ id: op.id, reason }); return; }
    valid.push({ ...op, qty, price, fee, index, key: assetKey(op.asset) });
  });
  valid.sort((a, b) => (a.date === b.date ? a.index - b.index : a.date < b.date ? -1 : 1));
  return { valid, invalid };
}

export function computeCapitalGains(operations, { otherSavingsIncome = 0 } = {}) {
  const { valid, invalid } = prepare(operations || []);
  const fifo = new FIFOCalculator();
  const lotsById = new Map();
  const pendingDeferral = new Map();
  const blockUsed = new Map();
  const buysByKey = new Map();
  for (const op of valid) {
    if (op.type !== 'buy') continue;
    if (!buysByKey.has(op.key)) buysByKey.set(op.key, []);
    buysByKey.get(op.key).push(op);
  }

  const sales = [];
  const oversold = [];

  for (const op of valid) {
    const queueKey = `${op.key}_EUR`;
    if (op.type === 'buy') {
      fifo.processBuy({ isin: op.key, moneda: 'EUR', cantidad: op.qty, precio: (op.qty * op.price + op.fee) / op.qty, _id: op.id, _date: op.date });
      const queue = fifo.queues[queueKey];
      const lot = queue[queue.length - 1];
      const pre = pendingDeferral.get(op.id);
      lot._deferredAmount = pre?.amount || 0;
      lot._deferredShares = pre?.shares || 0;
      lotsById.set(op.id, lot);
      continue;
    }

    const queue = fifo.queues[queueKey] || [];
    const before = new Map(queue.map((lot) => [lot, lot.remainingQty.toNumber()]));
    const result = fifo.processSell({ isin: op.key, moneda: 'EUR', cantidad: op.qty, precio: Math.max(0, op.qty * op.price - op.fee) / op.qty });
    if (result.sharesMissingHistory > EPS) oversold.push({ id: op.id, missing: result.sharesMissingHistory });

    const lots = [];
    const consumed = new Set();
    let pendingAmount = 0;
    let pendingShares = 0;
    for (const lot of queue) {
      const used = before.get(lot) - lot.remainingQty.toNumber();
      if (used <= EPS) continue;
      consumed.add(lot._id);
      lots.push({ buyId: lot._id, date: lot._date, qty: used, unitCost: lot._price.toNumber() });
      if (lot._deferredShares > EPS) {
        const k = Math.min(used, lot._deferredShares);
        const part = lot._deferredAmount * (k / lot._deferredShares);
        pendingAmount += part;
        pendingShares += k;
        lot._deferredAmount -= part;
        lot._deferredShares -= k;
        blockUsed.set(lot._id, Math.max(0, (blockUsed.get(lot._id) || 0) - k));
      }
    }

    const proceeds = Math.max(0, op.qty * op.price - op.fee);
    const gain = result.profit;
    let deferred = 0;
    let released = 0;
    const blockedBy = [];

    const isLoss = gain < -EPS;
    const need0 = isLoss ? op.qty : Math.min(pendingShares, op.qty);
    if (need0 > EPS) {
      const from = addMonths(op.date, -2);
      const to = addMonths(op.date, 2);
      let need = need0;
      let carryLeft = pendingShares;
      const candidates = (buysByKey.get(op.key) || [])
        .filter((b) => b.date >= from && b.date <= to)
        .sort((a, b) => (a.date <= op.date) === (b.date <= op.date) ? (a.date < b.date ? -1 : 1) : (a.date <= op.date ? -1 : 1));
      for (const b of candidates) {
        if (need <= EPS) break;
        const isPast = lotsById.has(b.id);
        const stillHeld = isPast ? lotsById.get(b.id).remainingQty.toNumber() : b.qty;
        const free = stillHeld - (blockUsed.get(b.id) || 0);
        if (free <= EPS) continue;
        const take = Math.min(need, free);
        need -= take;
        blockUsed.set(b.id, (blockUsed.get(b.id) || 0) + take);
        const own = isLoss ? -gain * (take / op.qty) : 0;
        const carryTake = Math.min(take, carryLeft);
        const carry = pendingShares > EPS ? pendingAmount * (carryTake / pendingShares) : 0;
        carryLeft -= carryTake;
        deferred += own;
        if (isLoss) blockedBy.push({ buyId: b.id, date: b.date, qty: take });
        if (isPast) {
          const lot = lotsById.get(b.id);
          lot._deferredAmount += own + carry;
          lot._deferredShares += take;
        } else {
          const pre = pendingDeferral.get(b.id) || { amount: 0, shares: 0 };
          pendingDeferral.set(b.id, { amount: pre.amount + own + carry, shares: pre.shares + take });
        }
      }
      if (pendingShares > EPS) released = pendingAmount * (carryLeft / pendingShares);
    } else if (pendingShares > EPS) {
      released = pendingAmount;
    }

    sales.push({
      id: op.id,
      asset: String(op.asset || '').trim() || '—',
      date: op.date,
      year: Number(op.date.slice(0, 4)),
      qty: op.qty,
      proceeds: round2(proceeds),
      cost: round2(proceeds - gain),
      gain: round2(gain),
      deferred: round2(deferred),
      released: round2(released),
      computable: round2(gain + deferred - released),
      lots,
      blockedBy,
    });
  }

  const byYear = new Map();
  for (const s of sales) {
    const y = byYear.get(s.year) || { year: s.year, gains: 0, losses: 0, deferred: 0, released: 0, sales: 0 };
    const own = s.gain + s.deferred;
    if (own >= 0) y.gains += own; else y.losses += own;
    y.deferred += s.deferred;
    y.released += s.released;
    y.sales += 1;
    byYear.set(s.year, y);
  }
  const years = [...byYear.values()]
    .sort((a, b) => b.year - a.year)
    .map((y) => {
      const net = y.gains + y.losses - y.released;
      return {
        year: y.year,
        sales: y.sales,
        gains: round2(y.gains),
        losses: round2(y.losses - y.released),
        deferred: round2(y.deferred),
        released: round2(y.released),
        net: round2(net),
        tax: net > 0 ? round2(incrementalSavingsTax(net, otherSavingsIncome)) : 0,
      };
    });

  let stillDeferred = 0;
  for (const lot of lotsById.values()) stillDeferred += lot._deferredAmount;

  return { sales, years, invalid, oversold, stillDeferred: round2(stillDeferred) };
}
