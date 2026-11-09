// Informe fiscal anual (brokers screen).
//
// Pure module: consumes the SAME processed rows the brokers screen already
// shows (processedImportData.salesWithPL / dividends / commissions), so for a
// portfolio in the preferred currency the report matches the screen totals by
// construction (fixed by a test).
//
// Tipo de cambio — criterio AEAT (desde 2026-10-22; antes TODO iba al cambio
// de HOY): cada importe se convierte al tipo del día de SU operación. En una
// venta, el valor de transmisión al tipo del día de la venta y el de
// adquisición, lote FIFO a lote, al tipo del día de cada compra (`lots` de
// FIFOCalculator.processSell). Los tipos llegan ya resueltos en `rates`
// (tax/fxByDate.preloadTaxRates); aquí solo se eligen con resolveRate, así que
// el módulo sigue siendo puro y síncrono.
//
// Data honesty:
// - Una fila sin tipo para su fecha NO entra en los totales: va a `missingFx`
//   del año con su motivo (`missingFxCount`). Nunca se rellena con el de hoy.
// - Con `buys` (lo que pasa siempre TaxReportDialog) las ventas se agrupan por
//   ISIN y pasan por el núcleo tax/twoMonthRule (FIFO por ISIN, ver abajo):
//   · Importes con las comisiones DENTRO (art. 35 LIRPF): transmisión =
//     cantidad × precio − comisión de venta; adquisición = Σ lote.qty ×
//     lote.unitCost, con la comisión de compra en el coste unitario del lote.
//   · Venta sin NINGUNA compra del ISIN (missing_buy_data): fuera de los
//     totales, su "beneficio" sería el importe íntegro. Cuenta en unreliableCount.
//   · Venta con PARTE de las unidades sin compra (partial_history, núcleo con
//     knownPartOnly): computa la parte CONOCIDA (importe prorrateado por
//     unidades con compra − coste de sus lotes) y las unidades sin coste van,
//     con su importe de transmisión excluido, a `partialHistory` del año
//     (diálogo y CSV). Nunca a coste 0.
// - Sin `buys` (legacy): lotes del FIFO de la pantalla, transmisión =
//   cantidad × precio y adquisición = Σ lote.qty × lote.unitCost, comisiones
//   todas en `fees`; una venta sin historial o con historial parcial se excluye
//   entera (unreliableCount).
// - DEGIRO/IBKR apuntan la retención como línea TAX propia → `withholding`.
//
// Regla de los dos meses (art. 33.5.f LIRPF, desde 2026-10-22): si se pasan
// las compras (`buys` = processedImportData.buys), cada compra y cada venta se
// convierten al tipo de SU fecha y pasan por el núcleo compartido
// tax/twoMonthRule (el mismo de la calculadora pública). Homogéneos = mismo
// ISIN (art. 37.2 LIRPF: misma entidad y mismos derechos, sin importar el
// mercado ni la divisa); sin ISIN, por nombre normalizado, y el año lo cuenta
// en `noIsinCount`. Los totales usan lo COMPUTABLE: una pérdida aplazada no
// resta en su año y resta (como `released`) en el año en que se vende de forma
// definitiva lo recomprado.
// Con `buys` el informe NO usa nada del FIFO de la pantalla (fifoAnalytics,
// cola por ISIN+divisa, por presentación): estado (sin historial, historial
// parcial, sin tipo), importes y lotes salen del FIFO por ISIN del núcleo. Con
// mercados mezclados el informe y la pantalla pueden diferir, a propósito.
// Gastos (art. 35 LIRPF, desde 2026-10-22): con `buys`, la comisión de compra
// suma al valor de adquisición y la de venta resta del de transmisión, cada
// una al tipo de su fecha y prorrateada por FIFO (va en el coste unitario del
// lote), igual que computeCapitalGains; por eso también entra en la pérdida
// aplazada. `fees` solo lleva los gastos sueltos (FEE no ligados a una
// operación). El informe difiere así de la pantalla en esas comisiones, a
// propósito. La ruta sin `buys` las sigue llevando todas a `fees`.

import Decimal from 'decimal.js';
import { commissionCurrency } from './import/processedImportData.js';
import { isoDayOf, resolveRate, brokerFxFor } from './tax/fxByDate.js';
import { applyTwoMonthRule } from './tax/twoMonthRule.js';

