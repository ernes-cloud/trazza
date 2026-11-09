import { FIFOCalculator } from '../fifoAnalytics.js';
import { csvRowsNotInDb } from '../../lib/importDedupe.js';
import { resolveTicker } from '../../lib/tickerMap.js';

// CSV↔DB reconciliation for the brokers screen — extracted VERBATIM from the
// ~510-line useMemo in CarteraPage (fase 2 del split). Pure function of its
// inputs: no React, no Supabase, Node-compatible relative imports (same
// convention as portfolioHistory.js) so it runs offline under Vitest.
//
// Consumers: CarteraPage memo → RealizedPnLTable / TransactionListCard rows,
// importTotals for computePortfolioStats, and the monthly analytics charts.

const EMPTY_RESULT = {
  netBuys: [],
  salesWithPL: [],
  dividends: [],
  commissions: [],
  cashTransfers: [],
  totals: { salesTotal: 0, dividendsTotal: 0, commissionsTotal: 0, cashTotal: 0, cashBreakdown: {}, commissionsBreakdown: {} },
  charts: { salesChartData: [], dividendsChartData: [], commissionsChartData: [] },
};

/**
 * @param {object} inputs
 *   importedTransactions  parsed CSV rows for the selected scope (broker or general)
 *   dbTransactions        transformed DB rows (isFromDB: true) for the same scope
 *   dynamicTickerMap      session name/ISIN → quote-symbol map
 *   importPrices          displayTicker → live price (preview quotes)
 *   exchangeRates         currency → preferredCurrency spot rates
 */
/**
 * Moneda en la que se factura una comisión. Una sola regla para la pantalla
 * de brokers y el informe fiscal:
 * - comisión de COMPRAVENTA (se crea copiando la operación, así que hereda la
 *   moneda de la ACCIÓN): DEGIRO/IBKR la facturan en EUR → 'EUR';
 * - comisión SUELTA (FEE/TAX propia): su moneda real.
 * Antes el informe fiscal forzaba EUR también en las sueltas y sumaba 1,50 $
 * como 1,50 € (14,00 € contra los 13,83 € de la pantalla).
 * @param {{ moneda?: string, isTradeCommission?: boolean }} c
 * @returns {string}
 */
export function commissionCurrency(c) {
  if (c?.isTradeCommission) return 'EUR';
  return c?.moneda || 'EUR';
}

