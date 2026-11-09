/**
 * Calculadora pública de plusvalías — PURA y testeada.
 *
 * Entran compras y ventas (de uno o varios valores) y sale, por cada venta, la
 * ganancia o pérdida con coste FIFO y, por año, lo que se integra en la base
 * del ahorro y la cuota estimada.
 *
 * - FIFO: el de siempre, `FIFOCalculator` (services/fifoAnalytics). Aquí solo
 *   se le pasan precios EFECTIVOS: la comisión de compra suma al coste y la de
 *   venta resta del importe (art. 35 LIRPF).
 * - Regla de los dos meses (art. 33.5.f LIRPF, valores cotizados): la pérdida
 *   no se computa si se compran valores homogéneos en los dos meses anteriores
 *   o posteriores; si se recompra menos de lo vendido, solo se aplaza la parte
 *   proporcional. Se integra "a medida que se transmitan los valores que
 *   permanezcan en el patrimonio", y solo cuando se transmiten DE FORMA
 *   DEFINITIVA (manual de la AEAT, Renta 2025): si al venderlas se vuelve a
 *   comprar el mismo valor en los dos meses anteriores o posteriores, la pérdida
 *   sigue aplazada y pasa a esas nuevas acciones.
 * - Todo en euros: la conversión de divisa al cambio de cada fecha la hace el
 *   usuario (la página lo explica).
 *
 * Desde 2026-10-22 la regla (FIFO + dos meses) vive en services/tax/twoMonthRule,
 * compartida con el informe fiscal de la app. Esto es un envoltorio fino:
 * valida, pasa a importes efectivos, llama al núcleo y resume por año. La
 * salida es idéntica a la de antes (capitalGains.equivalence.test.js).
 */
import { applyTwoMonthRule } from '@/services/tax/twoMonthRule';
import { incrementalSavingsTax } from './savingsTax';

export { addMonths } from '@/services/tax/twoMonthRule';

const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

const isIsoDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const assetKey = (name) => String(name || '').trim().toUpperCase() || '—';

/**
 * Normaliza y valida. Las filas inválidas no entran en el cálculo y se
 * devuelven en `invalid` (id + motivo) para marcarlas en la tabla.
 */
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
  // Por fecha; el mismo día respeta el orden en que se escribieron.
  valid.sort((a, b) => (a.date === b.date ? a.index - b.index : a.date < b.date ? -1 : 1));
  return { valid, invalid };
}

/**
 * @param {Array<{ id: string, asset: string, type: 'buy'|'sell', date: string, qty: number, price: number, fee?: number }>} operations
 * @param {{ otherSavingsIncome?: number }} [opts]  otros rendimientos del ahorro del año (dividendos, intereses)
 */
export function computeCapitalGains(operations, { otherSavingsIncome = 0 } = {}) {
  const { valid, invalid } = prepare(operations || []);

  // Importes efectivos (art. 35 LIRPF): la comisión de compra suma al coste y
  // la de venta resta del importe.
  const core = applyTwoMonthRule(valid.map((op) => (op.type === 'buy'
    ? { id: op.id, key: op.key, type: 'buy', date: op.date, qty: op.qty, unitCostEur: (op.qty * op.price + op.fee) / op.qty }
    : { id: op.id, key: op.key, type: 'sell', date: op.date, qty: op.qty, netProceedsEur: Math.max(0, op.qty * op.price - op.fee) })));

  const sellOps = valid.filter((op) => op.type !== 'buy');
  const oversold = [];
  const sales = core.sales.map((s, i) => {
    const op = sellOps[i];
    if (s.missingShares > 0) oversold.push({ id: s.id, missing: s.missingShares });
    return {
      id: s.id,
      asset: String(op.asset || '').trim() || '—',
      date: s.date,
      year: Number(s.date.slice(0, 4)),
      qty: s.qty,
      proceeds: round2(s.proceeds),
      cost: round2(s.proceeds - s.gain),
      gain: round2(s.gain),
      deferred: round2(s.deferred),
      released: round2(s.released),
      computable: round2(s.computable),
      lots: s.lots,
      blockedBy: s.blockedBy,
    };
  });

  // ── Resumen por año ──────────────────────────────────────────────────────
  const byYear = new Map();
  for (const s of sales) {
    const y = byYear.get(s.year) || { year: s.year, gains: 0, losses: 0, deferred: 0, released: 0, sales: 0 };
    const own = s.gain + s.deferred; // resultado propio computable (sin liberaciones)
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

  return { sales, years, invalid, oversold, stillDeferred: round2(core.stillDeferred) };
}