const SHARE_EPS = 1e-8;

/**
 * Clave de valores homogéneos: el ISIN; si no hay, el nombre normalizado
 * (mayúsculas, sin espacios sobrantes), que puede fallar (dos productos con
 * el mismo nombre o uno con dos nombres) — por eso se marca `byName`.
 */
export function homogeneousKey(row) {
  const isin = String(row?.isin || '').trim().toUpperCase();
  if (isin) return { key: `ISIN:${isin}`, byName: false };
  const name = String(row?.nombre || row?.producto || row?.name || '').trim().replace(/\s+/g, ' ').toUpperCase();
  return { key: `NAME:${name || '—'}`, byName: true };
}

/** Orden del pipeline: día, hora; a igualdad, la compra antes que la venta. */
const opSortKey = (fecha, hora, typeRank, seq) => {
  const h = String(hora || '').split(':').map((p) => p.padStart(2, '0')).join(':');
  return [isoDayOf(fecha), h, typeRank, seq];
};
const compareSortKeys = (a, b) => {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
};

const D = (v) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return new Decimal(Number.isFinite(n) ? n : 0);
};

/** 'DD-MM-YYYY' (pipeline format) or 'YYYY-MM-DD' → 'YYYY'; null if unknown. */
export function yearOf(fecha) {
  if (!fecha || typeof fecha !== 'string') return null;
  const parts = fecha.split('T')[0].split('-');
  if (parts.length < 3) return null;
  if (parts[0].length === 4) return parts[0];
  if (parts[2].length === 4) return parts[2];
  return null;
}

/**
 * ¿Entra la venta en los totales? Las 'ok' y las de historial parcial con la
 * parte conocida calculada (con la regla). En la ruta sin `buys` una venta
 * con historial parcial lleva profit null y se queda fuera.
 */
const computes = (row) => row.status === 'ok' || (row.status === 'partial_history' && row.profit != null);

/** Retención de un dividendo apuntada como línea propia (DEGIRO, IBKR). */
const isWithholding = (c) => String(c?.type || c?.transaction_type || '').toUpperCase() === 'TAX';

/**
 * Builds the per-fiscal-year report (fiscal year = calendar year, España).
 *
 * @param {Array} sales        processedImportData.salesWithPL rows (with `lots`)
 * @param {Array} [buys]       processedImportData.buys — con ellas se aplica la regla de
 *                             los dos meses; sin ellas (undefined), no (twoMonthRuleApplied=false)
 * @param {Array} dividends    processedImportData.dividends rows
 * @param {Array} commissions  processedImportData.commissions rows (FEE/TAX + trade fees)
 * @param {string} preferredCurrency  currency of the report
 * @param {object} rates       { [currency]: { 'YYYY-MM-DD': number | {rate, date} } },
 *                             currency → preferredCurrency (preloadTaxRates)
 * @returns {{ years: string[], byYear: object, twoMonthRuleApplied: boolean,
 *             pendingDeferred: Array, stillDeferred: number }} years sorted desc
 */
