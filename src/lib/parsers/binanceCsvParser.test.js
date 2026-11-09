import { describe, it, expect } from 'vitest';
import { parseBinanceCSV } from './binanceCsvParser.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

const TRADE_HDR = 'time,base-asset,quote-asset,type,price,quantity,total,fee,fee-currency,trade-id';
const TXN_HDR_EN = 'User_ID,UTC_Time,Account,Operation,Coin,Change,Remark';
const TXN_HDR_ES = 'ID de usuario,Tiempo,Cuenta,Operación,Moneda,Cambio,Observación';

const tradeCsv  = (...rows) => [TRADE_HDR, ...rows].join('\n');
const txnCsvEn  = (...rows) => [TXN_HDR_EN, ...rows].join('\n');
const txnCsvEs  = (...rows) => [TXN_HDR_ES, ...rows].join('\n');

// ─── Format A: Trade History ──────────────────────────────────────────────────

describe('Trade History — BUY with fee in base asset', () => {
  // BTC/USDT buy: fee paid in BTC (the crypto being purchased).
  // Net quantity = qty − feeInBase; commission = fee × price (converts BTC fee to USD).
  const csv = tradeCsv('2024-01-15 10:30:00,BTC,USDT,BUY,45000,0.1,4500,0.0001,BTC,111111');

  it('produces exactly one BUY transaction', () => {
    const result = parseBinanceCSV(csv);
    expect(result.filter(t => t.type === 'BUY')).toHaveLength(1);
  });

  it('sets ticker to Yahoo Finance format (BTC-USD)', () => {
    const [tx] = parseBinanceCSV(csv);
    expect(tx.producto).toBe('BTC-USD');
    expect(tx.isin).toBe('BTC-USD');
  });

  it('deducts fee in base asset from the net quantity', () => {
    const [tx] = parseBinanceCSV(csv);
    // 0.1 − 0.0001 = 0.0999
    expect(tx.cantidad).toBeCloseTo(0.0999, 6);
  });

  it('converts base-asset fee to USD using the trade price', () => {
    const [tx] = parseBinanceCSV(csv);
    // fee=0.0001 BTC × price=45000 USD/BTC = 4.5 USD
    expect(tx.comisiones).toBeCloseTo(4.5, 4);
  });

  it('sets moneda to USD for a USDT-quoted trade', () => {
    const [tx] = parseBinanceCSV(csv);
    expect(tx.moneda).toBe('USD');
  });

  it('marks the transaction as isConsolidated', () => {
    const [tx] = parseBinanceCSV(csv);
    expect(tx.isConsolidated).toBe(true);
  });

  it('converts timestamp to DD-MM-YYYY display format', () => {
    const [tx] = parseBinanceCSV(csv);
    expect(tx.fecha).toBe('15-01-2024');
  });
});

describe('Trade History — SELL with fee in quote asset', () => {
  // ETH/USDT sell: fee paid in USDT (the quote currency).
  // Net proceeds = total − feeInQuote.
  const csv = tradeCsv('2024-01-20 14:00:00,ETH,USDT,SELL,2000,1.5,3000,3,USDT,222222');

  it('produces a SELL transaction', () => {
    const [tx] = parseBinanceCSV(csv);
    expect(tx.type).toBe('SELL');
  });

  it('deducts quote fee from total proceeds', () => {
    const [tx] = parseBinanceCSV(csv);
    // 3000 − 3 = 2997
    expect(tx.total).toBeCloseTo(2997, 2);
  });

  it('uses the full quantity (fee not in base for SELL)', () => {
    const [tx] = parseBinanceCSV(csv);
    expect(tx.cantidad).toBeCloseTo(1.5, 6);
  });

  it('comisiones equals the fiat fee amount directly', () => {
    const [tx] = parseBinanceCSV(csv);
    // USDT is FIAT_LIKE → comisiones = fee × 1 = 3
    expect(tx.comisiones).toBeCloseTo(3, 4);
  });
});

describe('Trade History — crypto-to-crypto pair is skipped', () => {
  // BTC/ETH: quote asset ETH is not in the FIAT_LIKE set → must be filtered out.
  const csv = tradeCsv('2024-01-16 12:00:00,BTC,ETH,BUY,15,2,30,0.01,ETH,333333');

  it('returns an empty array for a crypto-to-crypto trade', () => {
    expect(parseBinanceCSV(csv)).toHaveLength(0);
  });
});

