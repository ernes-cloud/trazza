/**
 * Regla de los dos meses (art. 33.5.f LIRPF, valores cotizados) — núcleo PURO
 * y compartido. Una sola definición: lo usan la calculadora pública
 * (publicTools/capitalGains.computeCapitalGains) y el informe fiscal de la app
 * (taxReportService.buildTaxReport). Nunca un espejo de esto en otro sitio.
 *
 * Entra una lista de operaciones YA en la moneda del informe (EUR):
 *   { id, key, type: 'buy'|'sell', date: 'YYYY-MM-DD', qty,
 *     unitCostEur   (compra: coste unitario, con lo que el llamante quiera
 *                    dentro — la calculadora mete la comisión),
 *     netProceedsEur (venta: importe de la transmisión) }
 * `key` agrupa los valores homogéneos (el llamante decide: ISIN, nombre…).
 * Un importe `null`/`undefined` es DESCONOCIDO (p. ej., sin tipo de cambio de
 * esa fecha): la cantidad sigue contando para el FIFO, pero la venta que lo
 * toca sale con gain/computable `null` y no se trata como pérdida. Nunca se
 * rellena con nada.
 *
 * Regla:
 * - FIFO con FIFOCalculator (services/fifoAnalytics).
 * - Una pérdida no se computa si se compran valores homogéneos en los dos meses
 *   anteriores (y siguen en cartera tras la venta) o posteriores; con recompra
 *   parcial, solo la parte proporcional. Lo aplazado se cuelga del lote de
 *   reposición.
 * - Se integra "a medida que se transmitan los valores que permanezcan en el
 *   patrimonio", y solo si la transmisión es DEFINITIVA (manual práctico Renta
 *   2025: definitiva = sin adquirir valores homogéneos en los dos meses
 *   anteriores o posteriores); si no, pasa a las nuevas acciones de reposición.
 *
 * Sale, por venta: { id, key, date, qty, proceeds, gain, deferred, released,
 * computable, lots, blockedBy, missingShares, amountUnknown } (+ knownQty,
 * knownProceeds y excludedProceeds con { knownPartOnly: true }), y lo aplazado
 * pendiente por lote (`pendingByLot`) y en total (`stillDeferred`). Sin
 * redondeos: los hace quien pinta.
 */
// Import relativo (como taxReportService y fxByDate): el módulo corre en Node sin alias.
import { FIFOCalculator } from '../fifoAnalytics.js';

const EPS = 1e-9;

/** 'YYYY-MM-DD' ± n meses, con el día recortado al último del mes (30-abr − 2 → 28-feb). */
export function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/** Ventana de la regla: [fecha − 2 meses, fecha + 2 meses], ambos días incluidos. */
export function twoMonthWindow(date) {
  return { from: addMonths(date, -2), to: addMonths(date, 2) };
}

const known = (v) => v != null && Number.isFinite(Number(v));

/**
 * @param {Array<{id:string,key:string,type:'buy'|'sell',date:string,qty:number,unitCostEur?:number|null,netProceedsEur?:number|null}>} operations
 *   Ordenadas o no: se ordenan por fecha respetando el orden de entrada dentro del mismo día.
 * @param {{ knownPartOnly?: boolean }} [opts]
 *   knownPartOnly (informe fiscal de la app): en una venta con unidades SIN
 *   compra (missingShares), gain, isLoss y lo aplazado usan solo las unidades
 *   conocidas: gain = importe × conocidas/vendidas − coste de los lotes. La
 *   venta lleva además knownQty, knownProceeds y excludedProceeds (el importe
 *   de las unidades sin coste, que el llamante deja FUERA y avisa). Sin la
 *   opción (calculadora pública), las unidades sin compra cuentan a coste 0,
 *   como siempre, y la salida no cambia.
 */
