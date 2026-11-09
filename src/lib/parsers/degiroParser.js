/**
 * DEGIRO CSV Parser logic for Account.csv ("Estado de cuenta")
 *
 * Account.csv has the SAME 12-column layout in every DeGiro language:
 *   0 Fecha/Date · 1 Hora/Time · 2 Fecha valor/Value date · 3 Producto/Product ·
 *   4 ISIN · 5 Descripción/Description · 6 Tipo/FX (exchange rate) ·
 *   7 Variación/Change (currency) · 8 (amount, unnamed) ·
 *   9 Saldo/Balance (currency) · 10 (balance amount, unnamed) · 11 ID Orden/Order ID
 *
 * Only the header names and the description keywords change with the account
 * language — columns are resolved by name first and by POSITION as fallback,
 * and classification uses per-type multilingual keyword lists, so exports in
 * EN/DE/NL/FR/PT/IT parse the same as Spanish ones.
 *
 * Logic:
 * 1. Dividends often have a "Dividendo" row and a "Retención del dividendo" row.
 * 2. Trades have a Buy/Sell description row plus transaction-cost rows.
 * 3. Currency exchanges have credit + debit rows sharing the trade's order ID;
 *    the leg whose currency differs from the trade currency is the base-currency
 *    (EUR) cost — matched by CURRENCY, not by the Spanish "Retirada/Ingreso" text.
 */

// ── Multilingual keyword lists (checked against the lowercased description) ──
// Order matters: FX before BUY/SELL ("Ingreso Cambio de Divisa" contains
// "ingreso"), TAX before DIVIDEND ("Dividendbelasting" contains "dividend"),
// SELL before BUY ("Verkauf" contains "Kauf").
const KW = {
    FX: [
        'cambio de divisa',                       // ES
        'fx credit', 'fx debit', 'fx withdrawal', // EN
        'währungswechsel',                        // DE
        'valuta creditering', 'valuta debitering', 'valutawissel', // NL
        'opération de change', 'operation de change',              // FR
        'câmbio de divisa', 'cambio de moeda',    // PT
        'cambio valuta',                          // IT
    ],
    SELL: ['venta', 'sell', 'verkauf', 'verkoop', 'vente', 'venda', 'vendita'],
    BUY:  ['compra', 'buy', 'kauf', 'koop', 'aankoop', 'achat', 'acquisto'],
    TAX: [
        'retención',                               // ES
        'dividend tax', 'withholding',             // EN
        'dividendensteuer', 'kapitalertragsteuer', // DE
        'dividendbelasting',                       // NL
        'impôt sur', 'impot sur',                  // FR
        'imposto sobre',                           // PT
        'ritenuta',                                // IT
    ],
    DIVIDEND: ['dividendo', 'dividend', 'dividende'],
    FEE: [
        'comisión', 'costes de transacción', 'conectividad', 'impuesto', 'interés', // ES
        'commission', 'transaction costs', 'transaction fee', 'connection fee',
        'third party fees', 'stamp duty', 'interest', 'financial transaction tax', // EN
        'gebühr', 'transaktionskosten', 'zinsen',                                   // DE
        'kosten', 'transactiekosten',                                               // NL
        'frais', 'taxe', 'courtage', 'intérêts',                                    // FR
        'custo de conectividade', 'custos de transação', 'juros',                   // PT
        'commissione', 'costi di transazione', 'interessi',                         // IT
    ],
    CASH: ['sweep'],
    TRANSFER: [
        'ingreso', 'transferir', 'retirada',       // ES
        'deposit', 'withdrawal',                   // EN (also flatex rows)
        'einzahlung', 'auszahlung', 'überweisung', // DE
        'storting', 'opname',                      // NL (incl. iDEAL / terugstorting)
        'dépôt', 'retrait', 'versement',           // FR
        'depósito', 'levantamento',                // PT
        'versamento', 'prelievo', 'deposito',      // IT
    ],
};

