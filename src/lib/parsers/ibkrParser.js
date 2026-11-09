/**
 * Interactive Brokers (IBKR) CSV Parser
 *
 * Supports two formats:
 *
 * 1. Transaction History  (Rendimiento e informes → Historial de transacciones)
 *    Columns: Date, Account, Description, Transaction Type, Symbol, Quantity,
 *             Price, Price Currency, Gross Amount, Commission, Net Amount
 *    Key difference: Gross Amount / Net Amount / Commission are in BASE CURRENCY (EUR),
 *    not in the price currency of the traded stock.
 *
 * 2. Activity Statement  (legacy flex/activity report format — kept for backward compat)
 *    Multi-section CSV with Trades, Cash Report, Open Positions, etc.
 *
 * Return shape: { transactions: Transaction[], warnings: ParseWarning[], detectedFormat: string }
 *
 * ParseWarning: { code: string, ...extra }
 *   - { code: 'ibkr_unknown_format' }
 *   - { code: 'ibkr_unknown_types', types: string[] }
 */

export function parseIBKRCSV(csvText) {
    // Strip UTF-8 BOM and normalise line endings before any processing
    const normalized = (csvText || '').replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n').map(line => line.trim()).filter(line => line.length > 0);

    const warnings = [];

    if (lines.length < 2) {
        return { transactions: [], warnings, detectedFormat: 'empty' };
    }

    // ── Shared helpers ────────────────────────────────────────────────────────

    const splitCSV = (text) => {
        const result = [];
        let cur = '';
        let inQuote = false;
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            if (char === '"') inQuote = !inQuote;
            else if (char === ',' && !inQuote) { result.push(cur.trim()); cur = ''; }
            else cur += char;
        }
        result.push(cur.trim());
        return result;
    };

    const cleanNum = (str) => {
        if (!str || str === '-') return 0;
        const n = parseFloat(str.replace(/"/g, '').replace(/,/g, ''));
        return isNaN(n) ? 0 : n;
    };

    const parseDate = (dateStr) => {
        if (!dateStr || dateStr === '-') return { date: '', time: '00:00:00' };
        let datePart = dateStr;
        let timePart = '00:00:00';
        if (dateStr.includes(',')) {
            [datePart, timePart] = dateStr.split(',').map(s => s.trim());
        } else if (dateStr.includes(' ') && dateStr.length > 10) {
            [datePart, timePart] = dateStr.split(' ').map(s => s.trim());
        }
        if (datePart.length === 8 && !/[-/]/.test(datePart)) {
            return { date: `${datePart.slice(6)}-${datePart.slice(4, 6)}-${datePart.slice(0, 4)}`, time: timePart };
        }
        const parts = datePart.split(/[-/]/);
        if (parts.length === 3) {
            if (parts[0].length === 4) return { date: `${parts[2].padStart(2, '0')}-${parts[1].padStart(2, '0')}-${parts[0]}`, time: timePart };
            if (parts[2].length === 4) return { date: `${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}-${parts[2]}`, time: timePart };
        }
        return { date: datePart, time: timePart };
    };

    // ── Format detection — score multiple signals ─────────────────────────────
    // Use scoring so a single anomalous row (BOM, whitespace, etc.) does not
    // prevent recognising the correct format.
    let thScore = 0;  // Transaction History signals
    let asScore = 0;  // Activity Statement signals

    for (const line of lines) {
        const cols = splitCSV(line);
        const c0 = (cols[0] || '').toLowerCase();
        const c1 = (cols[1] || '').toLowerCase();
        const rest = cols.map(c => c.toLowerCase());

        // Transaction History signals
        if (c0 === 'transaction history' && c1 === 'header') thScore += 3;
        if (c0 === 'transaction history' && c1 === 'data')   thScore += 1;
        if (c0 === 'summary' && c1 === 'data' && rest[2] && (rest[2].includes('divisa base') || rest[2].includes('base currency'))) thScore += 1;

        // Activity Statement signals
        if (c0 === 'trades' && c1 === 'header')                              asScore += 3;
        if (c0 === 'account information' && c1 === 'header')                 asScore += 2;
        if (c0 === 'statement' && c1 === 'data' && (cols[2] || '') === 'Period') asScore += 2;
        if (c0 === 'open positions' && c1 === 'header')                      asScore += 1;
        if (c0 === 'financial instrument information' && c1 === 'header')    asScore += 1;
    }

    if (thScore === 0 && asScore === 0) {
        warnings.push({ code: 'ibkr_unknown_format' });
        return { transactions: [], warnings, detectedFormat: 'unknown' };
    }

    if (thScore >= asScore) {
        const transactions = parseTransactionHistory(lines, splitCSV, cleanNum, parseDate, warnings);
        return { transactions, warnings, detectedFormat: 'transaction-history' };
    }

    const transactions = parseActivityStatement(lines, splitCSV, cleanNum, parseDate, warnings);
    return { transactions, warnings, detectedFormat: 'activity-statement' };
}

// ── Transaction History format ────────────────────────────────────────────────
// Amounts in Gross/Net/Commission columns are in base currency (EUR).
// Price and Price Currency reflect the stock's native price.
// Cost basis for BUY/SELL is computed as qty × price in native currency.

function parseTransactionHistory(lines, splitCSV, cleanNum, parseDate, warnings) {
    const transactions = [];
    let baseCurrency = 'EUR';
    let headerCols = null;
    let statementDate = ''; // DD-MM-YYYY — used as snapshot anchor date
    let endingCash = null;  // final base-currency cash from Summary (null = not found)
    const isinMap = {};        // symbol → ISIN (extracted from descriptions)
    const foreignCurrencies = new Set(); // non-base currencies used in BUY/SELL trades
    const unknownTypes = new Set();      // unrecognised transaction types → warning

    const ISIN_RE = /\(([A-Z]{2}[A-Z0-9]{9}[0-9])\)/;
    const isNA = (v) => !v || (typeof v === 'string' && v.trim() === '-');
    // ISO date (YYYY-MM-DD) of the latest transaction seen in Pass 3.
    // IBKR's WhenGenerated can be earlier than the actual last transaction in the file,
    // so using it as the snapshot anchor would cause post-WhenGenerated transactions to
    // be applied on top of an ending cash that already includes them (double-count).
    let latestTxISO = '';

    // Pass 1: extract base currency, statement date, ending cash, and column header
    for (const line of lines) {
        const cols = splitCSV(line);
        if (cols[0] === 'Summary' && cols[1] === 'Data') {
            const key = cols[2] || '';
            if (key === 'Divisa base' || key === 'Base Currency') {
                baseCurrency = (cols[3] || 'EUR').trim().toUpperCase();
            }
            // "Efectivo final" (ES) / "Ending Cash" (EN) — the actual base-currency CASH balance.
            // "Net Asset Value" is excluded: it includes securities value, not just cash.
            if (key === 'Efectivo final' || key === 'Ending Cash') {
                endingCash = cleanNum(cols[3]);
            }
        }
        if (cols[0] === 'Statement' && cols[1] === 'Data' && cols[2] === 'WhenGenerated') {
            // "2026-04-19, 16:43:21 EDT" → take only the date part
            const rawDate = (cols[3] || '').split(',')[0].trim();
            statementDate = parseDate(rawDate).date; // → "19-04-2026"
        }
        if (cols[0] === 'Transaction History' && cols[1] === 'Header') {
            headerCols = cols.map(c => c.toLowerCase().trim());
        }
    }
    if (!headerCols) return [];

    const colIdx = (name) => headerCols.indexOf(name.toLowerCase());
    const dateIdx      = colIdx('date');
    const descIdx      = colIdx('description');
    const typeIdx      = colIdx('transaction type');
    const symbolIdx    = colIdx('symbol');
    const quantityIdx  = colIdx('quantity');
    const priceIdx     = colIdx('price');
    const priceCurrIdx = colIdx('price currency');
    const grossIdx     = colIdx('gross amount');
    const commIdx      = colIdx('commission');
    const netIdx       = colIdx('net amount');

    // Pass 2: build ISIN map and collect foreign currencies from BUY/SELL rows
    for (const line of lines) {
        const cols = splitCSV(line);
        if (cols[0] !== 'Transaction History' || cols[1] !== 'Data') continue;
        const sym = symbolIdx >= 0 && cols[symbolIdx] !== '-' ? cols[symbolIdx].trim() : null;
        if (!sym) continue;

        const desc = descIdx >= 0 ? cols[descIdx] : '';
        const m = desc.match(ISIN_RE);
        if (m && !isinMap[sym]) isinMap[sym] = m[1];

        const rowType = typeIdx >= 0 ? (cols[typeIdx] || '').toUpperCase().trim() : '';
        if (rowType === 'BUY' || rowType === 'SELL') {
            const pc = priceCurrIdx >= 0 && !isNA(cols[priceCurrIdx]) ? cols[priceCurrIdx].trim().toUpperCase() : null;
            if (pc && pc !== baseCurrency) foreignCurrencies.add(pc);
        }
    }

    // Pass 3: emit transactions
    lines.forEach((line, lineIndex) => {
        const cols = splitCSV(line);
        if (cols[0] !== 'Transaction History' || cols[1] !== 'Data') return;

        const rawType  = typeIdx >= 0 ? cols[typeIdx] : '';
        const typeUpper = rawType.toUpperCase().trim();

        // Forex conversion rows carry no investment meaning — skip
        if (typeUpper === 'FOREX TRADE COMPONENT' || typeUpper.includes('FOREX')) return;

        const dateStr = dateIdx >= 0 ? cols[dateIdx] : '';
        const { date, time } = parseDate(dateStr);

        // Track latest transaction date in YYYY-MM-DD for snapshot anchor correction.
        // DD-MM-YYYY from parseDate → reverse to YYYY-MM-DD for lexicographic comparison.
        if (date) {
            const [d, m, y] = date.split('-');
            if (y && m && d) {
                const iso = `${y}-${m}-${d}`;
                if (iso > latestTxISO) latestTxISO = iso;
            }
        }

        const desc = descIdx >= 0 ? cols[descIdx] : '';

        const sym = symbolIdx >= 0 && cols[symbolIdx] !== '-' ? cols[symbolIdx].trim() : null;

        // ISIN: prefer from description, fall back to map built in pass 2
        const isinFromDesc = desc.match(ISIN_RE)?.[1] || '';
        const isin = isinFromDesc || (sym ? isinMap[sym] || '' : '');

        const qty      = isNA(cols[quantityIdx]) ? 0 : cleanNum(cols[quantityIdx]);
        const price    = isNA(cols[priceIdx])    ? 0 : cleanNum(cols[priceIdx]);
        const priceCurr = (isNA(cols[priceCurrIdx]) ? baseCurrency : cols[priceCurrIdx].trim()).toUpperCase();
        // Commission and amounts are in base currency (EUR) in this export format
        const commission = isNA(cols[commIdx])  ? 0 : cleanNum(cols[commIdx]);
        const netAmount  = isNA(cols[netIdx])   ? 0 : cleanNum(cols[netIdx]);
        const grossAmount = isNA(cols[grossIdx]) ? 0 : cleanNum(cols[grossIdx]);

        // ── BUY / SELL ────────────────────────────────────────────────────────
        if (typeUpper === 'BUY' || typeUpper === 'SELL') {
            if (!sym || qty === 0) return;
            // EUR cost basis EXCLUDING the commission. Gross Amount is the pure trade
            // amount in base currency; Net = Gross − Commission. The old |netAmount|
            // baked the commission into eur_total while `comisiones` ALSO carried it
            // separately — the same fee reduced the total gain twice (inflated cost
            // basis + fees total). DeGiro's totalEUR (from the FX row) never included
            // the fee, so this also restores cross-broker consistency.
            const grossAbs = Math.abs(grossAmount);
            const eurTotal = grossAbs > 0
                ? grossAbs
                : (Math.abs(netAmount) > 0 ? Math.abs(netAmount) - Math.abs(commission) : undefined);
            transactions.push({
                index: lineIndex,
                fecha: date,
                hora: time || '00:00:00',
                producto: sym,
                isin,
                exchange: '',
                descripcion: desc || `IBKR ${rawType} ${sym}`,
                type: typeUpper,
                cantidad: Math.abs(qty),
                nombre: desc || sym,
                // Price and total in native stock currency (e.g. CAD for CSU).
                // Amounts are NOT from Net Amount (which is in EUR) — we recompute
                // from price × qty so cost basis stays in the stock's native currency.
                precio: price,
                moneda: priceCurr,
                total: Math.abs(qty * price),
                // Commission is in base currency (EUR) per IBKR convention.
                // Kept separately so it is not mixed into native-currency cost basis.
                comisiones: Math.abs(commission),
                // EUR total for direct _prefCostTotal computation (avoids historical FX lookup).
                totalEUR: eurTotal,
                idOrden: `IBKR-TH-${lineIndex}`,
                raw: cols,
            });
            return;
        }

        // ── DIVIDEND ──────────────────────────────────────────────────────────
        if (typeUpper === 'DIVIDEND' || typeUpper.includes('PAYMENT IN LIEU')) {
            if (!sym || netAmount === 0) return;
            transactions.push({
                index: lineIndex,
                fecha: date,
                hora: time || '00:00:00',
                producto: sym,
                isin,
                exchange: '',
                descripcion: desc || `IBKR Dividend ${sym}`,
                type: 'DIVIDEND',
                cantidad: 0,
                nombre: sym,
                precio: 0,
                // Dividend amounts arrive in base currency after IBKR converts from native
                moneda: baseCurrency,
                total: Math.abs(netAmount),
                comisiones: 0,
                idOrden: `IBKR-TH-DIV-${lineIndex}`,
                raw: cols,
            });
            return;
        }

        // ── WITHHOLDING TAX ───────────────────────────────────────────────────
        if (typeUpper.includes('TAX') || typeUpper.includes('WITHHOLDING')) {
            if (!sym || netAmount === 0) return;
            transactions.push({
                index: lineIndex,
                fecha: date,
                hora: time || '00:00:00',
                producto: sym,
                isin,
                exchange: '',
                descripcion: desc || `IBKR Tax ${sym}`,
                type: 'TAX',
                cantidad: 0,
                nombre: sym,
                precio: 0,
                moneda: baseCurrency,
                total: Math.abs(netAmount),
                comisiones: 0,
                idOrden: `IBKR-TH-TAX-${lineIndex}`,
                raw: cols,
            });
            return;
        }

        // ── DEPOSIT / WITHDRAWAL ──────────────────────────────────────────────
        if (typeUpper === 'DEPOSIT' || typeUpper === 'WITHDRAWAL') {
            const amount = netAmount !== 0 ? netAmount : grossAmount;
            if (amount === 0) return;
            const label = desc || `IBKR ${rawType}`;
            transactions.push({
                index: lineIndex,
                fecha: date,
                hora: time || '00:00:00',
                producto: label,
                isin: '',
                exchange: '',
                descripcion: label,
                type: 'TRANSFER',
                cantidad: 0,
                nombre: label,
                precio: 0,
                moneda: baseCurrency,
                total: amount,   // positive = deposit, negative = withdrawal
                comisiones: 0,
                idOrden: `IBKR-TH-DEP-${lineIndex}`,
                raw: cols,
            });
            return;
        }

        // ── COMMISSIONS / FEES ────────────────────────────────────────────────
        if (typeUpper === 'COMMISSION' || typeUpper === 'FEE' || typeUpper.endsWith('FEE') || typeUpper.includes('MISC. FEE')) {
            const amount = netAmount !== 0 ? netAmount : grossAmount;
            if (amount === 0) return;
            const label = desc || `IBKR ${rawType}`;
            // Link fee to the position when a symbol is present (e.g. "Transaction Fee"
            // rows that reference a specific stock). Without sym the fee has no isin and
            // saveImportedData cannot associate it with the right position.
            const feeProducto = sym || label;
            const feeIsin     = sym ? (isinMap[sym] || '') : '';
            transactions.push({
                index: lineIndex,
                fecha: date,
                hora: time || '00:00:00',
                producto: feeProducto,
                isin: feeIsin,
                exchange: '',
                descripcion: label,
                type: 'FEES',
                cantidad: 0,
                nombre: label,
                precio: 0,
                moneda: baseCurrency,
                total: Math.abs(amount),
                comisiones: 0,
                idOrden: `IBKR-TH-FEE-${lineIndex}`,
                raw: cols,
            });
            return;
        }

        // ── INTEREST (margin / cash) ──────────────────────────────────────────
        if (typeUpper === 'INTEREST' || typeUpper === 'DEBIT INTEREST' || typeUpper.includes('INTEREST')) {
            const amount = netAmount !== 0 ? netAmount : grossAmount;
            if (amount === 0) return;
            const label = desc || `IBKR ${rawType}`;
            transactions.push({
                index: lineIndex,
                fecha: date,
                hora: time || '00:00:00',
                producto: label,
                isin: '',
                exchange: '',
                descripcion: label,
                // Positive interest → income (treat as dividend-like); negative → fee
                type: amount > 0 ? 'DIVIDEND' : 'FEES',
                cantidad: 0,
                nombre: label,
                precio: 0,
                moneda: baseCurrency,
                total: Math.abs(amount),
                comisiones: 0,
                idOrden: `IBKR-TH-INT-${lineIndex}`,
                raw: cols,
            });
            return;
        }

        // ── TRANSFER (position transfer between accounts) ─────────────────────
        if (typeUpper === 'TRANSFER' || typeUpper === 'INTERNAL TRANSFER') {
            if (!sym || qty === 0) return;
            // Incoming transfers without a price create a zero-cost FIFO lot →
            // phantom 100% gain when sold. Surface a warning so the user fixes the
            // price in the preview instead of silently importing a broken cost basis.
            if (price === 0) {
                const existing = warnings.find(w => w.code === 'ibkr_transfer_zero_price');
                if (existing) { if (!existing.symbols.includes(sym)) existing.symbols.push(sym); }
                else warnings.push({ code: 'ibkr_transfer_zero_price', symbols: [sym] });
            }
            // Treat as a BUY at the given price (receiving shares)
            transactions.push({
                index: lineIndex,
                fecha: date,
                hora: time || '00:00:00',
                producto: sym,
                isin,
                exchange: '',
                descripcion: desc || `IBKR Transfer ${sym}`,
                type: qty > 0 ? 'BUY' : 'SELL',
                cantidad: Math.abs(qty),
                nombre: desc || sym,
                precio: price,
                moneda: priceCurr,
                total: Math.abs(qty * price),
                comisiones: 0,
                idOrden: `IBKR-TH-TRF-${lineIndex}`,
                raw: cols,
            });
            return;
        }

        // ── Unrecognised type — track for warning, do not silently discard ────
        if (typeUpper) unknownTypes.add(typeUpper);
    });

    // Override statementDate with the latest actual transaction date.
    // WhenGenerated (from the Statement section) is the date the user exported the report
    // from IBKR's portal, which can be earlier than the last transaction in the file.
    // Using WhenGenerated as the snapshot anchor would treat subsequent transactions as
    // "post-snapshot" and apply them on top of an ending-cash balance that already includes
    // them, causing double-counting. Using the latest transaction date avoids this.
    if (latestTxISO) {
        const [y, m, d] = latestTxISO.split('-');
        statementDate = `${d}-${m}-${y}`;
    }

    // ── Ending cash snapshot entries ──────────────────────────────────────────
    // The Transaction History format gives amounts in base currency (EUR), so:
    //   - EUR deposits add to EUR cash
    //   - BUY in CAD subtracts from CAD cash (not EUR)
    // Without correction this creates a phantom negative CAD balance.
    // Fix: emit isEndingCash=true entries so the snapshot logic in processedImportData
    // and calculateNetBuys overrides running totals with the actual ending balances:
    //   - baseCurrency (EUR) → the real ending balance from the Summary section
    //   - each foreign currency used in trades → zero (IBKR converted everything to EUR)
    if (endingCash !== null) {
        const today = new Date();
        const snapDate = statementDate || `${String(today.getDate()).padStart(2, '0')}-${String(today.getMonth() + 1).padStart(2, '0')}-${today.getFullYear()}`;

        const makeCashEntry = (currency, amount) => ({
            index: -1,
            fecha: snapDate,
            hora: '23:59:59',
            producto: '',
            isin: `CASH_${currency}`,
            exchange: '',
            descripcion: `IBKR Ending Cash (${currency})`,
            type: 'CASH',
            isEndingCash: true,
            cantidad: 0,
            nombre: `Liquidez (${currency})`,
            precio: 1,
            moneda: currency,
            total: amount,
            comisiones: 0,
            idOrden: `IBKR-TH-ENDCASH-${currency}`,
            raw: [],
        });

        transactions.push(makeCashEntry(baseCurrency, endingCash));
        foreignCurrencies.forEach(cur => transactions.push(makeCashEntry(cur, 0)));
    }

    // ── Emit warning for unrecognised types ───────────────────────────────────
    if (unknownTypes.size > 0) {
        warnings.push({ code: 'ibkr_unknown_types', types: [...unknownTypes].sort() });
    }

    return transactions;
}

// ── Activity Statement format (legacy) ────────────────────────────────────────
// Original multi-section IBKR flex/activity report parser — kept for backward
// compatibility with previously imported Activity Statement CSVs.

function parseActivityStatement(lines, splitCSV, cleanNum, parseDate, warnings) {
    const transactions = [];
    let baseCurrency = 'EUR';
    let statementDate = '';
    const sectionHeaders = {};
    const instrumentMap = {};
    const unknownTypes = new Set();

    const getColIndex = (section, colName) => {
        const headers = sectionHeaders[section];
        if (!headers) return -1;
        return headers.indexOf(colName.toLowerCase());
    };

    // First pass: identify base currency, section headers, statement date and instruments
    lines.forEach(line => {
        const cols = splitCSV(line);
        const section = cols[0] ? cols[0].trim() : '';
        const type = cols[1];

        if (section === 'Statement' && type === 'Data' && cols[2] === 'Period') {
            const periodStr = cols[3];
            if (periodStr && periodStr.includes('-')) {
                const parts = periodStr.split('-');
                const endDateRaw = parts[1].trim();
                const d = new Date(endDateRaw);
                if (!isNaN(d)) {
                    statementDate = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
                }
            } else if (periodStr) {
                const d = new Date(periodStr);
                if (!isNaN(d)) statementDate = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
            }
        }

        if (section.includes('Account Information') && type === 'Data' && cols[2] && cols[2].includes('Base Currency')) {
            baseCurrency = cols[3].toUpperCase();
        }

        if (type === 'Header') {
            sectionHeaders[section] = cols.map(c => c.toLowerCase());
        }
    });

    // Sub-pass: identify instruments
    lines.forEach(line => {
        const cols = splitCSV(line);
        const section = cols[0] ? cols[0].trim() : '';
        const type = cols[1];

        if ((section.includes('Financial Instrument Information') || section.includes('Security Information')) && type === 'Data') {
            const symIdx  = getColIndex(section, 'symbol');
            const isinIdx = getColIndex(section, 'security id') !== -1 ? getColIndex(section, 'security id') : getColIndex(section, 'isin');
            const exchIdx = getColIndex(section, 'listing exch') !== -1 ? getColIndex(section, 'listing exch') : getColIndex(section, 'listing exchange');
            const nameIdx = getColIndex(section, 'description');
            const curIdx  = getColIndex(section, 'currency');

            if (symIdx !== -1) {
                const sym = cols[symIdx];
                const cur = curIdx !== -1 ? cols[curIdx] : '';
                const key = cur ? `${sym}|${cur}` : sym;
                instrumentMap[key] = {
                    isin: isinIdx !== -1 ? cols[isinIdx] : '',
                    exchange: exchIdx !== -1 ? cols[exchIdx] : '',
                    name: nameIdx !== -1 ? cols[nameIdx] : '',
                };
                if (!instrumentMap[sym]) instrumentMap[sym] = instrumentMap[key];
            }
        }
    });

    lines.forEach((line, index) => {
        const cols = splitCSV(line);
        const section = cols[0] ? cols[0].trim() : '';
        const type = cols[1];

        if (type !== 'Data') return;

        // 1. Trades / Transactions (BUY/SELL/DIVIDEND)
        if (section.includes('Trades') || section.includes('Transactions') || section.includes('Transaction History')) {
            const assetCategoryIdx = getColIndex(section, 'asset category');
            const transTypeIdx     = getColIndex(section, 'transaction type');

            if (assetCategoryIdx !== -1 && cols[assetCategoryIdx].toLowerCase().includes('forex')) return;
            if (transTypeIdx !== -1 && cols[transTypeIdx].toLowerCase().includes('forex')) return;

            const symbolIdx      = getColIndex(section, 'symbol');
            const dateTimeIdx    = getColIndex(section, 'date/time') !== -1 ? getColIndex(section, 'date/time') : getColIndex(section, 'date');
            const quantityIdx    = getColIndex(section, 'quantity');
            const priceIdx       = getColIndex(section, 't. price') !== -1 ? getColIndex(section, 't. price') : getColIndex(section, 'price');
            const currencyIdx    = getColIndex(section, 'currency') !== -1 ? getColIndex(section, 'currency') : getColIndex(section, 'price currency');
            const descriptionIdx = getColIndex(section, 'description');
            const netAmountIdx   = getColIndex(section, 'net amount');
            const commissionIdx  = getColIndex(section, 'commission');

            const ticker     = symbolIdx !== -1 ? cols[symbolIdx] : (cols[5] || '');
            const dateTime   = dateTimeIdx !== -1 ? cols[dateTimeIdx] : (cols[6] || '');
            const quantity   = cleanNum(quantityIdx !== -1 ? cols[quantityIdx] : cols[7]);
            const price      = cleanNum(priceIdx !== -1 ? cols[priceIdx] : cols[8]);
            const currency   = (currencyIdx !== -1 ? cols[currencyIdx] : (cols[4] || baseCurrency)).toUpperCase();
            const commission = commissionIdx !== -1 ? Math.abs(cleanNum(cols[commissionIdx])) : 0;

            let transTypeRaw = transTypeIdx !== -1 ? cols[transTypeIdx].toUpperCase() : (quantity > 0 ? 'BUY' : 'SELL');
            let transType = null;

            if (transTypeRaw.includes('BUY'))                                          transType = 'BUY';
            else if (transTypeRaw.includes('SELL'))                                    transType = 'SELL';
            else if (transTypeRaw.includes('DIVIDEND'))                                transType = 'DIVIDEND';
            else if (transTypeRaw.includes('TAX') || transTypeRaw.includes('WITHHOLDING')) transType = 'TAX';
            else if (transTypeRaw.includes('DEPOSIT') || transTypeRaw.includes('TRANSFER')) transType = 'TRANSFER';
            else if (transTypeRaw.includes('COMMISSION') || transTypeRaw.includes('FEE')) transType = 'FEE';
            else if (transTypeRaw.includes('INTEREST'))                                transType = 'INTEREST';

            if (transType === null) {
                if (transTypeRaw) unknownTypes.add(transTypeRaw);
                return;
            }

            if ((transType === 'BUY' || transType === 'SELL') && (isNaN(quantity) || quantity === 0)) return;
            const netAmount = netAmountIdx !== -1 ? cleanNum(cols[netAmountIdx]) : 0;
            if (transType !== 'BUY' && transType !== 'SELL' && netAmount === 0) return;

            // Resolve INTEREST to DIVIDEND (credit) or FEES (debit)
            if (transType === 'INTEREST') {
                transType = netAmount > 0 ? 'DIVIDEND' : 'FEE';
            }

            const total = netAmount !== 0 ? Math.abs(netAmount) : Math.abs(quantity * price);
            const { date, time } = parseDate(dateTime);

            const instr = instrumentMap[`${ticker}|${currency}`] || instrumentMap[ticker] || {};

            transactions.push({
                index,
                fecha: date,
                hora: time,
                producto: ticker || cols[descriptionIdx] || 'IBKR Item',
                isin: instr.isin || '',
                exchange: instr.exchange || '',
                descripcion: descriptionIdx !== -1 ? cols[descriptionIdx] : `IBKR ${section}: ${transType} ${ticker}`,
                type: transType,
                cantidad: Math.abs(quantity),
                nombre: instr.name || ticker || cols[descriptionIdx] || 'IBKR Item',
                precio: price,
                moneda: currency,
                total,
                comisiones: commission,
                idOrden: `IBKR-${section.toUpperCase().replace(/\s+/g, '-')}-${index}`,
                raw: cols,
            });
        }

        // 2. Cash Report Summaries
        if (section === 'Cash Report' || section === 'Statement of Funds') {
            const currencyIdx = getColIndex(section, 'currency') !== -1 ? getColIndex(section, 'currency') : 3;
            const detailIdx = getColIndex(section, 'currency summary') !== -1 ? getColIndex(section, 'currency summary') :
                (getColIndex(section, 'summary') !== -1 ? getColIndex(section, 'summary') :
                (getColIndex(section, 'report summary') !== -1 ? getColIndex(section, 'report summary') : 2));
            let valueIdx = getColIndex(section, 'total') !== -1 ? getColIndex(section, 'total') : 4;

            let currency = cols[currencyIdx];
            let detail   = cols[detailIdx];

            if (detail === 'Ending Cash') return;
            if (detail === 'Base Currency Summary' || (!detail && currency === 'Base Currency Summary')) {
                detail = cols[currencyIdx];
                currency = baseCurrency;
            } else if (!currency || currency.includes('Summary') || currency.length > 5) {
                currency = baseCurrency;
            }
            if (currency === 'Base Currency Summary' || cols.includes('Base Currency Summary')) return;

            const value = cleanNum(cols[valueIdx]);
            if (value === 0 && detail !== 'Ending Settled Cash') return;

            let transType = '';
            let label = '';

            if (detail === 'Commissions') { transType = 'FEE'; label = 'IBKR Commissions (Total)'; }
            else if (detail === 'Dividends') { transType = 'DIVIDEND'; label = 'IBKR Dividends (Total)'; }
            else if (detail === 'Deposits' || detail === 'Account Transfers' || detail === 'Withholding Tax') {
                transType = detail === 'Withholding Tax' ? 'TAX' : 'TRANSFER';
                label = `IBKR ${detail}`;
            } else if (detail === 'Ending Settled Cash') {
                transType = 'CASH';
                label = `Liquidez (${currency.toUpperCase()})`;
            }

            if (transType) {
                const now = new Date();
                const todayFormatted = `${String(now.getDate()).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}`;
                const resolvedDate = statementDate || todayFormatted;
                const actualValue = transType === 'CASH' ? value : Math.abs(value);

                transactions.push({
                    index,
                    fecha: resolvedDate,
                    hora: '23:59:00',
                    producto: label,
                    isin: '',
                    descripcion: `IBKR Statement: ${detail}`,
                    type: transType,
                    cantidad: 0,
                    nombre: label,
                    precio: 0,
                    moneda: currency.toUpperCase(),
                    total: actualValue,
                    idOrden: `IBKR-CASH-${currency.toUpperCase()}-${index}`,
                    isEndingCash: detail === 'Ending Settled Cash',
                    detail,
                    raw: cols,
                });
            }
        }

        // 3. Open Positions
        if (section.includes('Open Positions') || section.includes('Position Report')) {
            const symbolIdx    = getColIndex(section, 'symbol');
            const quantityIdx  = getColIndex(section, 'quantity');
            const priceIdx     = getColIndex(section, 'mark price') !== -1 ? getColIndex(section, 'mark price') : getColIndex(section, 'close price');
            const costBasisIdx = getColIndex(section, 'cost basis') !== -1 ? getColIndex(section, 'cost basis') : getColIndex(section, 'cost');
            const currencyIdx  = getColIndex(section, 'currency');

            if (symbolIdx !== -1 && quantityIdx !== -1 && (priceIdx !== -1 || costBasisIdx !== -1)) {
                const ticker    = cols[symbolIdx];
                const quantity  = cleanNum(cols[quantityIdx]);
                const price     = priceIdx !== -1 ? cleanNum(cols[priceIdx]) : 0;
                const costBasis = costBasisIdx !== -1 ? cleanNum(cols[costBasisIdx]) : 0;
                const currency  = currencyIdx !== -1 ? cols[currencyIdx].toUpperCase() : baseCurrency;

                if (Math.abs(quantity) < 0.00000001) return;

                const now = new Date();
                const fallbackDate = `${String(now.getDate()).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}`;
                const resolvedDate = statementDate || fallbackDate;

                const instr = instrumentMap[`${ticker}|${currency}`] || instrumentMap[ticker] || {};

                transactions.push({
                    index,
                    fecha: resolvedDate,
                    hora: '00:00:00',
                    producto: ticker,
                    isin: instr.isin || '',
                    exchange: instr.exchange || '',
                    descripcion: `IBKR Position: ${ticker}`,
                    type: 'BUY',
                    isConsolidated: true,
                    cantidad: Math.abs(quantity),
                    nombre: instr.name || ticker,
                    precio: quantity !== 0 ? Math.abs(costBasis / quantity) : price,
                    currentPrice: price,
                    moneda: currency,
                    total: Math.abs(costBasis || (quantity * price)),
                    comisiones: 0,
                    idOrden: `IBKR-POS-${index}`,
                    raw: cols,
                });
            }
        }
    });

    if (unknownTypes.size > 0) {
        warnings.push({ code: 'ibkr_unknown_types', types: [...unknownTypes].sort() });
    }

    return transactions;
}
