/**
 * Piezas PURAS de la carga del Dashboard (`hooks/useDashboardData`). Vivían
 * inline dentro de `loadDashboardData`; aquí se pueden testear sin Supabase ni
 * Yahoo. La matemática compartida con la pantalla de brokers sigue en
 * `portfolioHistory` / `portfolioStats`: esto es solo lo que es propio del
 * Dashboard.
 */
import { FIFOCalculator } from './fifoAnalytics.js';
import { resolveQuoteSymbol } from './quoteSymbol.js';
import { isMonetaryAssetTicker } from './import/assetIdentity.js';
import { getFundExposure } from './fundExposure.js';
import { assetDisplayName } from './assetDisplayName.js';

const rateFor = (cur, currency, rates) => (cur === currency ? 1 : (rates[cur] || 1));

// Las filas de imported_data llevan `fecha` DD-MM-YYYY y `hora` HH:MM.
const csvTimeMs = (t) => {
  const parts = (t.fecha || '01-01-1970').split('-');
  const [d, m, y] = parts.length === 3 ? parts : ['01', '01', '1970'];
  const [hh = 0, mm = 0] = (t.hora || '00:00').split(':').map(Number);
  return new Date(+y, +m - 1, +d, hh, mm).getTime();
};

/**
 * Totales de las transacciones de brokers con CSV cargado pero SIN guardar (solo
 * viven en `imported_data`). Los brokers guardados ya están en la tabla
 * `transactions` y no deben pasar por aquí: contarlos en los dos sitios
 * duplicaría cada operación.
 *
 * Las comisiones (`totalFees` de filas FEE/TAX y `embeddedComisiones` de las
 * filas BUY/SELL) se devuelven en BRUTO: van facturadas en EUR y el llamante las
 * convierte con el tipo del EUR, igual que la pantalla de brokers.
 *
 * @param {Array<object>} csvTrans  filas de imported_data de brokers sin guardar
 * @param {string} currency  divisa de la cartera
 * @param {Record<string, number>} rates  divisa → tipo a `currency`
 * @returns {{ realizedGain:number, totalDivs:number, totalFees:number,
 *   embeddedComisiones:number, costBasis:number, totalBuyCost:number,
 *   firstBuyDate:string|null }}
 */
export function computeUnsavedCsvTotals(csvTrans, currency, rates) {
  const out = {
    realizedGain: 0, totalDivs: 0, totalFees: 0, embeddedComisiones: 0,
    costBasis: 0, totalBuyCost: 0, firstBuyDate: null,
  };
  if (!csvTrans?.length) return out;

  const sorted = [...csvTrans].sort((a, b) => csvTimeMs(a) - csvTimeMs(b));
  const fifo = new FIFOCalculator();
  const assetStats = {};

  sorted.forEach((t) => {
    const type = t.type || t.transaction_type;
    const cur = (t.moneda || 'EUR').toUpperCase();
    const rate = rateFor(cur, currency, rates);
    const qty = parseFloat(t.cantidad || t.quantity || 0);
    const price = parseFloat(t.precio || t.price || 0);
    const isCash = type === 'CASH' || (t.isin || '').startsWith('CASH') || (t.producto || '').startsWith('CASH');
    if (isCash) return;

    const trade = { isin: t.isin, producto: t.producto || t.ticker, cantidad: qty, precio: price, moneda: cur };
    const key = `${t.isin || t.producto}_${cur}`;

    if (type === 'BUY' && qty > 0) {
      if (!assetStats[key]) assetStats[key] = { qty: 0, totalCost: 0, moneda: cur };
      assetStats[key].qty += qty;
      assetStats[key].totalCost += qty * price;
      fifo.processBuy(trade);
      out.totalBuyCost += qty * price * rate;
      if (t.fecha) {
        const parts = t.fecha.split('-');
        if (parts.length === 3) {
          const [d, m, y] = parts;
          const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
          if (!out.firstBuyDate || iso < out.firstBuyDate) out.firstBuyDate = iso;
        }
      }
      out.embeddedComisiones += Math.abs(parseFloat(t.comisiones || 0));
    } else if (type === 'SELL' && qty > 0) {
      if (assetStats[key]) {
        const avg = assetStats[key].qty > 0 ? assetStats[key].totalCost / assetStats[key].qty : 0;
        assetStats[key].qty = Math.max(0, assetStats[key].qty - qty);
        assetStats[key].totalCost = Math.max(0, assetStats[key].totalCost - qty * avg);
      }
      out.realizedGain += fifo.processSell(trade).profit * rate;
      out.embeddedComisiones += Math.abs(parseFloat(t.comisiones || 0));
    } else if (type === 'DIVIDEND') {
      out.totalDivs += parseFloat(t.total || t.total_amount || 0) * rate;
    } else if (['FEE', 'FEES', 'TAX'].includes(type)) {
      out.totalFees += Math.abs(parseFloat(t.total || t.total_amount || 0));
    }
  });

  out.costBasis = Object.values(assetStats)
    .filter((a) => a.qty > 0.00001)
    .reduce((sum, a) => sum + a.totalCost * rateFor(a.moneda, currency, rates), 0);
  return out;
}

/**
 * Agrupa las posiciones invertidas por ticker RESUELTO para el treemap: la misma
 * acción en varios brokers es una baldosa. Cada grupo guarda sus `members` (un
 * asset_id, divisa y cantidad por sub-posición), porque el mismo ticker puede
 * estar en dos divisas: un solo representante valoraba mal el grupo y dejaba sin
 * precio los assets del resto de brokers.
 *
 * El ticker sale de `resolveQuoteSymbol`, la MISMA resolución que brokers: con
 * `resolveTicker` a secas un fondo de MyInvestor se quedaba con su nombre y el
 * Wallet Map no podía cotizarlo.
 *
 * @param {Array} investedAssets
 * @param {Record<string,string>} [dynamicTickerMap]  `imported_data.ticker_map` unido
 * @returns {Array<{ ticker, name, quantity, currency, isFund, members }>}
 */
export function groupInvestedByTicker(investedAssets, dynamicTickerMap = {}) {
  const groups = investedAssets.reduce((acc, pos) => {
    const resolved = resolveQuoteSymbol(pos.assets?.ticker, dynamicTickerMap);
    const key = resolved || pos.assets?.ticker || 'UNKNOWN';
    if (!acc[key]) {
      acc[key] = {
        ticker: resolved,
        name: assetDisplayName(pos.assets),
        quantity: 0,
        currency: pos.assets?.currency || 'EUR',
        members: [],
        // Los fondos enseñan su NOMBRE en la baldosa: su ticker es un ISIN o un
        // listado (FEPA.MU) que no le dice nada al usuario.
        isFund: !!getFundExposure(pos.assets),
        isMonetary: isMonetaryAssetTicker(pos.assets?.ticker),
      };
    } else if (!acc[key].name || acc[key].name === acc[key].ticker) {
      if (pos.assets?.company_name) acc[key].name = assetDisplayName(pos.assets);
    }
    acc[key].quantity += parseFloat(pos.quantity || 0);
    acc[key].members.push({
      asset_id: pos.asset_id,
      currency: pos.assets?.currency || 'EUR',
      dbPrice: pos.assets?.current_price,
      quantity: parseFloat(pos.quantity || 0),
    });
    return acc;
  }, {});
  return Object.values(groups);
}