export function computeProcessedImportData({
  importedTransactions,
  dbTransactions,
  dynamicTickerMap = {},
  importPrices = {},
  exchangeRates = {},
}) {
  // Deduplicate: skip CSV transactions that are already persisted in DB.
  // Key = fecha + hora + type + isin + rounded-qty (previewTxKey — price at 2
  // decimals for BUY/SELL so DB scale-2 prices match raw CSV precision).
  // MULTISET semantics (csvRowsNotInDb): each stored row consumes ONE identical
  // CSV row — surplus identical partial fills SURVIVE, so netBuys counts them
  // and the re-sync self-repair of half-cost-basis DBs actually converges.
  const csvOnly = csvRowsNotInDb(importedTransactions || [], dbTransactions || []);
  const transactions = [
    ...(dbTransactions || []),
    ...csvOnly
  ];

  if (transactions.length === 0) return { ...EMPTY_RESULT };

  const assetStats = {};
  const sorted = [...transactions].sort((a, b) => {
    const partA = (a.fecha || '01-01-1970').split('-');
    const partB = (b.fecha || '01-01-1970').split('-');
    const dateA = new Date(partA[2], partA[1] - 1, partA[0], ...(a.hora ? a.hora.split(':') : [0, 0]));
    const dateB = new Date(partB[2], partB[1] - 1, partB[0], ...(b.hora ? b.hora.split(':') : [0, 0]));
    return dateA - dateB;
  });

  const salesWithPL = [];
  const dividends = [];
  const commissions = [];
  const cashTransfers = [];
  const buys = [];
  const monthlySales = {};
  let csvBuyTotal = 0;

  const cashByCurrency = {};

  const hasConsolidated = sorted.some(t => t.isConsolidated);
  const officialNAVEntry = sorted.find(t => t.isNAV);

  const fifo = new FIFOCalculator();

  sorted.forEach(t => {
    const cur = (t.moneda || 'EUR').toUpperCase();
    const tickerIdentifier = `${t.id_activo || t.producto || t.name || t.isin}_${cur}`;

    if (t.type === 'Cash' || t.type === 'CASH') {
      cashTransfers.push(t);
    } else {
      if (hasConsolidated && (t.type === 'BUY' || t.type === 'SELL') && !t.isConsolidated) {
        // Skip historical trades if consolidated view is active
      } else if (!assetStats[tickerIdentifier]) {
        const baseIdentifier = t.isin || t.producto;
        let displayTicker = dynamicTickerMap[baseIdentifier] || resolveTicker(baseIdentifier);
        assetStats[tickerIdentifier] = {
          qty: 0,
          totalCost: 0,
          name: t.nombre || t.name || t.producto,
          isin: t.isin,
          fecha: t.fecha,
          hora: t.hora,
          moneda: t.moneda || 'EUR',
          displayTicker,
          currentPrice: t.currentPrice
        };
      }

      if (t.type === 'BUY') {
        if (!t.isConsolidated && t.cantidad > 0) {
          fifo.processBuy(t);
        }

        buys.push(t);
        const shouldUpdateAsset = !hasConsolidated || t.isConsolidated;
        if (shouldUpdateAsset) {
          assetStats[tickerIdentifier].qty += t.cantidad;
          const lineCost = t.cantidad * t.precio;
          assetStats[tickerIdentifier].totalCost += lineCost;
          assetStats[tickerIdentifier].fecha = t.fecha;
          assetStats[tickerIdentifier].hora = t.hora;
        }
        if (!t.isFromDB && t.cantidad > 0) {
          const rate = exchangeRates[t.moneda || 'EUR'] || 1;
          csvBuyTotal += (t.cantidad * t.precio) * rate;
        }
        if (t.comisiones > 0) {
          commissions.push({
            ...t,
            type: 'FEE',
            total: t.comisiones,
            isTradeCommission: true,
            descripcion: `Comisión Compra: ${t.nombre || t.producto}`
          });
        }
      } else if (t.type === 'SELL') {
        let profitInfo = { avgBuyPrice: 0, profit: 0, profitPercent: 0, isMissingBuyData: true, sharesMissingHistory: t.cantidad, lots: [] };
        if (!t.isConsolidated && t.cantidad > 0) {
          profitInfo = fifo.processSell(t);
        }

        salesWithPL.push({
          ...t,
          avgBuyPrice: profitInfo.avgBuyPrice,
          profit: profitInfo.profit,
          profitPercent: profitInfo.profitPercent,
          isMissingBuyData: profitInfo.isMissingBuyData,
          sharesMissingHistory: profitInfo.sharesMissingHistory,
          // Lotes FIFO consumidos: el informe fiscal convierte cada uno al tipo
          // de SU fecha de compra (AEAT), no el profit neto al de la venta.
          lots: profitInfo.lots,
          total: t.cantidad * t.precio
        });

        // Accumulate monthly P&L here using profitInfo directly — avoids the
        // fecha+hora+isin find below that double-counts when two sells share the same timestamp.
        {
          const parts = (t.fecha || '01-01-1970').split('-');
          const sMonth = `${parts[2]}-${parts[1]}`;
          if (!monthlySales[sMonth]) monthlySales[sMonth] = 0;
          monthlySales[sMonth] += profitInfo.profit * (exchangeRates[t.moneda || 'EUR'] || 1);
        }

        const shouldUpdateAsset = !hasConsolidated || t.isConsolidated;
        if (shouldUpdateAsset && assetStats[tickerIdentifier]) {
          const avgPrice = assetStats[tickerIdentifier]?.qty > 0 ? assetStats[tickerIdentifier].totalCost / assetStats[tickerIdentifier].qty : 0;
          assetStats[tickerIdentifier].qty -= t.cantidad;
          assetStats[tickerIdentifier].totalCost -= (t.cantidad * avgPrice);
        }
        if (t.comisiones > 0) {
          commissions.push({
            ...t,
            type: 'FEE',
            total: t.comisiones,
            isTradeCommission: true,
            descripcion: `Comisión Venta: ${t.nombre || t.producto}`
          });
        }
      } else if (t.type === 'DIVIDEND') {
        dividends.push(t);
      } else if (t.type === 'FEE' || t.type === 'FEES' || t.type === 'TAX') {
        commissions.push(t);
      }
    }
  });

  // --- ISOLATED MULTI-BROKER CASH CALCULATION ---
  const transByBroker = sorted.reduce((acc, t) => {
    const bId = t.positions?.broker_id || t.broker_id || 'manual';
    if (!acc[bId]) acc[bId] = [];
    acc[bId].push(t);
    return acc;
  }, {});

  Object.entries(transByBroker).forEach(([bId, brokerTrans]) => {
    const brokerCashByCur = {};
    const hasEndingCashByCur = {};

    const snapshots = brokerTrans.filter(t => t.isEndingCash);
    const brokerSnapshotsByCur = {};
    snapshots.forEach(s => {
      brokerSnapshotsByCur[s.moneda] = s;
      hasEndingCashByCur[s.moneda] = true;
    });

    // Pass 1: Accumulation for currencies WITHOUT a snapshot
    brokerTrans.forEach(t => {
      const cur = (t.moneda || 'EUR').toUpperCase();
      if (!brokerCashByCur[cur]) brokerCashByCur[cur] = 0;

      if (!t.isConsolidated) {
        if (t.type === 'CASH' || t.transaction_type === 'CASH') {
          if (!t.isEndingCash && !hasEndingCashByCur[cur]) {
            brokerCashByCur[cur] += (t.total !== undefined ? t.total : t.total_amount);
          }
        } else if (!hasEndingCashByCur[cur]) {
          // ONLY subtract/add if no snapshot is present for THIS currency
          if (t.type === 'BUY') brokerCashByCur[cur] -= (t.cantidad * t.precio + (t.comisiones || 0));
          else if (t.type === 'SELL') brokerCashByCur[cur] += (t.cantidad * t.precio - (t.comisiones || 0));
          else if (t.type === 'DIVIDEND') brokerCashByCur[cur] += (t.total || 0);
          else if (t.type === 'FEE' || t.type === 'FEES' || t.type === 'TAX') brokerCashByCur[cur] -= Math.abs(t.total || 0);
          else if (t.type === 'TRANSFER') brokerCashByCur[cur] += (t.total || 0);
        }
      }
    });

    // Pass 2: Snapshot refinement (for currencies WITH a snapshot)
    Object.entries(brokerSnapshotsByCur).forEach(([cur, snapshot]) => {
      let balance = snapshot.total;
      const snapTime = new Date(snapshot.fecha.split('-').reverse().join('-') + 'T' + (snapshot.hora || '23:59:59'));

      brokerTrans.forEach(t => {
        if (t.isEndingCash || t.moneda !== cur) return;
        const tDate = new Date(t.fecha.split('-').reverse().join('-') + 'T' + (t.hora || '00:00:00'));
        if (tDate > snapTime && !t.isConsolidated) {
          if (t.type === 'CASH' || t.transaction_type === 'CASH') balance += (t.total !== undefined ? t.total : t.total_amount);
          else if (t.type === 'BUY') balance -= (t.cantidad * t.precio + (t.comisiones || 0));
          else if (t.type === 'SELL') balance += (t.cantidad * t.precio - (t.comisiones || 0));
          else if (t.type === 'DIVIDEND') balance += (t.total || 0);
          else if (t.type === 'FEE' || t.type === 'FEES' || t.type === 'TAX') balance -= Math.abs(t.total || 0);
          else if (t.type === 'TRANSFER') balance += (t.total || 0);
        }
      });
      brokerCashByCur[cur] = balance;
    });

    // Add to global
    Object.entries(brokerCashByCur).forEach(([cur, bal]) => {
      cashByCurrency[cur] = (cashByCurrency[cur] || 0) + bal;
    });
  });

  const netBuys = Object.values(assetStats)
    .filter(a => a.qty > 0.00000001 || a.type === 'CASH') // Permite ver Cash en negativo (deuda)
    .map(a => {
      // AUDIT RULE: Total Neto must show Market Value = Qty * Current Price
      const priceForValuation = importPrices[a.displayTicker || a.isin || a.producto] || a.currentPrice || a.precio || 0;
      return {
        ...a,
        precio: a.qty > 0 ? a.totalCost / a.qty : 0, // Cost Basis Price
        total: a.qty * priceForValuation, // Market Value
        producto: a.name,
        type: 'BUY'
      };
    });

  // Rule 4: Add calculated Liquidity (Cash) to the breakdown
  Object.entries(cashByCurrency).forEach(([cur, balance]) => {
    const cleanCur = cur.trim().toUpperCase();
    if (Math.abs(balance) > 0.001) {
      netBuys.push({
        qty: balance,
        totalCost: balance,
        precio: 1,
        name: `Cash / Liquidity (${cleanCur})`,
        producto: `Cash / Liquidity (${cleanCur})`,
        isin: `CASH_${cleanCur}`,
        ticker: `CASH_${cleanCur}`,
        moneda: cleanCur,
        type: 'CASH',
        displayTicker: cleanCur
      });
    }
  });

  // Calculate Totals, Monthly Data and Portfolio Growth
  const salesTotal = salesWithPL.reduce((sum, s) => {
    const rate = exchangeRates[s.moneda] || 1;
    return sum + (s.profit * rate);
  }, 0);
  const dividendsTotal = dividends.reduce((sum, d) => {
    const rate = exchangeRates[d.moneda] || 1;
    return sum + (d.total * rate);
  }, 0);

  // CSV-only variants (rows NOT in the DB — i.e. unsaved brokers after dedupe).
  // The stats layer ADDS these to the DB totals: the old `db || csv` fallback dropped
  // unsaved brokers' realized/dividends in the general view as soon as ANY broker
  // had DB history, making "Ganancia Total" differ between general and broker tabs.
  const salesTotalCsvOnly = salesWithPL.reduce((sum, s) => {
    if (s.isFromDB) return sum;
    return sum + (s.profit * (exchangeRates[s.moneda] || 1));
  }, 0);
  const dividendsTotalCsvOnly = dividends.reduce((sum, d) => {
    if (d.isFromDB) return sum;
    return sum + (d.total * (exchangeRates[d.moneda] || 1));
  }, 0);

  // Group commissions by currency for multi-currency display.
  // DeGiro/IBKR commissions are always invoiced in EUR regardless of the stock's trading
  // currency, so we always use 'EUR' as the grouping key to avoid multiplying EUR fees by
  // a non-EUR exchange rate (e.g. a €3 fee on a USD stock must NOT be × USDEUR ≈ 0.91).
  const commissionsBreakdown = {};
  commissions.forEach(c => {
    // Skip DB rows: standalone FEE/TAX rows from the DB are already counted in
    // historyTotals.fees (and BUY/SELL commissions in historyTotals.tradeCommissions).
    // Counting them here too double-counted fees in the header stats.
    if (c.isFromDB) return;
    const cur = commissionCurrency(c);
    if (!commissionsBreakdown[cur]) commissionsBreakdown[cur] = 0;
    commissionsBreakdown[cur] += Math.abs(c.total);
  });

  // SUM ALL COMMISSIONS converting to preferred currency
  const commissionsTotal = Object.entries(commissionsBreakdown).reduce((sum, [cur, val]) => {
    const rate = exchangeRates[cur] || 1;
    return sum + (val * rate);
  }, 0);

  const cashTotal = Object.entries(cashByCurrency).reduce((sum, [cur, val]) => {
    const rate = exchangeRates[cur] || 1;
    return sum + (val * rate);
  }, 0);

  // Group by month helper (YYYY-MM)
  const getMonth = (fecha) => {
    const parts = fecha.split('-');
    return `${parts[2]}-${parts[1]}`;
  };

  const monthlyDividends = {};
  const monthlyCommissions = {};
  const monthlyNetFlow = {}; // Buys - Sells + Div - Comm

  sorted.forEach(t => {
    const month = getMonth(t.fecha);
    if (!monthlyNetFlow[month]) monthlyNetFlow[month] = 0;

    if (t.type === 'BUY') {
      monthlyNetFlow[month] -= (t.cantidad * t.precio);
      if (t.comisiones > 0) {
        if (!monthlyCommissions[month]) monthlyCommissions[month] = 0;
        monthlyCommissions[month] += t.comisiones;
        monthlyNetFlow[month] -= t.comisiones;
      }
    } else if (t.type === 'SELL') {
      // monthlySales already accumulated in the first sorted.forEach using profitInfo directly.
      monthlyNetFlow[month] += (t.cantidad * t.precio);
      if (t.comisiones > 0) {
        if (!monthlyCommissions[month]) monthlyCommissions[month] = 0;
        monthlyCommissions[month] += t.comisiones;
        monthlyNetFlow[month] -= t.comisiones;
      }
    } else if (t.type === 'DIVIDEND') {
      const divRate = exchangeRates[t.moneda || 'EUR'] || 1;
      if (!monthlyDividends[month]) monthlyDividends[month] = 0;
      monthlyDividends[month] += t.total * divRate;
      monthlyNetFlow[month] += t.total;
    } else if (t.type === 'FEE' || t.type === 'FEES' || t.type === 'TAX') {
      if (!monthlyCommissions[month]) monthlyCommissions[month] = 0;
      monthlyCommissions[month] += Math.abs(t.total);
      monthlyNetFlow[month] -= Math.abs(t.total);
    }
  });

  const allMonths = Object.keys(monthlyNetFlow).sort();

  // Performance charts by month
  const salesChartData = allMonths.map(m => ({ name: m, value: monthlySales[m] || 0 }));
  const dividendsChartData = allMonths.map(m => ({ name: m, value: monthlyDividends[m] || 0 }));
  const commissionsChartData = allMonths.map(m => ({ name: m, value: monthlyCommissions[m] || 0 }));

  return {
    netBuys,
    buys: [...buys].reverse(),
    salesWithPL: [...salesWithPL].reverse(),
    dividends: [...dividends].reverse(),
    commissions: [...commissions].reverse(),
    cashTransfers: [...cashTransfers].reverse(),
    totals: {
      salesTotal,
      dividendsTotal,
      salesTotalCsvOnly,
      dividendsTotalCsvOnly,
      commissionsTotal,
      cashTotal,
      csvBuyTotal,
      commissionsBreakdown,
      cashBreakdown: cashByCurrency,
      officialNAV: officialNAVEntry?.total
    },
    charts: { salesChartData, dividendsChartData, commissionsChartData }
  };
}