// Trade description pattern, e.g. "Compra 3 Meta Platforms Inc@556,4886 USD (ISIN)"
// or "Buy 10 Apple Inc@150.42 USD (US0378331005)". Longer words go first so
// "Verkauf"/"Verkoop" are not half-matched as "Kauf"/"Koop".
const TRADE_RE = /(Compra|Venta|Buy|Sell|Verkauf|Kauf|Verkoop|Koop|Aankoop|Achat|Vente|Venda|Acquisto|Vendita)\s+([\d,.]+)\s+(.*?)\s*@\s*([\d,.]+)\s+([A-Z]{3})(?:\s+\((.*?)\))?/i;

// Signals that the user exported the OTHER DeGiro file (Transactions.csv):
// it has a venue/execution-centre column and no description column.
const TRANSACTIONS_FILE_COLS = [
    'bolsa de', 'centro de ejecución',            // ES
    'venue', 'execution centre', 'execution center', 'reference exchange', // EN
    'börse', 'ausführungsort',                    // DE
    'beurs', 'uitvoeringsplaats',                 // NL
    'place boursière', "lieu d'exécution",        // FR
    'bolsa de valores', 'centro de execução',     // PT
    'borsa', 'sede di esecuzione',                // IT
];

const DESCRIPTION_COLS = ['descripción', 'descripcion', 'description', 'beschreibung', 'omschrijving', 'descrição', 'descrizione'];

const matchKw = (descLower, list) => list.some(k => descLower.includes(k));

/** Classify a DeGiro row description into a transaction type. Order matters — see KW. */
export function classifyDegiroDescription(descripcion) {
    const descLower = (descripcion || '').toLowerCase();
    if (matchKw(descLower, KW.FX)) return 'CURRENCY_EXCHANGE';
    if (matchKw(descLower, KW.SELL)) return 'SELL';
    if (matchKw(descLower, KW.BUY)) return 'BUY';
    if (matchKw(descLower, KW.TAX)) return 'TAX';
    if (matchKw(descLower, KW.DIVIDEND)) return 'DIVIDEND';
    if (matchKw(descLower, KW.FEE)) return 'FEE';
    if (matchKw(descLower, KW.CASH)) return 'CASH';
    if (matchKw(descLower, KW.TRANSFER)) return 'TRANSFER';
    return 'OTHER';
}

