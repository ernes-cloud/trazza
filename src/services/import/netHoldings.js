/**
 * Net holdings from parsed CSV transactions — extracted 1:1 from CarteraPage.
 *
 * Replays BUYs/SELLs (average cost) and the cash ledger per currency, honouring:
 *  - isConsolidated snapshots (when present they define holdings; ledger rows
 *    only drive cash)
 *  - isEndingCash snapshots (override the running cash total per currency,
 *    then post-snapshot rows are applied on top)
 *
 * Output: one row per open asset (qty, avg price, currency, currentPrice) plus
 * one CASH_XXX row per currency with balance (or an ending-cash snapshot).
 *
 * PURE: broker is an argument (needed by getAssetIdentifiers).
 */

import { getAssetIdentifiers } from './assetIdentity.js';

export function calculateNetBuys(transactions, broker) {
  if (!transactions || transactions.length === 0) return [];

  const assetStats = {};
  const cashByCurrency = {};

  const sorted = [...transactions].sort((a, b) => {
    const partA = (a.fecha || '01-01-1970').split('-');
    const partB = (b.fecha || '01-01-1970').split('-');
    const dateA = new Date(partA[2], partA[1] - 1, partA[0], ...(a.hora ? a.hora.split(':') : [0, 0]));
    const dateB = new Date(partB[2], partB[1] - 1, partB[0], ...(b.hora ? b.hora.split(':') : [0, 0]));
    return dateA - dateB;
  });

  const hasConsolidated = sorted.some(t => t.isConsolidated);
  const hasEndingCashByCur = {};
  const snapshots = sorted.filter(t => t.isEndingCash);
  const snapshotsByCur = {};
  snapshots.forEach(s => {
    snapshotsByCur[s.moneda] = s;
    hasEndingCashByCur[s.moneda] = true;
  });

  sorted.forEach(t => {
    const cur = (t.moneda || 'EUR').toUpperCase();
    if (!cashByCurrency[cur]) cashByCurrency[cur] = 0;

    // Handle Cash Accumulation
    if (!t.isConsolidated) {
      if (t.type === 'CASH' || t.transaction_type === 'CASH') {
        if (!t.isEndingCash && !hasEndingCashByCur[cur]) {
          cashByCurrency[cur] += (t.total !== undefined ? t.total : t.total_amount);
        }
      } else if (!hasEndingCashByCur[cur]) {
        if (t.type === 'BUY') cashByCurrency[cur] -= (t.cantidad * t.precio + (t.comisiones || 0));
        else if (t.type === 'SELL') cashByCurrency[cur] += (t.cantidad * t.precio - (t.comisiones || 0));
        else if (t.type === 'DIVIDEND') cashByCurrency[cur] += (t.total || 0);
        else if (t.type === 'FEE' || t.type === 'FEES' || t.type === 'TAX') cashByCurrency[cur] -= Math.abs(t.total || 0);
        else if (t.type === 'TRANSFER') cashByCurrency[cur] += (t.total || 0);
      }
    }

    // Handle Asset Accumulation
    if (t.type === 'BUY' || t.type === 'SELL') {
      if (hasConsolidated && !t.isConsolidated) return;

      const { key: tickerIdentifier, name, isin, exchange } = getAssetIdentifiers(t, broker);
      if (!assetStats[tickerIdentifier]) {
        assetStats[tickerIdentifier] = {
          qty: 0,
          totalCost: 0,
          name: name,
          producto: t.producto || '',  // preserve symbol so getAssetIdentifiers works on net results
          isin: isin,
          exchange: exchange,
          moneda: t.moneda || 'EUR',
          currentPrice: t.currentPrice,
          // La fila neta tiene que seguir siendo monetaria: el planner vuelve a
          // pedir su identidad con getAssetIdentifiers(net) y sin esto caería en
          // el ticker de la versión con participaciones.
          ...(t.noQuote === true ? { noQuote: true } : {}),
        };
      } else if (t.currentPrice !== undefined && t.currentPrice !== null) {
        assetStats[tickerIdentifier].currentPrice = t.currentPrice;
      }

      if (t.type === 'BUY') {
        assetStats[tickerIdentifier].qty += t.cantidad;
        // Commissions are in EUR even for USD/GBP stocks — adding them to a USD cost
        // basis mixes currencies and inflates the average price. Track price only.
        assetStats[tickerIdentifier].totalCost += (t.cantidad * t.precio);
      } else if (t.type === 'SELL') {
        const avgPrice = assetStats[tickerIdentifier].qty > 0 ? assetStats[tickerIdentifier].totalCost / assetStats[tickerIdentifier].qty : 0;
        assetStats[tickerIdentifier].qty -= t.cantidad;
        assetStats[tickerIdentifier].totalCost -= (t.cantidad * avgPrice);
      }
    }
  });

  // Snapshots Application
  Object.entries(snapshotsByCur).forEach(([cur, snapshot]) => {
    let balance = snapshot.total;
    const snapTime = new Date(snapshot.fecha.split('-').reverse().join('-') + 'T' + (snapshot.hora || '23:59:59'));
    sorted.forEach(t => {
      if (t.isEndingCash || (t.moneda || 'EUR').toUpperCase() !== cur) return;
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
    cashByCurrency[cur] = balance;
  });

  const results = Object.values(assetStats).map(net => ({
    ...net,
    precio: net.qty > 0 ? net.totalCost / net.qty : 0,
    total: net.qty * (net.currentPrice || (net.qty > 0 ? net.totalCost / net.qty : 0))
  })).filter(n => Math.abs(n.qty) > 0.0001);

  Object.entries(cashByCurrency).forEach(([cur, balance]) => {
    // Include zero-balance currencies that have an isEndingCash snapshot so a
    // CASH_ position is created in DB to carry the snapshot transaction forward.
    if (Math.abs(balance) > 0.001 || snapshotsByCur[cur]) {
      results.push({
        qty: balance,
        totalCost: balance,
        precio: 1,
        name: `Cash / Liquidity (${cur})`,
        isin: `CASH_${cur}`,
        ticker: `CASH_${cur}`,
        moneda: cur,
        type: 'CASH'
      });
    }
  });

  return results;
}