export function applyTwoMonthRule(operations, { knownPartOnly = false } = {}) {
  const ops = (operations || [])
    .map((op, index) => ({ op, index }))
    .sort((a, b) => (a.op.date === b.op.date ? a.index - b.index : a.op.date < b.op.date ? -1 : 1))
    .map(({ op }) => op);

  const fifo = new FIFOCalculator();
  const lotsById = new Map();            // buy id → lote de la cola de FIFOCalculator
  const pendingDeferral = new Map();     // buy id futura → { amount, shares } ya asignados
  const blockUsed = new Map();           // buy id → acciones ya usadas para bloquear pérdidas
  const buysByKey = new Map();
  for (const op of ops) {
    if (op.type !== 'buy') continue;
    if (!buysByKey.has(op.key)) buysByKey.set(op.key, []);
    buysByKey.get(op.key).push(op);
  }

  const sales = [];

  for (const op of ops) {
    const queueKey = `${op.key}_EUR`;
    if (op.type === 'buy') {
      const costKnown = known(op.unitCostEur);
      fifo.processBuy({ isin: op.key, moneda: 'EUR', cantidad: op.qty, precio: costKnown ? op.unitCostEur : 0, _id: op.id, _date: op.date });
      const queue = fifo.queues[queueKey];
      const lot = queue[queue.length - 1];
      const pre = pendingDeferral.get(op.id);
      lot._deferredAmount = pre?.amount || 0;
      lot._deferredShares = pre?.shares || 0;
      lot._unknownCost = !costKnown;
      lotsById.set(op.id, lot);
      continue;
    }

    // ── Venta ──────────────────────────────────────────────────────────────
    const proceedsKnown = known(op.netProceedsEur);
    const queue = fifo.queues[queueKey] || [];
    const before = new Map(queue.map((lot) => [lot, lot.remainingQty.toNumber()]));
    const result = fifo.processSell({ isin: op.key, moneda: 'EUR', cantidad: op.qty, precio: proceedsKnown ? op.netProceedsEur / op.qty : 0 });

    // Lotes consumidos y pérdidas aplazadas que llevaban asociadas.
    const lots = [];
    let touchesUnknownCost = false;
    let pendingAmount = 0;
    let pendingShares = 0;
    for (const lot of queue) {
      const used = before.get(lot) - lot.remainingQty.toNumber();
      if (used <= EPS) continue;
      if (lot._unknownCost) touchesUnknownCost = true;
      lots.push({ buyId: lot._id, date: lot._date, qty: used, unitCost: lot._unknownCost ? null : lot._price.toNumber() });
      if (lot._deferredShares > EPS) {
        const k = Math.min(used, lot._deferredShares);
        const part = lot._deferredAmount * (k / lot._deferredShares);
        pendingAmount += part;
        pendingShares += k;
        lot._deferredAmount -= part;
        lot._deferredShares -= k;
        // Esas acciones ya no están en cartera: liberan su reserva como reposición.
        blockUsed.set(lot._id, Math.max(0, (blockUsed.get(lot._id) || 0) - k));
      }
    }

    const amountUnknown = !proceedsKnown || touchesUnknownCost;
    const missingShares = result.sharesMissingHistory > EPS ? result.sharesMissingHistory : 0;
    // Unidades sobre las que se calcula el resultado: todas o, con knownPartOnly,
    // solo las que tienen compra. profit = importe − coste de los lotes, así que
    // la parte conocida es profit − importe × sinCompra/vendidas.
    const baseQty = knownPartOnly ? Math.max(0, op.qty - missingShares) : op.qty;
    const excludedProceeds = knownPartOnly && proceedsKnown ? op.netProceedsEur * (missingShares / op.qty) : 0;
    const gain = amountUnknown ? null : result.profit - excludedProceeds;
    let deferred = 0;
    let released = 0;
    const blockedBy = [];

    // Acciones de reposición de ESTA venta: compras de valores homogéneos en los dos
    // meses anteriores (que sigan en cartera tras la venta) o posteriores. Se asignan
    // UNA sola vez y sobre ellas se cuelgan a la vez:
    //  - la pérdida propia de la venta, si la hay (art. 33.5.f LIRPF), y
    //  - la pérdida aplazada que traían los lotes vendidos: solo se libera si la venta
    //    es DEFINITIVA; si no, pasa a esas acciones de reposición.
    // Con importe desconocido no se sabe si hay pérdida: no se aplaza nada propio.
    const isLoss = gain != null && gain < -EPS && baseQty > EPS;
    const need0 = isLoss ? baseQty : Math.min(pendingShares, op.qty);
    if (need0 > EPS) {
      const { from, to } = twoMonthWindow(op.date);
      let need = need0;
      let carryLeft = pendingShares; // acciones con arrastre aún sin reposición
      const candidates = (buysByKey.get(op.key) || [])
        .filter((b) => b.date >= from && b.date <= to)
        // Las anteriores que siguen en cartera tras esta venta, luego las posteriores.
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
        const own = isLoss ? -gain * (take / baseQty) : 0;
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
      key: op.key,
      date: op.date,
      qty: op.qty,
      proceeds: proceedsKnown ? op.netProceedsEur : null,
      gain,
      deferred,
      released,
      // Lo que entra en la base de ESE año: la ganancia/pérdida menos lo aplazado,
      // más (en negativo) las pérdidas aplazadas antes que se liberan ahora.
      computable: gain == null ? null : gain + deferred - released,
      lots,
      blockedBy,
      missingShares,
      amountUnknown,
      ...(knownPartOnly ? {
        knownQty: baseQty,
        knownProceeds: proceedsKnown ? op.netProceedsEur - excludedProceeds : null,
        excludedProceeds: proceedsKnown ? excludedProceeds : null,
      } : {}),
    });
  }

  let stillDeferred = 0;
  const pendingByLot = [];
  for (const [buyId, lot] of lotsById) {
    stillDeferred += lot._deferredAmount;
    if (lot._deferredAmount > EPS) {
      pendingByLot.push({
        buyId,
        key: lot.isin,
        date: lot._date,
        qty: lot._qty.toNumber(),
        remainingQty: lot.remainingQty.toNumber(),
        deferredAmount: lot._deferredAmount,
        deferredShares: lot._deferredShares,
      });
    }
  }

  return { sales, pendingByLot, stillDeferred };
}