// Shared preparation for parseDegiroCSV / auditDegiroLedger / listUnrecognizedDegiroRows:
// header split, wrong-file detection (throws), localized column resolution, raw row
// splitting and number-format detection. Returns null when the CSV is too short.
function prepareDegiroRows(csvText) {
    const lines = (csvText || '').replace(/^﻿/, '').split('\n').map(line => line.trim()).filter(line => line.length > 0);
    if (lines.length < 2) return null;

    // The header is not always line 1: text routed from the AI import carries a
    // "--- file.csv ---" separator, and hand-pasted exports may have preamble
    // lines. Locate it within the first lines: every DeGiro language names the
    // ISIN column literally "ISIN", and the header has 10+ columns.
    let headerIdx = 0;
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
        const delim = lines[i].includes(';') ? ';' : ',';
        if (/isin/i.test(lines[i]) && lines[i].split(delim).length >= 10) {
            headerIdx = i;
            break;
        }
    }

    const header = lines[headerIdx];
    const delimiter = header.includes(';') ? ';' : ',';
    // Split while respecting quotes
    const splitCSV = (text) => {
        const result = [];
        let cur = '';
        let inQuote = false;
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            if (char === '"') inQuote = !inQuote;
            else if (char === delimiter && !inQuote) {
                result.push(cur.trim());
                cur = '';
            } else cur += char;
        }
        result.push(cur.trim());
        return result;
    };

    const columns = splitCSV(header).map(col => col.replace(/"/g, ''));
    const headerLower = columns.map(c => c.toLowerCase());

    // Wrong-file detection: Transactions.csv instead of Account.csv. Surface a
    // typed error so the UI can explain exactly which export to use.
    const looksLikeTransactionsFile =
        headerLower.some(h => TRANSACTIONS_FILE_COLS.includes(h)) &&
        !headerLower.some(h => DESCRIPTION_COLS.includes(h));
    if (looksLikeTransactionsFile) {
        const err = new Error('DeGiro Transactions.csv detected — expected Account.csv');
        err.code = 'degiro_transactions_file';
        throw err;
    }

    // Column resolution: by localized name first, by fixed position as fallback,
    // so exports in any DeGiro language resolve to the right fields.
    const findCol = (names, fallback) => {
        for (const n of names) {
            const i = headerLower.indexOf(n);
            if (i !== -1) return i;
        }
        return fallback;
    };
    const IDX = {
        fecha:       findCol(['fecha', 'date', 'datum', 'data'], 0),
        hora:        findCol(['hora', 'time', 'uhrzeit', 'tijd', 'heure', 'ora'], 1),
        producto:    findCol(['producto', 'product', 'produkt', 'produit', 'prodotto', 'produto'], 3),
        isin:        findCol(['isin'], 4),
        descripcion: findCol(DESCRIPTION_COLS, 5),
        fxRate:      findCol(['tipo', 'fx'], 6),
        varCur:      findCol(['variación', 'variacion', 'change', 'änderung', 'mutatie', 'variation', 'variação', 'variazione'], 7),
        saldoCur:    findCol(['saldo', 'balance', 'solde'], 9),
        idOrden:     findCol(['id orden', 'order id', 'order-id', 'orden', 'ordre', 'id ordine'], 11),
    };
    // The numeric amounts live in the unnamed column right after their currency column
    IDX.varAmt = IDX.varCur + 1;
    IDX.saldoAmt = IDX.saldoCur + 1;

    const dataLines = lines.slice(headerIdx + 1);

    const rawTransactions = dataLines.map(line => {
        const values = splitCSV(line);
        const row = {};
        columns.forEach((col, i) => {
            if (col) row[col] = values[i] || '';
            else row[`col_${i}`] = values[i] || ''; // Handle empty header columns
        });
        return { row, values };
    });

    const cleanNum = (str, isEuropean = false) => {
        if (!str) return 0;
        let cleaned = str.replace(/[^-0-9,.]/g, '');

        // Unambiguous European case: 1.234,56
        if (cleaned.includes(',') && cleaned.includes('.')) {
            if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
                cleaned = cleaned.replace(/\./g, '').replace(',', '.');
            } else {
                cleaned = cleaned.replace(/,/g, '');
            }
        } else if (cleaned.includes(',')) {
            // Unambiguous decimal comma: 1234,56
            cleaned = cleaned.replace(',', '.');
        } else if (cleaned.includes('.') && isEuropean) {
            // Ambiguous dot in European mode: 1.690 vs 1.69
            // Standard European DeGiro Account CSV uses dot as thousands separator
            // If there's a dot followed by exactly 3 digits, it's likely a thousands separator
            const parts = cleaned.split('.');
            if (parts.length > 1 && parts[parts.length - 1].length === 3) {
                cleaned = cleaned.replace(/\./g, '');
            }
        }
        return parseFloat(cleaned) || 0;
    };

    // Detect European number format from data (dot=thousands, comma=decimal).
    // Comma-delimited DeGiro exports from Spain still use European number format.
    const sampleLines = lines.slice(1, Math.min(30, lines.length)).join('\n');
    const isEuropean = delimiter === ';' || /[",]\d{1,3}\.\d{3}[,"]/.test(sampleLines);

    return { columns, IDX, rawTransactions, cleanNum, isEuropean, lineOffset: headerIdx };
}

