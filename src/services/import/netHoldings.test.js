import { describe, it, expect } from 'vitest';
import { getAssetIdentifiers } from './assetIdentity';
import { calculateNetBuys } from './netHoldings';

// Tests de CARACTERIZACIÓN: fijan el comportamiento actual extraído 1:1 de
// CarteraPage. Si un cambio los rompe, está cambiando cómo se agrupan y casan
// posiciones en la DB — eso es un cambio de contrato, no un refactor.

describe('getAssetIdentifiers — identidad por broker', () => {
  it('DeGiro: clave ISIN_moneda y dbTicker "ISIN (CUR)"', () => {
    const t = { isin: 'US30303M1027', producto: 'META', moneda: 'USD', id_activo: 'US30303M1027' };
    const id = getAssetIdentifiers(t, 'degiro');
    expect(id.key).toBe('US30303M1027_USD');
    expect(id.dbTicker).toBe('US30303M1027 (USD)');
  });

  it('IBKR: incluye exchange en clave y dbTicker', () => {
    const t = { isin: 'US5949181045', producto: 'MSFT', moneda: 'USD', exchange: 'NASDAQ' };
    const id = getAssetIdentifiers(t, 'ibkr');
    expect(id.key).toBe('MSFT_US5949181045_USD_NASDAQ');
    expect(id.dbTicker).toBe('US5949181045 [NASDAQ] (USD)');
  });

  it('Binance: el ticker Yahoo va directo como dbTicker', () => {
    const t = { displayTicker: 'BTC-USD', producto: 'BTC', moneda: 'USD' };
    expect(getAssetIdentifiers(t, 'binance').dbTicker).toBe('BTC-USD');
  });

  it('Freeform: símbolo directo, pero CASH_ conserva formato DeGiro', () => {
    expect(getAssetIdentifiers({ producto: 'SAN.MC', moneda: 'EUR' }, 'freeform').dbTicker).toBe('SAN.MC');
    expect(getAssetIdentifiers({ producto: 'CASH_EUR', moneda: 'EUR' }, 'freeform').dbTicker).toBe('CASH_EUR (EUR)');
  });

  it('moneda ausente → EUR por defecto', () => {
    expect(getAssetIdentifiers({ isin: 'NL0010273215', id_activo: 'NL0010273215' }, 'degiro').dbTicker).toBe('NL0010273215 (EUR)');
  });
});

describe('calculateNetBuys — coste medio y ledger de caja', () => {
  const buy = (qty, price, extra = {}) => ({
    type: 'BUY', fecha: '01-01-2026', hora: '10:00', cantidad: qty, precio: price,
    isin: 'US0378331005', id_activo: 'US0378331005', producto: 'AAPL', moneda: 'USD', total: -(qty * price), ...extra,
  });
  const sell = (qty, price, extra = {}) => ({
    type: 'SELL', fecha: '02-01-2026', hora: '10:00', cantidad: qty, precio: price,
    isin: 'US0378331005', id_activo: 'US0378331005', producto: 'AAPL', moneda: 'USD', total: qty * price, ...extra,
  });

  it('compras acumulan a coste medio; ventas reducen a coste medio', () => {
    const result = calculateNetBuys([buy(2, 100), buy(2, 200), sell(1, 500)], 'degiro');
    const pos = result.find(r => r.isin === 'US0378331005');
    expect(pos.qty).toBe(3);
    expect(pos.precio).toBeCloseTo(150, 6); // avg (2×100 + 2×200)/4 = 150, sell at avg keeps it
  });

  it('posición totalmente vendida no aparece (qty ≈ 0)', () => {
    const result = calculateNetBuys([buy(2, 100), sell(2, 150)], 'degiro');
    expect(result.find(r => r.isin === 'US0378331005')).toBeUndefined();
  });

  it('la caja refleja compras (−), ventas (+) y dividendos (+) por divisa', () => {
    const div = { type: 'DIVIDEND', fecha: '03-01-2026', cantidad: 0, precio: 0, moneda: 'USD', total: 10 };
    const result = calculateNetBuys([buy(1, 100, { comisiones: 2 }), div], 'degiro');
    const cash = result.find(r => r.ticker === 'CASH_USD');
    expect(cash.qty).toBeCloseTo(-92, 6); // −(100 + 2) + 10
  });

  it('un snapshot isEndingCash manda sobre el acumulado y aplica filas posteriores', () => {
    const snapshot = { type: 'CASH', isEndingCash: true, fecha: '02-01-2026', hora: '23:59:59', moneda: 'EUR', total: 500 };
    const laterFee = { type: 'FEE', fecha: '03-01-2026', cantidad: 0, precio: 0, moneda: 'EUR', total: -5 };
    const earlierDeposit = { type: 'TRANSFER', fecha: '01-01-2026', cantidad: 0, precio: 0, moneda: 'EUR', total: 9999 };
    const result = calculateNetBuys([earlierDeposit, snapshot, laterFee], 'degiro');
    const cash = result.find(r => r.ticker === 'CASH_EUR');
    expect(cash.qty).toBeCloseTo(495, 6); // 500 (snapshot) − 5 (post-snapshot fee); el depósito anterior NO suma
  });

  it('modo consolidado: los snapshots definen la cartera, las filas sueltas no', () => {
    const consolidated = { ...buy(10, 50), isConsolidated: true };
    const ledgerBuy = buy(999, 1); // must be ignored for holdings when consolidated present
    const result = calculateNetBuys([consolidated, ledgerBuy], 'degiro');
    const pos = result.find(r => r.isin === 'US0378331005');
    expect(pos.qty).toBe(10);
  });

  it('entrada vacía → []', () => {
    expect(calculateNetBuys([], 'degiro')).toEqual([]);
    expect(calculateNetBuys(null, 'degiro')).toEqual([]);
  });
});
