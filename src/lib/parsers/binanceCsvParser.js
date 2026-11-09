/**
 * Binance CSV Parser — Clean Room implementation
 *
 * Supports two export formats, auto-detected from headers (ES + EN):
 *
 * A) Trade History  (Órdenes → Historial de operaciones → Exportar)
 *    Columns: time, base-asset, quote-asset, type, price, quantity, total, fee, fee-currency, trade-id
 *    One complete trade per row.
 *
 * B) Transaction History  (Billetera → Historial de transacciones → Generar)
 *    Columns (ES): ID de usuario, Tiempo, Cuenta, Operación, Moneda, Cambio, Observación
 *    Columns (EN): User_ID, UTC_Time, Account, Operation, Coin, Change, Remark
 *    Multiple rows per trade — grouped by timestamp proximity (≤ 3 seconds).
 *    Date format: "YY-MM-DD HH:MM:SS" (2-digit year) or "YYYY-MM-DD HH:MM:SS".
 */

const CRYPTO_TICKER_MAP = {
  BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', BNB: 'BNB-USD',
  ADA: 'ADA-USD', DOT: 'DOT-USD', AVAX: 'AVAX-USD', LINK: 'LINK-USD',
  MATIC: 'MATIC-USD', XRP: 'XRP-USD', LTC: 'LTC-USD', DOGE: 'DOGE-USD',
  UNI: 'UNI-USD', ATOM: 'ATOM-USD', FIL: 'FIL-USD', ALGO: 'ALGO-USD',
  VET: 'VET-USD', TRX: 'TRX-USD', SHIB: 'SHIB-USD', NEAR: 'NEAR-USD',
  APT: 'APT-USD', ARB: 'ARB-USD', OP: 'OP-USD', SUI: 'SUI-USD',
};

const FIAT_LIKE = new Set(['USDT', 'BUSD', 'USDC', 'USD', 'EUR', 'FDUSD', 'TUSD', 'DAI', 'GBP']);

const toYahooTicker = (sym) => CRYPTO_TICKER_MAP[sym] || `${sym}-USD`;