describe('Trade History — EUR-quoted trade uses EUR moneda', () => {
  const csv = tradeCsv('2024-03-01 09:00:00,BTC,EUR,BUY,40000,0.05,2000,0,EUR,444444');

  it('sets moneda to EUR when the quote asset is EUR', () => {
    const [tx] = parseBinanceCSV(csv);
    expect(tx.moneda).toBe('EUR');
  });
});

// ─── Format B: Transaction History ───────────────────────────────────────────

describe('Transaction History (EN) — BUY without fee', () => {
  const csv = txnCsvEn(
    '123,2024-01-15 10:30:00,Spot,Buy,USDT,-4500,',
    '123,2024-01-15 10:30:00,Spot,Buy,BTC,0.1,',
  );

  it('produces exactly one BUY transaction', () => {
    const result = parseBinanceCSV(csv);
    expect(result.filter(t => t.type === 'BUY')).toHaveLength(1);
  });

  it('derives price from cost / quantity', () => {
    const [tx] = parseBinanceCSV(csv);
    // 4500 / 0.1 = 45000
    expect(tx.precio).toBeCloseTo(45000, 2);
  });

  it('records full gross quantity (no fee deduction)', () => {
    const [tx] = parseBinanceCSV(csv);
    expect(tx.cantidad).toBeCloseTo(0.1, 8);
  });

  it('sets moneda to USD for a USDT-denominated trade', () => {
    const [tx] = parseBinanceCSV(csv);
    expect(tx.moneda).toBe('USD');
  });
});

describe('Transaction History (EN) — BUY with crypto fee emits a separate FEE record', () => {
  // Fee is paid in BTC (the crypto being bought). The parser converts it to USD using
  // the trade price, emits a separate non-consolidated FEE record, and deducts the fee
  // quantity from the net BUY cantidad.
  const csv = txnCsvEn(
    '123,2024-02-01 10:30:00,Spot,Buy,USDT,-4500,',
    '123,2024-02-01 10:30:00,Spot,Buy,BTC,0.1,',
    '123,2024-02-01 10:30:01,Spot,Transaction Fee,BTC,-0.0001,',  // within 3-second window
  );

  it('produces one BUY and one FEE transaction', () => {
    const result = parseBinanceCSV(csv);
    expect(result.filter(t => t.type === 'BUY')).toHaveLength(1);
    expect(result.filter(t => t.type === 'FEE')).toHaveLength(1);
  });

  it('net BUY quantity = gross quantity − crypto fee', () => {
    const result = parseBinanceCSV(csv);
    const buy = result.find(t => t.type === 'BUY');
    // 0.1 − 0.0001 = 0.0999
    expect(buy.cantidad).toBeCloseTo(0.0999, 6);
  });

  it('FEE amount is the crypto fee converted to fiat using the trade rate', () => {
    const result = parseBinanceCSV(csv);
    const fee = result.find(t => t.type === 'FEE');
    // 0.0001 BTC × (4500 USDT / 0.1 BTC) = 4.5 USDT
    expect(fee.total).toBeCloseTo(4.5, 4);
  });

  it('FEE record has isConsolidated: false so it is saved to the database', () => {
    const result = parseBinanceCSV(csv);
    const fee = result.find(t => t.type === 'FEE');
    expect(fee.isConsolidated).toBe(false);
  });

  it('BUY record has isConsolidated: false so it is saved to the DB and enters the FIFO pipeline', () => {
    // Transaction History rows reconstruct real trade events (exact timestamp/qty/price).
    // They were previously marked consolidated, which silently excluded every Binance
    // buy from the transactions table — and therefore from Invertido/realized totals.
    const result = parseBinanceCSV(csv);
    const buy = result.find(t => t.type === 'BUY');
    expect(buy.isConsolidated).toBe(false);
  });
});