export function parseDegiroCSV(csvText) {
    const prepared = prepareDegiroRows(csvText);
    if (!prepared) return [];
    const { IDX, rawTransactions, cleanNum, isEuropean } = prepared;

    const processed = [];
    rawTransactions.forEach(({ row, values }, index) => {
        const fecha = values[IDX.fecha] || '';
        const hora = values[IDX.hora] || '';
        const isinCol = values[IDX.isin] || '';
        const descripcion = values[IDX.descripcion] || '';
        const idOrden = values[IDX.idOrden] || '';

        // Amount: unnamed column after the currency column, with legacy fallbacks
        const val8 = cleanNum(values[IDX.varAmt], isEuropean);
        const val7 = cleanNum(values[IDX.varCur], isEuropean);
        const val6 = cleanNum(values[IDX.fxRate], isEuropean);
        let variacion = val8 !== 0 ? val8 : (val7 !== 0 ? val7 : val6);

        // Determine type (multilingual keyword lists; order matters — see KW)
        const type = classifyDegiroDescription(descripcion);

        // Extract quantity, name, price, currency and ISIN from description
        let cantidad = 0;
        let precio = 0;
        let nombre = '';
        let moneda = 'EUR';
        let isinFromDesc = '';

        const buySellMatch = descripcion.match(TRADE_RE);
        if (buySellMatch) {
            cantidad = cleanNum(buySellMatch[2], isEuropean);
            nombre = buySellMatch[3].trim();
            precio = cleanNum(buySellMatch[4], isEuropean);
            moneda = buySellMatch[5].toUpperCase();
            isinFromDesc = buySellMatch[6] || '';

            // Handle GBX (pence) to GBP (pounds) conversion
            if (moneda === 'GBX') {
                precio = precio / 100;
                moneda = 'GBP';
            }
        }

        // Currency and amount for DeGiro's cash report rows (currency column + unnamed amount)
        if (!buySellMatch) {
            const varHeader = values[IDX.varCur] || '';
            const amtRaw = values[IDX.varAmt] || '';

            if (varHeader.length === 3 && /^[A-Z]{3}$/.test(varHeader)) {
                moneda = varHeader.toUpperCase();
                const amt = cleanNum(amtRaw, isEuropean);
                if (amt !== 0) variacion = amt;
            }
        }

        // Audited Balance Logic:
        // Ensure that for GBX stocks, if the variation is already in GBP (common in recent DeGiro reports),
        // we scale it correctly. Also fix the price if it was misinterpreted due to decimal/thousand separator issues.
        let finalTotal = variacion;
        let finalPrecio = precio;
        if (buySellMatch && buySellMatch[5].toUpperCase() === 'GBX') {
            const calculatedTotal = cantidad * precio; // precio is already normalized to GBP
            const ratio = Math.abs(variacion / calculatedTotal);

            // If the variation matches the expected total, all good
            if (Math.abs(ratio - 1) < 0.05) {
                finalTotal = variacion;
            } else if (Math.abs(ratio - 100) < 1) {
                // Variation is likely in GBX (pence), convert to GBP
                finalTotal = variacion / 100;
                finalPrecio = precio; // Price was likely correct
            } else if (Math.abs(ratio - 10) < 0.5 || Math.abs(ratio - 1000) < 10) {
                // Large discrepancy (factor 10, 1000 etc).
                // Trust variacion as the absolute cash movement and adjust price to match.
                finalTotal = variacion;
                if (cantidad > 0) finalPrecio = Math.abs(variacion / cantidad);
            } else {
                // Total fallback: use calculated if variation is very suspicious
                finalTotal = (variacion < 0 ? -1 : 1) * calculatedTotal;
            }
        }

        const productIdentifier = nombre ? `${nombre} (${moneda})` : (descripcion ? `${descripcion.substring(0, 30)} (${moneda})` : `Unknown (${moneda})`);

        processed.push({
            fecha,
            hora,
            producto: productIdentifier,
            isin: isinFromDesc || isinCol,
            descripcion: descripcion,
            type: type,
            cantidad: cantidad,
            nombre: productIdentifier,
            id_activo: productIdentifier, // Explicit ID_ACTIVO as requested
            price: finalPrecio,
            precio: finalPrecio,
            moneda: moneda,
            total: finalTotal,
            idOrden: idOrden,
            index,
            raw: row
        });
    });

    // Merge logic for Account.csv
    const merged = [];
    const usedIndices = new Set();

    processed.forEach((item, idx) => {
        if (usedIndices.has(idx)) return;

        // 1. Merge Buy/Sell with their Commissions/Fees/Currency exchanges (share same ID Orden).
        // The WHOLE order group (all partial fills + related rows) is processed in one pass:
        // the old per-fill logic marked fee/FX rows as used on the first fill, so fills 2..n
        // got comisiones=0 and totalEUR=undefined — 40% of a 60/40 split order's commission
        // and EUR cost basis silently disappeared.
        if (item.type === 'BUY' || item.type === 'SELL') {
            // All fills of this order (this row + unused siblings with the same order ID)
            const siblingBuySells = item.idOrden ? processed.filter((p, pIdx) =>
                !usedIndices.has(pIdx) &&
                pIdx !== idx &&
                p.idOrden === item.idOrden &&
                (p.type === 'BUY' || p.type === 'SELL')
            ) : [];
            const fills = [item, ...siblingBuySells];
            const totalShares = fills.reduce((s, f) => s + f.cantidad, 0);

            const related = item.idOrden ? processed.filter((p, pIdx) =>
                !usedIndices.has(pIdx) &&
                p.idOrden === item.idOrden &&
                p.type !== 'BUY' && p.type !== 'SELL'
            ) : [];

            let feeTotal = 0;
            let totalInEUR = 0;
            let totalFXInNativeCurrency = 0;

            related.forEach(r => {
                if (r.type === 'FEE') feeTotal += Math.abs(r.total);

                // FX legs are matched by CURRENCY, not by localized description text:
                // the leg in a currency DIFFERENT from the trade's is the base-currency
                // (EUR) side (the real EUR cost/proceeds); the leg in the trade's own
                // currency is the native side, used to prorate partial fills.
                if (r.type === 'CURRENCY_EXCHANGE') {
                    if ((r.moneda || 'EUR') !== item.moneda) {
                        totalInEUR += r.total;
                    } else {
                        totalFXInNativeCurrency += Math.abs(r.total);
                    }
                }

                // Mark fees and currency exchanges as processed so they don't appear as standalone rows
                if (r.type === 'FEE' || r.type === 'CURRENCY_EXCHANGE') {
                    usedIndices.add(r.index);
                }
            });

            // Distribute fees and EUR cost across ALL fills:
            // fees proportional to share count; EUR cost proportional to each fill's
            // native amount (falls back to share fraction when native totals are 0).
            fills.forEach(fill => {
                const shareFraction = totalShares > 0 ? fill.cantidad / totalShares : 1;
                const nativeFraction = totalFXInNativeCurrency > 0
                    ? Math.abs(fill.total) / totalFXInNativeCurrency
                    : shareFraction;

                fill.comisiones = feeTotal * shareFraction;

                const suffix = ` (${fill.moneda})`;
                if (fill.moneda === 'EUR') {
                    fill.classification = fill.type === 'BUY' ? 'Compra Directa (EUR)' : 'Venta Directa (EUR)';
                } else {
                    fill.classification = fill.type === 'BUY' ? `Compra Internacional${suffix}` : `Venta Internacional${suffix}`;
                    // If we found a currency exchange row, use that as the real EUR cost
                    if (totalInEUR !== 0) {
                        fill.totalEUR = Math.abs(totalInEUR * nativeFraction); // Real EUR cost basis
                        fill.hasFX = true;
                    }
                }

                merged.push(fill);
                usedIndices.add(fill.index);
            });
        }
        // 2. Merge Dividend with Retention (same date, same product)
        else if (item.type === 'DIVIDEND') {
            const related = processed.filter((p, pIdx) =>
                !usedIndices.has(pIdx) &&
                pIdx !== idx &&
                p.fecha === item.fecha &&
                (p.producto === item.producto || p.isin === item.isin) &&
                (p.type === 'TAX' || p.type === 'DIVIDEND')
            );

            let totalDividendo = item.total;
            related.forEach(r => {
                totalDividendo += r.total; // Sums negative retention or additional dividend lines
                usedIndices.add(r.index);
            });

            item.total = totalDividendo;
            merged.push(item);
            usedIndices.add(idx);
        }
    });

    // Add remaining rows
    processed.forEach((item, idx) => {
        if (!usedIndices.has(idx)) {
            // Keep everything except known noise or specific types that break logic
            if (item.type !== 'OTHER' && item.type !== 'CURRENCY_EXCHANGE') {
                merged.push(item);
            }
        }
    });

    // Final snapshots for DeGiro: Extract "Saldo" for each currency to fix current cash
    // Rule: Sum the value of 'Saldo' from the FIRST encountered row for each unique currency (latest)
    const sortedForSnapshots = [...processed].sort((a, b) => {
        // We want the FIRST encountered row in the file for each currency
        // The file is typically date-descending (newest at top), so index 0 is newest.
        if (a.fecha !== b.fecha) {
            const da = a.fecha.split('-').reverse().join('-');
            const db = b.fecha.split('-').reverse().join('-');
            return db.localeCompare(da);
        }
        if (a.hora !== b.hora) return (b.hora || '').localeCompare(a.hora || '');
        return a.index - b.index; // Newest first (lowest index)
    });

    const cashSnapshots = {};

    sortedForSnapshots.forEach(item => {
        // Balance amount lives in the unnamed column right after the balance
        // currency column; older formats put the value in the currency column itself.
        const values = rawTransactions[item.index]?.values || [];
        const saldoAmtRaw = values[IDX.saldoAmt];
        const saldoCurRaw = values[IDX.saldoCur];

        let saldo = 0;
        const valAmt = cleanNum(saldoAmtRaw, isEuropean);
        const valCur = cleanNum(saldoCurRaw, isEuropean);

        if (valAmt !== 0) saldo = valAmt;
        else if (valCur !== 0) saldo = valCur;
        else {
            // Check if it's explicitly 0 but valid
            const isZero = (v) => v === '0,00' || v === '0.00' || v === '"0,00"' || v === '"0.00"';
            if (isZero(saldoAmtRaw) || isZero(saldoCurRaw)) saldo = 0;
            else return; // Truly empty
        }

        const cur = item.moneda || 'EUR';
        // User instruction: The FIRST row for EACH currency should be the snapshot
        if (cashSnapshots[cur] === undefined) {
            cashSnapshots[cur] = saldo;
        }
    });

    Object.entries(cashSnapshots).forEach(([cur, balance], i) => {
        merged.push({
            index: 10000 + i,
            fecha: processed[0]?.fecha || '',
            hora: '23:59:59',
            producto: `Líquidez (${cur})`,
            isin: `CASH_${cur}`,
            descripcion: `Saldo Final: ${cur}`,
            type: 'CASH',
            isEndingCash: true,
            moneda: cur,
            total: balance,
            raw: {}
        });
    });

    return merged.sort((a, b) => {
        // Handle potentially missing/invalid dates
        if (!a.fecha || !b.fecha) return 0;
        const partA = a.fecha.split('-');
        const partB = b.fecha.split('-');
        if (partA.length !== 3 || partB.length !== 3) return 0;

        // Use time if available for better sorting of snapshots
        const timeA = a.hora ? a.hora.split(':') : [0, 0, 0];
        const timeB = b.hora ? b.hora.split(':') : [0, 0, 0];

        const dateA = new Date(partA[2], partA[1] - 1, partA[0], ...timeA);
        const dateB = new Date(partB[2], partB[1] - 1, partB[0], ...timeB);
        return dateB - dateA;
    });
}