// Normalize header: strip accents (NFD), lowercase, remove non-alphanumeric
const normHeader = (h) =>
  (h || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Find the original header key whose normalized form contains any of the given keywords
const findKey = (headers, normHeaders, ...keywords) => {
  const idx = normHeaders.findIndex(n => keywords.some(kw => n.includes(kw)));
  return idx >= 0 ? headers[idx] : null;
};

// Parse "YY-MM-DD HH:MM:SS" or "YYYY-MM-DD HH:MM:SS" → unix seconds (UTC)
const toUnix = (ts = '') => {
  const [datePart = '', timePart = '00:00:00'] = ts.split(' ');
  const parts = datePart.split('-');
  if (parts.length !== 3) return 0;
  let [y, m, d] = parts;
  if (y.length === 2) y = `20${y}`;
  try {
    return new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}T${timePart}Z`).getTime() / 1000;
  } catch { return 0; }
};

// "YY-MM-DD HH:MM:SS" → "DD-MM-YYYY" (DeGiro convention used in the rest of the app)
const toDisplayDate = (ts = '') => {
  const [datePart = ''] = ts.split(' ');
  const parts = datePart.split('-');
  if (parts.length !== 3) return '';
  let [y, m, d] = parts;
  if (y.length === 2) y = `20${y}`;
  return `${d.padStart(2,'0')}-${m.padStart(2,'0')}-${y}`;
};

const toDisplayTime = (ts = '') => ts.split(' ')[1] || '00:00';

// ── CSV tokeniser (handles quoted fields) ─────────────────────────────────────
function splitCsvLine(line) {
  const result = [];
  let cur = '', inQuote = false;
  for (const ch of line) {
    if (ch === '"') { inQuote = !inQuote; }
    else if (ch === ',' && !inQuote) { result.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  result.push(cur.trim());
  return result;
}

function parseCsvRows(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return { headers: [], normHeaders: [], rows: [] };
  const headers     = splitCsvLine(lines[0]);
  const normHeaders = headers.map(normHeader);
  const rows = lines.slice(1).map(line => {
    const vals = splitCsvLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
    return obj;
  });
  return { headers, normHeaders, rows };
}

// ── Format A: Trade History ────────────────────────────────────────────────────
function parseTradeHistory(rows) {
  const transactions = [];
  for (const row of rows) {
    const ts    = row['time'] || row['date'] || '';
    const base  = (row['base-asset'] || '').toUpperCase();
    const quote = (row['quote-asset'] || '').toUpperCase();
    const side  = (row['type'] || row['side'] || '').toUpperCase();
    const price = parseFloat(row['price'] || 0);
    const qty   = parseFloat(row['quantity'] || 0);
    const total = parseFloat(row['total'] || 0);
    const fee   = parseFloat(row['fee'] || 0);
    const feeCur = (row['fee-currency'] || '').toUpperCase();

    if (!base || !quote || !side || qty <= 0) continue;
    if (!FIAT_LIKE.has(quote)) continue; // skip crypto-to-crypto

    const isBuy   = side === 'BUY';
    const ticker  = toYahooTicker(base);
    const feeInBase  = feeCur === base  ? fee : 0;
    const feeInQuote = feeCur === quote ? fee : 0;

    transactions.push({
      fecha:         toDisplayDate(ts),
      hora:          toDisplayTime(ts),
      type:          isBuy ? 'BUY' : 'SELL',
      producto:      ticker,
      isin:          ticker,
      displayTicker: ticker,
      cantidad:      isBuy ? qty - feeInBase : qty,
      precio:        price,
      total:         isBuy ? -(total + feeInQuote) : total - feeInQuote,
      moneda:        quote === 'EUR' ? 'EUR' : 'USD',
      comisiones:    fee * (FIAT_LIKE.has(feeCur) ? 1 : price),
      descripcion:    `Binance ${isBuy ? 'Compra' : 'Venta'} ${base}/${quote}`,
      isConsolidated: true,
    });
  }
  return transactions;
}

// ── Format B: Transaction History ─────────────────────────────────────────────
function parseTransactionHistory(rows, headers, normHeaders) {
  // Locate columns — handles both ES and EN names
  const timeKey   = findKey(headers, normHeaders, 'tiempo', 'utctime', 'time');
  const opKey     = findKey(headers, normHeaders, 'operacion', 'operation');
  const coinKey   = findKey(headers, normHeaders, 'moneda', 'coin', 'asset', 'currency');
  const changeKey = findKey(headers, normHeaders, 'cambio', 'change', 'amount');
  const remarkKey = findKey(headers, normHeaders, 'observacion', 'remark');

  if (!timeKey || !opKey || !coinKey || !changeKey) {
    console.warn('[BinanceCSV] Transaction History: could not map columns', { timeKey, opKey, coinKey, changeKey });
    return [];
  }

  const opNorm = (op) => (op || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  // Internal movements that are neither trades nor external cash flows
  const isInternal = (op) => {
    const n = opNorm(op);
    return n.includes('transfer between') || n.includes('small assets')
        || n.includes('asset conversion transfer');
  };
  const isDeposit  = (op) => opNorm(op).includes('deposit');
  const isWithdraw = (op) => opNorm(op).includes('withdraw');
  const isFeeOp = (op) => {
    const n = opNorm(op);
    return n.includes('fee') || n.includes('commission');
  };

  // Enrich rows with unix timestamp, skip rows with no useful data
  const enriched = rows
    .map(row => ({
      ts:     row[timeKey] || '',
      op:     row[opKey] || '',
      coin:   (row[coinKey] || '').toUpperCase(),
      change: parseFloat(row[changeKey] || 0),
      unix:   toUnix(row[timeKey] || ''),
      remark: remarkKey ? (row[remarkKey] || '').trim() : '',
    }))
    .filter(r => r.ts && r.coin && r.unix > 0 && !isInternal(r.op))
    .sort((a, b) => a.unix - b.unix);

  const transactions = [];

  // ── External cash flows: fiat deposits/withdrawals → TRANSFER rows ──────────
  // Emitted so the broker's EUR cash balance exists in the app (deposits minus
  // buys leaves the real spot-wallet balance). Crypto deposits/withdrawals are
  // skipped — they are inventory moves, not cash.
  for (const r of enriched) {
    if ((isDeposit(r.op) || isWithdraw(r.op)) && FIAT_LIKE.has(r.coin)) {
      transactions.push({
        fecha:         toDisplayDate(r.ts),
        hora:          toDisplayTime(r.ts),
        type:          'TRANSFER',
        producto:      `CASH_${r.coin}`,
        isin:          `CASH_${r.coin}`,
        displayTicker: r.coin,
        cantidad:      0,
        precio:        0,
        total:         r.change,
        moneda:        r.coin,
        comisiones:    0,
        descripcion:   `Binance ${isDeposit(r.op) ? 'Depósito' : 'Retirada'} ${r.coin}`,
        isConsolidated: false,
      });
    }
  }

  const tradeRows = enriched.filter(r => !isDeposit(r.op) && !isWithdraw(r.op));

  // ── Group trade legs into logical trades ────────────────────────────────────
  // 1. Rows sharing a non-empty Remark/Observación (e.g. "Via CashBalance -
  //    Wallet/N017…") belong to the same order even when Binance writes the fiat
  //    and crypto legs several seconds apart ("Buy Crypto With Fiat" pattern).
  // 2. Remaining rows group by timestamp proximity: ≤ 3 s gap between
  //    CONSECUTIVE rows (not from the group's first row).
  const byRemark = {};
  const byTime = [];
  for (const row of tradeRows) {
    if (row.remark) {
      if (!byRemark[row.remark]) byRemark[row.remark] = [];
      byRemark[row.remark].push(row);
    } else {
      byTime.push(row);
    }
  }

  const groups = Object.values(byRemark);
  let group = [];
  for (const row of byTime) {
    if (group.length === 0 || row.unix - group[group.length - 1].unix <= 3) {
      group.push(row);
    } else {
      groups.push(group);
      group = [row];
    }
  }
  if (group.length > 0) groups.push(group);
  // Keep chronological output order (remark groups were collected first)
  groups.sort((a, b) => a[0].unix - b[0].unix);

  for (const g of groups) {
    const fees          = g.filter(r => isFeeOp(r.op));
    const nonFeeRows    = g.filter(r => !isFeeOp(r.op));

    const cryptoIn  = nonFeeRows.filter(r => !FIAT_LIKE.has(r.coin) && r.change > 0);
    const fiatOut   = nonFeeRows.filter(r =>  FIAT_LIKE.has(r.coin) && r.change < 0);
    const cryptoOut = nonFeeRows.filter(r => !FIAT_LIKE.has(r.coin) && r.change < 0);
    const fiatIn    = nonFeeRows.filter(r =>  FIAT_LIKE.has(r.coin) && r.change > 0);

    const ts    = g[0].ts;
    const fecha = toDisplayDate(ts);
    const hora  = toDisplayTime(ts);
    const feeAmt = fees.reduce((s, r) => s + Math.abs(r.change), 0);

    if (cryptoIn.length > 0 && fiatOut.length > 0) {
      // BUY: received crypto, spent fiat
      const qtyGross = cryptoIn.reduce((s, r) => s + r.change, 0);
      const cost     = Math.abs(fiatOut.reduce((s, r) => s + r.change, 0));
      const ticker   = toYahooTicker(cryptoIn[0].coin);
      const fiatCur  = fiatOut[0].coin;

      // Fees paid in the same crypto being bought (e.g. BTC fee for BTC buy).
      // Convert to the fiat currency using the trade price.
      const sameCoinFees = fees.filter(f => f.coin === cryptoIn[0].coin);
      const feeAmtCrypto = sameCoinFees.reduce((s, r) => s + Math.abs(r.change), 0);
      const feeAmtFiat   = feeAmtCrypto > 0 && qtyGross > 0
        ? feeAmtCrypto * (cost / qtyGross)
        : 0;

      // Net qty = gross received − fee deducted from account
      const qty = qtyGross - feeAmtCrypto;

      // Cost basis excludes the fee: the FEE row below accounts for it exactly once.
      // Using the full cost here AND emitting a FEE row double-counted the fee
      // (inflated basis + fees total) and pushed the broker cash balance negative.
      const costBasis = cost - feeAmtFiat;

      transactions.push({
        fecha, hora,
        type:          'BUY',
        producto:      ticker,
        isin:          ticker,
        displayTicker: ticker,
        cantidad:      qty,
        precio:        qty > 0 ? costBasis / qty : 0,
        total:         -costBasis,
        moneda:        fiatCur === 'EUR' ? 'EUR' : 'USD',
        comisiones:    0,
        descripcion:   `Binance Compra ${cryptoIn[0].coin}/${fiatCur}`,
        // Real reconstructed trade event (exact timestamp/qty/price) — must be
        // persisted to the transactions table and processed by the FIFO pipeline.
        // It was previously marked isConsolidated: true, which excluded every
        // Binance buy from the DB history (and from Invertido/realized totals).
        isConsolidated: false,
      });

      // Emit fee as a real (non-consolidated) FEE record so it gets saved to DB.
      // totalEUR is set so eur_total is stored in DB — needed because the asset's
      // native currency is USD but the fee was computed from a EUR-denominated trade.
      if (feeAmtFiat > 0) {
        transactions.push({
          fecha, hora,
          type:          'FEE',
          producto:      ticker,
          isin:          ticker,
          displayTicker: ticker,
          cantidad:      0,
          precio:        0,
          total:         feeAmtFiat,
          totalEUR:      fiatCur === 'EUR' ? feeAmtFiat : null,
          moneda:        fiatCur === 'EUR' ? 'EUR' : 'USD',
          comisiones:    0,
          descripcion:   `Comisión Binance ${cryptoIn[0].coin}/${fiatCur}`,
          isConsolidated: false,
        });
      }

    } else if (fiatIn.length > 0 && cryptoOut.length > 0) {
      // SELL: received fiat, spent crypto
      const qty     = Math.abs(cryptoOut.reduce((s, r) => s + r.change, 0));
      const recv    = fiatIn.reduce((s, r) => s + r.change, 0);
      const ticker  = toYahooTicker(cryptoOut[0].coin);
      const fiatCur = fiatIn[0].coin;

      // Same fee logic as BUY: fees paid in same crypto, converted to fiat
      const sameCoinFeesSell = fees.filter(f => f.coin === cryptoOut[0].coin);
      const feeAmtCryptoSell = sameCoinFeesSell.reduce((s, r) => s + Math.abs(r.change), 0);
      const feeAmtFiatSell   = feeAmtCryptoSell > 0 && qty > 0
        ? feeAmtCryptoSell * (recv / qty)
        : 0;

      transactions.push({
        fecha, hora,
        type:          'SELL',
        producto:      ticker,
        isin:          ticker,
        displayTicker: ticker,
        cantidad:      qty,
        precio:        qty > 0 ? recv / qty : 0,
        total:         recv,
        moneda:        fiatCur === 'EUR' ? 'EUR' : 'USD',
        comisiones:    0,
        descripcion:   `Binance Venta ${cryptoOut[0].coin}/${fiatCur}`,
        // Real reconstructed trade event — see the BUY branch note.
        isConsolidated: false,
      });

      if (feeAmtFiatSell > 0) {
        transactions.push({
          fecha, hora,
          type:          'FEE',
          producto:      ticker,
          isin:          ticker,
          displayTicker: ticker,
          cantidad:      0,
          precio:        0,
          total:         feeAmtFiatSell,
          totalEUR:      fiatCur === 'EUR' ? feeAmtFiatSell : null,
          moneda:        fiatCur === 'EUR' ? 'EUR' : 'USD',
          comisiones:    0,
          descripcion:   `Comisión Binance Venta ${cryptoOut[0].coin}/${fiatCur}`,
          isConsolidated: false,
        });
      }
    }
    // Crypto-to-crypto or unrecognised groups: skip
  }

  return transactions;
}

// ── Public API ─────────────────────────────────────────────────────────────────
export function parseBinanceCSV(csvText) {
  const text = csvText.replace(/^﻿/, ''); // strip UTF-8 BOM
  const { headers, normHeaders, rows } = parseCsvRows(text);

  if (rows.length === 0) {
    console.warn('[BinanceCSV] No rows found');
    return [];
  }

  // Format detection
  const hasBase  = normHeaders.some(h => h.includes('baseasset') || h === 'base');
  const hasQuote = normHeaders.some(h => h.includes('quoteasset') || h === 'quote');
  const hasOp    = normHeaders.some(h => h.includes('operacion') || h.includes('operation'));

  let result;
  if (hasBase && hasQuote) {
    console.log('[BinanceCSV] Detected: Trade History format');
    result = parseTradeHistory(rows);
  } else if (hasOp) {
    console.log('[BinanceCSV] Detected: Transaction History format');
    result = parseTransactionHistory(rows, headers, normHeaders);
  } else {
    console.warn('[BinanceCSV] Unknown format — headers:', headers);
    return [];
  }

  console.log(`[BinanceCSV] Parsed ${result.length} transactions from ${rows.length} rows`);
  return result;
}