describe('Transaction History (EN) — SELL with crypto fee', () => {
  const csv = txnCsvEn(
    '123,2024-03-10 15:00:00,Spot,Sell,USDT,3000,',
    '123,2024-03-10 15:00:00,Spot,Sell,ETH,-1.5,',
    '123,2024-03-10 15:00:01,Spot,Transaction Fee,ETH,-0.0015,',
  );

  it('produces a SELL and a FEE record', () => {
    const result = parseBinanceCSV(csv);
    expect(result.filter(t => t.type === 'SELL')).toHaveLength(1);
    expect(result.filter(t => t.type === 'FEE')).toHaveLength(1);
  });

  it('FEE is non-consolidated', () => {
    const result = parseBinanceCSV(csv);
    const fee = result.find(t => t.type === 'FEE');
    expect(fee.isConsolidated).toBe(false);
  });
});

describe('Transaction History (ES) — Spanish column headers are resolved correctly', () => {
  // Spanish export: "Operación" normalises to "operacion" which matches the column-finder.
  const csv = txnCsvEs(
    '123,2024-04-01 08:00:00,Spot,Compra,USDT,-1000,',
    '123,2024-04-01 08:00:00,Spot,Compra,ETH,0.5,',
  );

  it('produces a BUY transaction from Spanish-header CSV', () => {
    const result = parseBinanceCSV(csv);
    expect(result.filter(t => t.type === 'BUY')).toHaveLength(1);
  });

  it('correctly maps ETH to ETH-USD ticker', () => {
    const [tx] = parseBinanceCSV(csv);
    expect(tx.producto).toBe('ETH-USD');
  });
});