export function buildTaxReport({ sales = [], buys, dividends = [], commissions = [], preferredCurrency = 'EUR', rates = {} } = {}) {
  const applyRule = Array.isArray(buys);
  const rateFor = (currency, fecha, brokerFx) =>
    resolveRate({ currency, date: isoDayOf(fecha), preferredCurrency, brokerFx, table: rates });
  // Importe de una compra (sign +1: cantidad·precio·tipo + comisión) o de una
  // venta (sign −1: … − comisión) en la moneda del informe. La comisión de
  // compraventa (`comisiones` de la fila, facturada en EUR: commissionCurrency)
  // va al tipo de SU fecha. { value: null, miss } si falta algún tipo.
  const tradeAmount = (t, r, sign) => {
    if (r.rate == null) return { value: null, miss: r };
    const gross = Number(t.cantidad) * Number(t.precio) * r.rate;
    const fee = Number(t.comisiones) > 0 ? Number(t.comisiones) : 0;
    if (fee === 0) return { value: gross, miss: null };
    const fr = rateFor(commissionCurrency({ isTradeCommission: true }), t.fecha, null);
    if (fr.rate == null) return { value: null, miss: fr };
    return { value: gross + sign * fee * fr.rate, miss: null };
  };

  const byYear = {};
  const yearBucket = (year) => {
    if (!byYear[year]) {
      byYear[year] = {
        gains: new Decimal(0),
        losses: new Decimal(0),
        // Valor de transmisión y de adquisición de las ventas que computan
        proceeds: new Decimal(0),
        acquisition: new Decimal(0),
        dividendsReceived: new Decimal(0),
        fees: new Decimal(0),
        // Retenciones que el broker apunta como línea propia (TAX: DEGIRO, IBKR).
        withholding: new Decimal(0),
        // Regla de los dos meses: pérdidas aplazadas este año, aplazadas de antes
        // (o de este) que se integran ahora, y lo que queda aplazado al cierre.
        deferred: new Decimal(0),
        released: new Decimal(0),
        stillDeferred: 0,
        twoMonthRule: applyRule,
        salesCount: 0,
        unreliableCount: 0,
        dividendsCount: 0,
        missingFxCount: 0,
        noIsinCount: 0,
        // Ventas con unidades SIN compra (con la regla): la parte conocida está en
        // los totales; aquí, por operación, las unidades sin coste y su importe
        // de transmisión, que NO están en los totales.
        partialHistoryCount: 0,
        sales: [],
        dividends: [],
        missingFx: [],
        partialHistory: [],
      };
    }
    return byYear[year];
  };
  const noteMissing = (b, kind, row, currency, amount, miss, date) => {
    b.missingFxCount += 1;
    b.missingFx.push({
      kind,
      fecha: row.fecha,
      isoDay: isoDayOf(row.fecha),
      nombre: row.nombre || row.producto || row.descripcion || '',
      isin: row.isin || '',
      currency,
      amount,
      date, // fecha cuyo tipo falta (la de la operación o la de un lote)
      reason: miss.reason,
    });
  };

  // ── Ventas: importes al tipo de su fecha (F1) ──────────────────────────────
  // Cada entrada guarda su fila del detalle; los totales se suman al final,
  // con o sin la regla de los dos meses.
  const saleEntries = [];
  for (const s of sales) {
    const year = yearOf(s.fecha);
    if (!year) continue;
    const b = yearBucket(year);
    const currency = s.moneda || 'EUR';
    b.salesCount += 1;

    const pushRow = (row) => {
      b.sales.push(row);
      saleEntries.push({ s, year, row });
    };
    const common = {
      fecha: s.fecha,
      isoDay: isoDayOf(s.fecha),
      nombre: s.nombre || s.producto || '',
      isin: s.isin || '',
      cantidad: parseFloat(s.cantidad || 0),
      precio: parseFloat(s.precio || 0),
      moneda: currency,
      total: parseFloat(s.total || 0),
    };
    // Con la regla, el estado, los importes y los lotes salen del FIFO por ISIN
    // del núcleo (más abajo); NADA del FIFO de la pantalla (ISIN+divisa).
    if (applyRule) {
      pushRow({ ...common, status: 'pending', profit: null });
      continue;
    }

    // ── Ruta sin `buys` (legacy, twoMonthRuleApplied=false) ──────────────────
    // La conserva el contrato de buildTaxReport, pero TaxReportDialog siempre
    // pasa `buys`. Usa los lotes del FIFO de la PANTALLA (cola por ISIN+divisa)
    // y los importes sin comisiones (van todas a `fees`).
    const missingShares = Number(s.sharesMissingHistory) > SHARE_EPS ? Number(s.sharesMissingHistory) : 0;
    const base = {
      ...common,
      profitPercent: s.profitPercent == null ? null : parseFloat(s.profitPercent),
      isMissingBuyData: !!s.isMissingBuyData,
      missingShares,
    };
    const lots = Array.isArray(s.lots) ? s.lots : [];

    if (s.isMissingBuyData || lots.length === 0) {
      b.unreliableCount += 1;
      pushRow({ ...base, status: 'missing_buy_data', profit: null });
      continue;
    }
    // Parte de las acciones vendidas sin compra en el historial: el pipeline
    // las cuenta a coste 0, así que el resultado no es fiable.
    if (missingShares > 0) {
      b.unreliableCount += 1;
      pushRow({ ...base, status: 'partial_history', profit: null });
      continue;
    }

    const saleRate = rateFor(currency, s.fecha, brokerFxFor(s, currency, preferredCurrency));
    const lotRates = lots.map(l => rateFor(currency, l.date, brokerFxFor({ moneda: currency, fxRate: l.fxRate }, currency, preferredCurrency)));
    const missIdx = saleRate.rate == null ? -1 : lotRates.findIndex(r => r.rate == null);
    if (saleRate.rate == null || missIdx !== -1) {
      const miss = saleRate.rate == null ? saleRate : lotRates[missIdx];
      const missDate = saleRate.rate == null ? isoDayOf(s.fecha) : isoDayOf(lots[missIdx].date);
      noteMissing(b, 'sale', s, currency, base.total, miss, missDate);
      pushRow({ ...base, status: 'missing_fx', profit: null, missingReason: miss.reason });
      continue;
    }

    // Mismo producto que FIFOCalculator (cantidad × precio), para que en la
    // divisa preferida el resultado sea idéntico al profit del pipeline.
    const proceeds = D(s.cantidad).times(D(s.precio)).times(saleRate.rate);
    let acquisition = new Decimal(0);
    const lotDetail = lots.map((l, i) => {
      const cost = D(l.qty).times(D(l.unitCost)).times(lotRates[i].rate);
      acquisition = acquisition.plus(cost);
      return {
        date: l.date, qty: l.qty, unitCost: l.unitCost,
        rate: lotRates[i].rate, rateSource: lotRates[i].source, rateDate: lotRates[i].rateDate,
        cost: cost.toNumber(),
      };
    });
    const profit = proceeds.minus(acquisition);

    pushRow({
      ...base,
      status: 'ok',
      rate: saleRate.rate,
      rateSource: saleRate.source,
      rateDate: saleRate.rateDate,
      proceeds: proceeds.toNumber(),
      acquisition: acquisition.toNumber(),
      profit: profit.toNumber(),
      lots: lotDetail,
    });
  }

  // ── Regla de los dos meses ────────────────────────────────────────────────
  let pendingDeferred = [];
  let stillDeferredTotal = 0;
  const noIsinByYear = {}; // operaciones agrupadas por nombre (sin ISIN), por año
  const flowByYear = {};   // Σ (aplazado − liberado) de las ventas de cada año
  if (applyRule) {
    const opsSorted = [];
    // Mismo filtro que el FIFO del pipeline (processedImportData): ni HOLDING
    // consolidados ni cantidades ≤ 0.
    const eligibleBuys = buys.filter((t) => !t.isConsolidated && Number(t.cantidad) > 0 && isoDayOf(t.fecha));
    const buyById = new Map();
    const buyRateById = new Map(); // tipo de la compra (detalle de lotes)
    const buyMissById = new Map(); // compra sin tipo: { reason, date } para el aviso de la venta
    eligibleBuys.forEach((t, i) => {
      const id = `b${i}`;
      const currency = t.moneda || 'EUR';
      const { key, byName } = homogeneousKey(t);
      const r = rateFor(currency, t.fecha, brokerFxFor(t, currency, preferredCurrency));
      const amount = tradeAmount(t, r, +1);
      buyById.set(id, t);
      buyRateById.set(id, r);
      if (amount.miss) buyMissById.set(id, { reason: amount.miss.reason, date: isoDayOf(t.fecha) });
      if (byName) noIsinByYear[yearOf(t.fecha)] = (noIsinByYear[yearOf(t.fecha)] || 0) + 1;
      opsSorted.push({
        sort: opSortKey(t.fecha, t.hora, 0, i),
        op: {
          id, key, type: 'buy', date: isoDayOf(t.fecha), qty: Number(t.cantidad),
          // Coste unitario CON la comisión de compra (art. 35.1.b LIRPF): como en
          // computeCapitalGains, (cantidad·precio·tipo + comisión·tipoComisión)/cantidad.
          // Sin tipo de su fecha: coste desconocido (cuenta su cantidad, nunca otro tipo).
          unitCostEur: amount.value == null ? null : amount.value / Number(t.cantidad),
        },
      });
    });
    const entryById = new Map();
    saleEntries.forEach((e, i) => {
      if (e.s.isConsolidated || !(Number(e.s.cantidad) > 0)) return;
      const id = `s${i}`;
      const { key, byName } = homogeneousKey(e.s);
      const currency = e.row.moneda;
      // El importe de la venta al tipo de SU fecha, tenga o no lotes la pantalla,
      // MENOS la comisión de venta (art. 35.2 LIRPF) al tipo de su fecha.
      e.saleRate = rateFor(currency, e.s.fecha, brokerFxFor(e.s, currency, preferredCurrency));
      const amount = tradeAmount(e.s, e.saleRate, -1);
      e.saleMiss = amount.miss;
      entryById.set(id, e);
      if (byName) noIsinByYear[e.year] = (noIsinByYear[e.year] || 0) + 1;
      opsSorted.push({
        sort: opSortKey(e.s.fecha, e.s.hora, 1, i),
        op: {
          id, key, type: 'sell', date: e.row.isoDay, qty: Number(e.s.cantidad),
          // Sin tipo: la venta cuenta su cantidad para el FIFO, pero no aplaza
          // ninguna pérdida inventada. Nunca negativo (como computeCapitalGains).
          netProceedsEur: amount.value == null ? null : Math.max(0, amount.value),
        },
      });
    });
    opsSorted.sort((a, b) => compareSortKeys(a.sort, b.sort));
    // knownPartOnly: una venta con unidades sin compra computa la parte conocida
    // (y solo esa parte aplaza); el resto se lista en `partialHistory`.
    const core = applyTwoMonthRule(opsSorted.map((o) => o.op), { knownPartOnly: true });

    const buyRef = (buyId) => {
      const t = buyById.get(buyId) || {};
      return { fecha: t.fecha, isoDay: isoDayOf(t.fecha), nombre: t.nombre || t.producto || '', isin: t.isin || '', moneda: t.moneda || 'EUR' };
    };
    // Lotes de la venta = lotes del núcleo (FIFO por ISIN), en la moneda del
    // informe y con el tipo de cada compra.
    const lotDetail = (lots) => lots.map((l) => {
      const r = buyRateById.get(l.buyId) || {};
      return {
        date: buyById.get(l.buyId)?.fecha ?? l.date,
        qty: l.qty,
        unitCost: l.unitCost, // ya en la moneda del informe
        rate: r.rate ?? null, rateSource: r.source, rateDate: r.rateDate,
        cost: l.unitCost == null ? null : l.qty * l.unitCost,
      };
    });
    // Aplazado pendiente al cierre de cada año = Σ (aplazado − liberado) de las
    // ventas hasta ese año (el arrastre entre lotes no cambia el total).
    for (const cs of core.sales) {
      const e = entryById.get(cs.id);
      const { row } = e;
      const y = row.isoDay.slice(0, 4);
      flowByYear[y] = (flowByYear[y] || 0) + cs.deferred - cs.released;
      const b = byYear[y];
      row.missingShares = cs.missingShares;
      row.isMissingBuyData = cs.missingShares >= cs.qty - SHARE_EPS;

      if (row.isMissingBuyData) {
        // Ninguna de las acciones vendidas tiene compra del ISIN: su "beneficio"
        // sería el importe íntegro.
        row.status = 'missing_buy_data';
        b.unreliableCount += 1;
      } else if (cs.gain == null) {
        // Falta el tipo de la venta o el de alguna compra que consume.
        const unknownLot = cs.lots.find((l) => l.unitCost == null);
        const miss = e.saleMiss
          ? { reason: e.saleMiss.reason, date: row.isoDay }
          : (buyMissById.get(unknownLot?.buyId) || { reason: 'no_rate', date: '' });
        row.status = 'missing_fx';
        row.missingReason = miss.reason;
        noteMissing(b, 'sale', row, row.moneda, row.total, miss, miss.date);
      } else if (cs.missingShares > 0) {
        // Historial parcial: computa la parte CONOCIDA (importe prorrateado por
        // unidades con compra − coste de sus lotes) y lo que falta queda fuera,
        // a la vista: unidades sin coste e importe de transmisión excluido.
        row.status = 'partial_history';
        b.partialHistoryCount += 1;
        b.partialHistory.push({
          fecha: row.fecha, isoDay: row.isoDay, nombre: row.nombre, isin: row.isin,
          quantity: cs.qty, missingShares: cs.missingShares, excludedProceeds: cs.excludedProceeds,
        });
      } else {
        row.status = 'ok';
      }

      if (row.status !== 'ok' && row.status !== 'partial_history') {
        // Fuera de los totales; si al venderse se integró una pérdida aplazada de
        // antes, se enseña en la fila para que no desaparezca en silencio.
        row.profit = null;
        row.deferred = null;
        row.computable = null;
        row.released = cs.released > 0 ? cs.released : null;
        continue;
      }
      row.rate = e.saleRate.rate;
      row.rateSource = e.saleRate.source;
      row.rateDate = e.saleRate.rateDate;
      // Con historial parcial, solo la parte conocida (knownProceeds = proceeds si no falta nada).
      row.proceeds = cs.knownProceeds;
      row.gain = cs.gain;
      row.profit = cs.gain;
      row.acquisition = cs.knownProceeds - cs.gain;
      row.lots = lotDetail(cs.lots);
      row.deferred = cs.deferred;
      row.released = cs.released;
      row.computable = cs.computable;
      row.blockedBy = cs.blockedBy.map((x) => ({ ...buyRef(x.buyId), qty: x.qty }));
    }
    // Ventas que no entran en el núcleo (HOLDING consolidado, cantidad ≤ 0):
    // el FIFO no las conoce, así que no hay coste.
    for (const e of saleEntries) {
      if (e.row.status !== 'pending') continue;
      e.row.status = 'missing_buy_data';
      e.row.isMissingBuyData = true;
      byYear[e.year].unreliableCount += 1;
    }
    stillDeferredTotal = Math.abs(core.stillDeferred) < 1e-9 ? 0 : core.stillDeferred;
    pendingDeferred = core.pendingByLot.map((p) => ({
      ...buyRef(p.buyId),
      qty: p.qty,
      remainingQty: p.remainingQty,
      deferredShares: p.deferredShares,
      deferredAmount: p.deferredAmount,
    })).sort((a, x) => a.isoDay.localeCompare(x.isoDay));
  }

  // ── Totales de ventas ─────────────────────────────────────────────────────
  // Con la regla: resultado propio computable (gain + deferred) en ganancias o
  // pérdidas, y lo liberado aparte; neto = Σ computable. Sin ella: el profit.
  for (const { year, row } of saleEntries) {
    if (!computes(row)) continue;
    const b = byYear[year];
    b.proceeds = b.proceeds.plus(row.proceeds);
    b.acquisition = b.acquisition.plus(row.acquisition);
    const own = applyRule ? D(row.gain).plus(row.deferred) : D(row.profit);
    if (own.gte(0)) b.gains = b.gains.plus(own);
    else b.losses = b.losses.plus(own);
    if (applyRule) {
      b.deferred = b.deferred.plus(row.deferred);
      b.released = b.released.plus(row.released);
    }
  }

  for (const d of dividends) {
    const year = yearOf(d.fecha);
    if (!year) continue;
    const b = yearBucket(year);
    const currency = d.moneda || 'EUR';
    const r = rateFor(currency, d.fecha, brokerFxFor(d, currency, preferredCurrency));
    b.dividendsCount += 1;
    if (r.rate == null) {
      noteMissing(b, 'dividend', d, currency, parseFloat(d.total || 0), r, isoDayOf(d.fecha));
      continue;
    }
    const amountConverted = D(d.total).times(r.rate);
    b.dividendsReceived = b.dividendsReceived.plus(amountConverted);
    b.dividends.push({
      fecha: d.fecha,
      isoDay: isoDayOf(d.fecha),
      nombre: d.nombre || d.producto || '',
      isin: d.isin || '',
      moneda: currency,
      rate: r.rate,
      rateSource: r.source,
      rateDate: r.rateDate,
      amount: amountConverted.toNumber(),
    });
  }

  for (const c of commissions) {
    // Con la regla, la comisión de una compraventa ya está DENTRO de los valores
    // de adquisición/transmisión (art. 35 LIRPF). En `fees` solo quedan los
    // gastos no imputables a una operación (conectividad, custodia…).
    if (applyRule && c.isTradeCommission) continue;
    const year = yearOf(c.fecha);
    if (!year) continue;
    const bucket = yearBucket(year);
    // Misma regla de moneda que la pantalla (commissionCurrency): las de
    // compraventa en EUR, las sueltas con la suya.
    const currency = commissionCurrency(c);
    const r = rateFor(currency, c.fecha, brokerFxFor(c, currency, preferredCurrency));
    if (r.rate == null) {
      noteMissing(bucket, isWithholding(c) ? 'withholding' : 'fee', c, currency, Math.abs(parseFloat(c.total || 0)), r, isoDayOf(c.fecha));
      continue;
    }
    const amount = D(c.total).abs().times(r.rate);
    if (isWithholding(c)) bucket.withholding = bucket.withholding.plus(amount);
    else bucket.fees = bucket.fees.plus(amount);
  }

  const years = Object.keys(byYear).sort((a, b) => b.localeCompare(a));
  // Aplazado pendiente al cierre de cada año = lo acumulado hasta ese año (el
  // arrastre de un lote a otro no cambia el total; solo aplazar y liberar).
  let running = 0;
  for (const year of [...years].reverse()) {
    running += flowByYear[year] || 0;
    byYear[year].stillDeferred = Math.abs(running) < 1e-9 ? 0 : running;
    byYear[year].noIsinCount = noIsinByYear[year] || 0;
  }
  for (const year of years) {
    const b = byYear[year];
    b.sales.sort((a, x) => a.isoDay.localeCompare(x.isoDay));
    b.dividends.sort((a, x) => a.isoDay.localeCompare(x.isoDay));
    b.missingFx.sort((a, x) => a.isoDay.localeCompare(x.isoDay));
    b.partialHistory.sort((a, x) => a.isoDay.localeCompare(x.isoDay));
    b.gains = b.gains.toNumber();
    b.losses = b.losses.toNumber();
    b.deferred = b.deferred.toNumber();
    b.released = b.released.toNumber();
    // Neto = Σ computable: ganancias + pérdidas propias computables − pérdidas
    // aplazadas que se integran este año.
    b.net = b.gains + b.losses - b.released;
    b.proceeds = b.proceeds.toNumber();
    b.acquisition = b.acquisition.toNumber();
    b.dividendsReceived = b.dividendsReceived.toNumber();
    b.fees = b.fees.toNumber();
    b.withholding = b.withholding.toNumber();
  }

  return { years, byYear, twoMonthRuleApplied: applyRule, pendingDeferred, stillDeferred: stillDeferredTotal };
}