/**
 * Self-validation: Account.csv is a LEDGER — every row carries the resulting
 * balance, so the file can audit its own parsing. Per currency, consecutive
 * rows must satisfy: saldo_newer = saldo_older + variación_newer.
 *
 * This is format-independent proof of correct number/column interpretation:
 * if the parser misreads amounts (wrong decimal separator, shifted column),
 * the chain breaks and we know at WHICH line.
 *
 * The file is normally newest-first; both directions are tried and the one
 * that reconciles better wins (protects against re-sorted exports).
 *
 * @returns {null | { checked: number, matched: number,
 *                    mismatches: Array<{line:number, currency:string, expected:number, actual:number}> }}
 *          null when the CSV is unusable or has no balance data to check.
 */
export function auditDegiroLedger(csvText) {
    const prepared = prepareDegiroRows(csvText);
    if (!prepared) return null;
    const { IDX, rawTransactions, cleanNum, isEuropean, lineOffset } = prepared;

    // Extract per-row ledger fields; skip rows without an explicit balance.
    const ledgerRows = [];
    rawTransactions.forEach(({ values }, i) => {
        const curRaw = (values[IDX.varCur] || '').trim();
        const saldoRaw = (values[IDX.saldoAmt] || '').trim();
        if (!/^[A-Z]{3}$/.test(curRaw) || saldoRaw === '') return;
        ledgerRows.push({
            line: i + 2 + lineOffset, // 1-based file line (header may not be line 1)
            currency: curRaw,
            amount: cleanNum(values[IDX.varAmt], isEuropean),
            saldo: cleanNum(saldoRaw, isEuropean),
        });
    });
    if (ledgerRows.length < 2) return null;

    // rows assumed newest-first: newer.saldo = older.saldo + newer.amount
    const runChain = (rows) => {
        const pending = {}; // currency → newer row awaiting its older neighbour
        let checked = 0, matched = 0;
        const mismatches = [];
        for (const row of rows) {
            const prev = pending[row.currency];
            if (prev) {
                checked++;
                const expected = row.saldo + prev.amount;
                if (Math.abs(expected - prev.saldo) < 0.011) matched++;
                else mismatches.push({ line: prev.line, currency: prev.currency, expected, actual: prev.saldo });
            }
            pending[row.currency] = row;
        }
        return { checked, matched, mismatches };
    };

    const forward = runChain(ledgerRows);
    if (forward.checked === 0) return null;
    if (forward.matched >= forward.checked * 0.5) return forward;

    // Mostly failing → the file is probably oldest-first; try reversed.
    const backward = runChain([...ledgerRows].reverse());
    return backward.matched > forward.matched ? backward : forward;
}

/**
 * Rows whose description matches NO keyword list (type OTHER) — the exact gap
 * in language/keyword coverage. Shown to the user in the preview ("X filas no
 * reconocidas") and sent (deduped) to telemetry so missing keywords surface
 * in the admin panel instead of silently dropping data.
 */
export function listUnrecognizedDegiroRows(csvText) {
    const prepared = prepareDegiroRows(csvText);
    if (!prepared) return [];
    const { IDX, rawTransactions, lineOffset } = prepared;

    const unrecognized = [];
    rawTransactions.forEach(({ values }, i) => {
        const descripcion = (values[IDX.descripcion] || '').trim();
        if (!descripcion) return;
        if (classifyDegiroDescription(descripcion) === 'OTHER') {
            unrecognized.push({
                line: i + 2 + lineOffset,
                fecha: values[IDX.fecha] || '',
                descripcion,
            });
        }
    });
    return unrecognized;
}