describe('Transaction History — 2-digit year is expanded to 4-digit year', () => {
  const csv = txnCsvEn(
    '123,24-05-20 09:00:00,Spot,Buy,USDT,-500,',
    '123,24-05-20 09:00:00,Spot,Buy,BTC,0.01,',
  );

  it('parses the date and includes a valid fecha field', () => {
    const [tx] = parseBinanceCSV(csv);
    // "24-05-20 09:00:00" → date parts ["24","05","20"] → y="2024" → "20-05-2024"
    expect(tx.fecha).toBe('20-05-2024');
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('Edge cases', () => {
  it('returns an empty array for an empty CSV (no data rows)', () => {
    expect(parseBinanceCSV(TRADE_HDR)).toHaveLength(0);
    expect(parseBinanceCSV('')).toHaveLength(0);
  });

  it('returns an empty array for an unrecognised header format', () => {
    const csv = 'ColA,ColB,ColC\n1,2,3';
    expect(parseBinanceCSV(csv)).toHaveLength(0);
  });

  it('strips a UTF-8 BOM from the start of the file', () => {
    // Prepend the BOM character (﻿) — common in files exported on Windows.
    const csv = '﻿' + tradeCsv('2024-01-15 10:30:00,BTC,USDT,BUY,45000,0.1,4500,0,BTC,1');
    const result = parseBinanceCSV(csv);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('BUY');
  });

  it('groups Transaction History rows within a 3-second window into one trade', () => {
    // All three rows share the same logical trade despite slightly different timestamps.
    const csv = txnCsvEn(
      '123,2024-06-01 12:00:00,Spot,Buy,USDT,-2000,',
      '123,2024-06-01 12:00:01,Spot,Buy,SOL,10,',
      '123,2024-06-01 12:00:02,Spot,Transaction Fee,SOL,-0.01,',
    );
    const result = parseBinanceCSV(csv);
    expect(result.filter(t => t.type === 'BUY')).toHaveLength(1);
    expect(result.filter(t => t.type === 'FEE')).toHaveLength(1);
  });

  it('treats rows more than 3 seconds apart as separate trades', () => {
    // Two separate BTC buys placed 10 seconds apart.
    const csv = txnCsvEn(
      '123,2024-06-02 10:00:00,Spot,Buy,USDT,-1000,',
      '123,2024-06-02 10:00:00,Spot,Buy,BTC,0.022,',
      '123,2024-06-02 10:00:10,Spot,Buy,USDT,-1000,',  // 10 seconds later
      '123,2024-06-02 10:00:10,Spot,Buy,BTC,0.022,',
    );
    const result = parseBinanceCSV(csv);
    expect(result.filter(t => t.type === 'BUY')).toHaveLength(2);
  });
});

// ─── Real-world regression fixture (2026-06 export, anonymized) ───────────────
// Covers the three buy patterns Binance emits plus fiat deposits:
//   1. "Binance Convert"           — crypto/fiat legs 0-1 s apart, no remark
//   2. "Transaction Spend/Buy/Fee" — same-second legs, fee charged in CRYPTO
//   3. "Buy Crypto With Fiat"      — legs 6 s apart, linked ONLY by the Remark
describe('Transaction History — real-world export regression', () => {
  const REAL_CSV = `﻿ID de usuario,Tiempo,Cuenta,Operación,Moneda,Cambio,Observación
100000001,2025-12-25 19:09:59,Spot,Deposit,EUR,100,
100000001,2025-12-25 19:15:02,Spot,Binance Convert,BTC,0.00133047,
100000001,2025-12-25 19:15:02,Spot,Binance Convert,EUR,-100,
100000001,2025-12-25 19:18:21,Spot,Deposit,EUR,600,
100000001,2025-12-25 19:18:41,Spot,Binance Convert,BTC,0.00798592,
100000001,2025-12-25 19:18:42,Spot,Binance Convert,EUR,-600,
100000001,2026-02-04 08:16:14,Spot,Deposit,EUR,150,
100000001,2026-02-04 08:18:33,Spot,Transaction Spend,EUR,-149.843464,
100000001,2026-02-04 08:18:33,Spot,Transaction Fee,BTC,-0.00000232,
100000001,2026-02-04 08:18:33,Spot,Transaction Buy,BTC,0.00232,
100000001,2026-06-09 07:35:05,Spot,Deposit,EUR,199,
100000001,2026-06-09 07:43:38,Spot,Buy Crypto With Fiat,EUR,-199.15,Via CashBalance - Wallet/N01760721208877779968060921
100000001,2026-06-09 07:43:44,Spot,Buy Crypto With Fiat,BTC,0.00362173,Via CashBalance - Wallet/N01760721208877779968060921
`;
  const result = parseBinanceCSV(REAL_CSV);
  const buys = result.filter(t => t.type === 'BUY');
  const transfers = result.filter(t => t.type === 'TRANSFER');
  const fees = result.filter(t => t.type === 'FEE');

  it('reconstructs ALL four buys: cost basis + fee row = 1048.99 EUR total outflow, 0.01525580 BTC', () => {
    expect(buys).toHaveLength(4);
    const buyBasis = buys.reduce((s, t) => s + Math.abs(t.total), 0);
    const feeTotal = fees.reduce((s, t) => s + Math.abs(t.total), 0);
    // The crypto-deducted fee is excluded from the BUY basis and accounted once via FEE
    expect(buyBasis).toBeCloseTo(1048.84, 2);
    expect(buyBasis + feeTotal).toBeCloseTo(1048.99, 2);
    expect(buys.reduce((s, t) => s + t.cantidad, 0)).toBeCloseTo(0.01525580, 8);
  });

  it('groups the "Buy Crypto With Fiat" legs by Remark despite the 6-second gap', () => {
    const remarkBuy = buys.find(b => b.fecha === '09-06-2026');
    expect(remarkBuy).toBeDefined();
    expect(remarkBuy.cantidad).toBeCloseTo(0.00362173, 8);
    expect(remarkBuy.total).toBeCloseTo(-199.15, 2);
  });

  it('deducts the crypto fee from quantity and emits a 0.1498 EUR FEE row', () => {
    const spendBuy = buys.find(b => b.fecha === '04-02-2026');
    expect(spendBuy.cantidad).toBeCloseTo(0.00232 - 0.00000232, 8);
    expect(fees).toHaveLength(1);
    expect(fees[0].total).toBeCloseTo(0.1498, 3); // 0.00000232 × (149.843464 / 0.00232)
  });

  it('emits fiat deposits as TRANSFER rows so the broker cash balance exists', () => {
    expect(transfers).toHaveLength(4);
    expect(transfers.reduce((s, t) => s + t.total, 0)).toBeCloseTo(1049, 2);
    expect(transfers.every(t => t.moneda === 'EUR' && t.isConsolidated === false)).toBe(true);
  });

  it('emits no consolidated rows at all', () => {
    expect(result.some(t => t.isConsolidated)).toBe(false);
  });
});