/**
 * CSV export of one fiscal year (Spanish Excel dialect: ';' separator,
 * comma decimals). `labels` carries the translated headers so the module
 * stays i18n-agnostic. Las filas que no computan (sin tipo, sin historial de
 * compra) llevan las columnas de importe VACÍAS y una nota, nunca un 0.
 */
export function taxReportToCsv(yearData, year, labels = {}, { pendingDeferred = [] } = {}) {
  // Columnas y líneas de la regla de los dos meses solo si el informe la aplicó.
  const rule = !!yearData.twoMonthRule;
  const num = (v) => (Math.round(v * 100) / 100).toFixed(2).replace('.', ',');
  const rateNum = (v) => (v == null ? '' : Number(v).toFixed(6).replace('.', ','));
  const opt = (v, f = num) => (v == null ? '' : f(v));
  const esc = (v) => {
    const s = String(v ?? '');
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const sourceLabel = (s) => (s ? (labels.sources?.[s] ?? s) : '');
  const reasonLabel = (r) => labels.reasons?.[r] ?? r ?? '';
  const kindLabel = (k) => labels.kinds?.[k] ?? k;
  const lines = [];

  lines.push(`${esc(labels.title)};${year}`);
  lines.push('');
  lines.push(esc(labels.summary));
  lines.push(`${esc(labels.gains)};${num(yearData.gains)}`);
  lines.push(`${esc(labels.losses)};${num(yearData.losses)}`);
  if (rule) {
    lines.push(`${esc(labels.deferred)};${num(yearData.deferred || 0)}`);
    lines.push(`${esc(labels.released)};${num(yearData.released || 0)}`);
  }
  lines.push(`${esc(labels.net)};${num(yearData.net)}`);
  if (rule) lines.push(`${esc(labels.stillDeferred)};${num(yearData.stillDeferred || 0)}`);
  lines.push(`${esc(labels.proceeds)};${num(yearData.proceeds || 0)}`);
  lines.push(`${esc(labels.acquisition)};${num(yearData.acquisition || 0)}`);
  lines.push(`${esc(labels.dividendsReceived)};${num(yearData.dividendsReceived)}`);
  lines.push(`${esc(labels.withholding)};${num(yearData.withholding || 0)}`);
  lines.push(`${esc(labels.fees)};${num(yearData.fees)}`);
  // Limitaciones a la vista, con su recuento: no se esconden en el detalle.
  if (rule && yearData.noIsinCount > 0) lines.push(`${esc(labels.noIsinNote)};${yearData.noIsinCount}`);
  lines.push('');

  lines.push(esc(labels.salesSection));
  lines.push([
    labels.date, labels.asset, 'ISIN', labels.quantity, labels.price, labels.currency, labels.amount,
    labels.fxRate, labels.fxSource, labels.proceeds, labels.acquisition, labels.pnl,
    ...(rule ? [labels.deferred, labels.released, labels.computable] : []),
    labels.note,
  ].map(esc).join(';'));
  for (const s of yearData.sales) {
    const notes = [];
    if (s.status === 'missing_fx') notes.push(labels.missingFxNote);
    if (s.status === 'missing_buy_data') notes.push(labels.unreliableNote);
    // Con la regla computa la parte conocida; en la ruta sin `buys` no computa nada.
    if (s.status === 'partial_history') notes.push(s.profit == null ? labels.unreliableNote : labels.partialHistoryNote);
    lines.push([
      esc(s.fecha), esc(s.nombre), esc(s.isin),
      num(s.cantidad), num(s.precio), esc(s.moneda), num(s.total),
      opt(s.rate, rateNum), esc(sourceLabel(s.rateSource)),
      opt(s.proceeds), opt(s.acquisition), opt(s.profit),
      ...(rule ? [opt(s.deferred), opt(s.released), opt(s.computable)] : []),
      esc(notes.filter(Boolean).join(' · ')),
    ].join(';'));
  }
  lines.push('');

  lines.push(esc(labels.dividendsSection));
  lines.push([labels.date, labels.asset, 'ISIN', labels.currency, labels.fxRate, labels.fxSource, labels.amount].map(esc).join(';'));
  for (const d of yearData.dividends) {
    lines.push([
      esc(d.fecha), esc(d.nombre), esc(d.isin), esc(d.moneda),
      opt(d.rate, rateNum), esc(sourceLabel(d.rateSource)), num(d.amount),
    ].join(';'));
  }

  const missing = yearData.missingFx || [];
  if (missing.length > 0) {
    lines.push('');
    lines.push(`${esc(labels.missingFxSection)};${missing.length}`);
    lines.push([labels.kind, labels.date, labels.asset, 'ISIN', labels.currency, labels.amount, labels.fxDate, labels.reason].map(esc).join(';'));
    for (const m of missing) {
      lines.push([
        esc(kindLabel(m.kind)), esc(m.fecha), esc(m.nombre), esc(m.isin), esc(m.currency),
        num(m.amount), esc(m.date), esc(reasonLabel(m.reason)),
      ].join(';'));
    }
  }

  // Unidades vendidas sin compra en el historial: su importe NO está en los totales.
  const partial = yearData.partialHistory || [];
  if (partial.length > 0) {
    lines.push('');
    lines.push(`${esc(labels.partialHistorySection)};${partial.length}`);
    lines.push([labels.date, labels.asset, 'ISIN', labels.missingShares, labels.excludedProceeds].map(esc).join(';'));
    for (const ph of partial) {
      lines.push([
        esc(ph.fecha), esc(ph.nombre), esc(ph.isin), num(ph.missingShares), num(ph.excludedProceeds),
      ].join(';'));
    }
  }

  // Pérdidas aplazadas que siguen pendientes (a la fecha del último dato) y la
  // compra de reposición que las lleva: se integrarán al venderla de forma definitiva.
  if (rule && pendingDeferred.length > 0) {
    lines.push('');
    lines.push(`${esc(labels.pendingSection)};${pendingDeferred.length}`);
    lines.push([
      labels.pendingBuyDate, labels.asset, 'ISIN', labels.quantity, labels.pendingRemaining,
      labels.pendingShares, labels.pendingAmount,
    ].map(esc).join(';'));
    for (const p of pendingDeferred) {
      lines.push([
        esc(p.fecha), esc(p.nombre), esc(p.isin), num(p.qty), num(p.remainingQty),
        num(p.deferredShares), num(p.deferredAmount),
      ].join(';'));
    }
  }

  return lines.join('\n');
}
