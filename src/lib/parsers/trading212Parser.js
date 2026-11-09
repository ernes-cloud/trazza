/**
 * Trading 212 — historial de la cuenta exportado en CSV (Menú → Historial → Exportar).
 *
 * Construido SIN un fichero real (2026-10-03): el formato sale de fuentes
 * públicas contrastadas — la comunidad de Trading 212, guías de importación de
 * varios trackers y, sobre todo, el parser mantenido de cgt-calc (calculadora
 * de plusvalías open source del Reino Unido, probada con exportaciones reales).
 * Los fixtures de los tests son SINTÉTICOS con esa forma exacta.
 *
 * Lo que hay que saber del formato:
 *  - Una fila por evento. `Action` dice qué es: "Market buy", "Limit sell",
 *    "Dividend (Ordinary)", "Deposit", "Interest on cash"…
 *  - Las columnas CAMBIAN de un export a otro: solo salen las que tienen datos
 *    en el periodo, y las antiguas llevan la divisa de la cuenta en el nombre
 *    ("Total (EUR)", "Result (GBP)") donde las nuevas traen una columna aparte
 *    ("Total" + "Currency (Total)"). Por eso se localizan por nombre BASE.
 *  - "Time" en las antiguas, "Time (UTC)" en las nuevas; siempre en UTC.
 *  - `Total` va en la divisa de la CUENTA e INCLUYE las comisiones; en los
 *    dividendos va NETO de retención.
 *  - `Exchange rate` = divisa del valor por unidad de divisa de la cuenta
 *    (USD por EUR): precio en USD = precio en EUR × tipo.
 *  - Las comisiones van en columnas propias (Transaction fee, Finra fee, Stamp
 *    duty, French transaction tax, Currency conversion fee…), cada una con su
 *    "Currency (…)" o con la divisa de la cuenta en el nombre.
 *
 * Forma de salida: la MISMA que el parser de IBKR (historial de transacciones),
 * que resuelve el mismo problema —cuenta en EUR, valores en USD—: precio y total
 * en la divisa del valor, `comisiones` en la de la cuenta (no se mezclan con el
 * coste en USD), y `totalEUR` = importe bruto en euros cuando la cuenta es EUR.
 *
 * Liquidez: el export NO trae saldo. El ledger de caja de calculateNetBuys
 * restaría cada compra en USD de una caja en USD que nunca existió (saldos
 * negativos inventados). Así que aquí se calcula el saldo de la cuenta con los
 * `Total` del propio fichero y se emite como foto final (`isEndingCash`), igual
 * que MyInvestor con su columna de saldo; las divisas de los valores quedan a 0.
 */

import { splitDelimitedLine } from './bank/bankCsv.js';
import { leerNumero } from './formatDescriptor.js';

const BUY_RE = /^(market|limit|stop|stop limit) buy$/i;
const SELL_RE = /^(market|limit|stop|stop limit) sell$/i;
const DIVIDEND_RE = /^dividend \(/i; // "Dividend (Ordinary)", "(Dividends paid by us corporations)"…
const INTEREST = new Set(['interest on cash', 'lending interest']);
const CASH_IN = new Set(['deposit', 'card credit', 'card refund', 'spending cashback']);
const CASH_OUT = new Set(['withdrawal', 'card debit']);
const CASH_SIGNED = new Set(['result adjustment', 'dividend adjustment']);
// Movimiento interno entre subcuentas de divisa: no entra ni sale dinero.
const INTERNAL = new Set(['currency conversion']);

// Columnas que NO son comisiones aunque su nombre lo parezca.
const NOT_A_FEE = new Set(['withholding tax']);
const FEE_NAME_RE = /fee|tax|duty|charge/i;

const SNAPSHOT_TIME = '23:59:59';

const norm = (s) => String(s || '').trim().toLowerCase();

/** "Total (EUR)" → { base: 'total', currency: 'EUR' }; "Currency (Total)" → { base: 'currency (total)' }. */
function splitHeader(header) {
  const raw = String(header || '').trim();
  const m = raw.match(/^(.*?)\s*\(([A-Z]{3})\)$/);
  if (m) return { base: norm(m[1]), currency: m[2] };
  return { base: norm(raw), currency: null };
}

/** Fecha de Trading 212 → { fecha: 'DD-MM-YYYY', hora: 'HH:MM:SS' }. */
export function parseT212Time(raw) {
  const s = String(raw || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) return { fecha: `${m[3]}-${m[2]}-${m[1]}`, hora: `${m[4]}:${m[5]}:${m[6] || '00'}` };
  // Re-guardado con Excel en España: "01/08/2025 07:00"
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const dd = m[1].padStart(2, '0'); const mm = m[2].padStart(2, '0');
    return { fecha: `${dd}-${mm}-${m[3]}`, hora: `${(m[4] || '00').padStart(2, '0')}:${m[5] || '00'}:${m[6] || '00'}` };
  }
  return null;
}

/** ¿Es este texto un export de Trading 212? Cabecera con Action + Time + No. of shares. */
export function isTrading212Csv(text) {
  const first = String(text || '').split(/\r?\n/).find((l) => l.trim());
  if (!first) return false;
  const delim = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const bases = splitDelimitedLine(first.replace(/^﻿/, ''), delim).map((h) => splitHeader(h).base);
  return bases.includes('action') && (bases.includes('time') || bases.includes('time (utc)')) && bases.includes('no. of shares');
}

/**
 * @param {string} csvText
 * @returns {{ transactions: Array<object>, warnings: Array<{code: string, types?: string[], symbols?: string[], amount?: number, currency?: string}> }}
 */
export function parseTrading212CSV(csvText) {
  const lines = String(csvText || '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2 || !isTrading212Csv(lines[0])) return { transactions: [], warnings: [] };

  const delim = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
  const decimal = delim === ';' ? ',' : '.';
  const headers = splitDelimitedLine(lines[0], delim).map(splitHeader);
  const idx = (base) => headers.findIndex((h) => h.base === base);

  const col = {
    action: idx('action'),
    time: idx('time') >= 0 ? idx('time') : idx('time (utc)'),
    isin: idx('isin'),
    ticker: idx('ticker'),
    name: idx('name'),
    shares: idx('no. of shares'),
    price: idx('price / share'),
    priceCur: idx('currency (price / share)'),
    fx: idx('exchange rate'),
    total: idx('total'),
    totalCur: idx('currency (total)'),
    wht: idx('withholding tax'),
    whtCur: idx('currency (withholding tax)'),
    id: idx('id'),
    notes: idx('notes'),
  };

  // Comisiones: toda columna con fee/tax/duty/charge salvo la retención y las
  // "Currency (…)". Así una columna NUEVA de Trading 212 se cuenta sin tocar código.
  const feeCols = headers
    .map((h, i) => ({ ...h, i }))
    .filter((h) => FEE_NAME_RE.test(h.base) && !NOT_A_FEE.has(h.base) && !h.base.startsWith('currency ('))
    .map((h) => ({ i: h.i, base: h.base, suffixCur: h.currency, curCol: idx(`currency (${h.base})`) }));

  const num = (cells, i) => (i >= 0 ? leerNumero(cells[i], decimal) : null);
  const txt = (cells, i) => (i >= 0 ? String(cells[i] || '').trim() : '');

  // Divisa de la cuenta: la columna "Currency (Total)" o el sufijo "Total (EUR)".
  const totalHeaderCur = col.total >= 0 ? headers[col.total].currency : null;

  const transactions = [];
  const unsupported = new Set();
  const splitTickers = new Set();
  const instrumentCurrencies = new Set();
  let cash = 0;
  let accountCur = null;
  let lastFecha = null;

  lines.slice(1).forEach((line, n) => {
    const cells = splitDelimitedLine(line, delim);
    const action = txt(cells, col.action);
    const kind = norm(action);
    if (!action) return;
    const when = parseT212Time(txt(cells, col.time));
    if (!when) return;
    lastFecha = when.fecha;

    const rowCur = (txt(cells, col.totalCur) || totalHeaderCur || accountCur || 'EUR').toUpperCase();
    accountCur = accountCur || rowCur;
    const total = Math.abs(num(cells, col.total) ?? 0);
    const ticker = txt(cells, col.ticker);
    const isin = txt(cells, col.isin);
    const name = txt(cells, col.name) || ticker;
    const id = txt(cells, col.id) || `T212-${n + 1}`;
    const base = {
      index: n + 1, fecha: when.fecha, hora: when.hora, exchange: '',
      idOrden: id, raw: cells,
    };

    // ── Compras y ventas ────────────────────────────────────────────────────
    const isBuy = BUY_RE.test(action);
    const isSell = SELL_RE.test(action);
    if (isBuy || isSell) {
      const qty = Math.abs(num(cells, col.shares) ?? 0);
      if (!qty) return;
      let priceCur = (txt(cells, col.priceCur) || rowCur).toUpperCase();
      let price = Math.abs(num(cells, col.price) ?? 0);
      let fx = num(cells, col.fx) || 1;
      // Peniques: a libras, igual que el resto de parsers. El tipo de cambio
      // también venía en peniques por unidad de la cuenta.
      if (priceCur === 'GBX') { price /= 100; fx /= 100; priceCur = 'GBP'; }
      if (priceCur === rowCur) fx = 1;

      // Comisiones en la divisa de la cuenta.
      let fees = 0;
      for (const f of feeCols) {
        const amt = Math.abs(leerNumero(cells[f.i], decimal) ?? 0);
        if (!amt) continue;
        const cur = (f.curCol >= 0 ? txt(cells, f.curCol) : f.suffixCur || rowCur).toUpperCase() || rowCur;
        if (cur === rowCur) fees += amt;
        else if (cur === priceCur && fx) fees += amt / fx;
        // otra divisa sin tipo conocido: no se puede convertir con el propio export
      }

      // Sin precio, se deduce del total (que incluye comisiones en las compras).
      if (!price && total) {
        const grossAcct = isBuy ? total - fees : total + fees;
        price = (grossAcct * fx) / qty;
      }
      if (!price) return;

      const grossAcct = isBuy ? total - fees : total + fees;
      if (priceCur !== rowCur) instrumentCurrencies.add(priceCur);
      cash += isBuy ? -total : total;
      transactions.push({
        ...base,
        producto: ticker || isin,
        isin,
        nombre: name,
        descripcion: `${action} ${qty} ${ticker || isin} @ ${price} ${priceCur}`,
        type: isBuy ? 'BUY' : 'SELL',
        cantidad: qty,
        precio: price,
        moneda: priceCur,
        total: qty * price,
        comisiones: fees,
        ...(rowCur === 'EUR' && grossAcct > 0 ? { totalEUR: grossAcct } : {}),
      });
      return;
    }

    // ── Dividendos (también los intereses de un fondo monetario con ISIN) ──
    if (DIVIDEND_RE.test(action)) {
      if (!total) return;
      const wht = Math.abs(num(cells, col.wht) ?? 0);
      const whtCur = txt(cells, col.whtCur);
      cash += total;
      transactions.push({
        ...base,
        producto: ticker || isin || name,
        isin,
        nombre: name,
        descripcion: wht
          ? `${action} ${ticker} (neto; retención ${wht}${whtCur ? ` ${whtCur}` : ''})`
          : `${action} ${ticker}`,
        type: 'DIVIDEND',
        cantidad: 0,
        precio: 0,
        moneda: rowCur, // Total va en la divisa de la cuenta, ya neto de retención
        total,
        comisiones: 0,
      });
      return;
    }

    // ── Intereses de la liquidez: ingreso sin valor detrás (como IBKR) ──────
    if (INTEREST.has(kind)) {
      if (!total) return;
      cash += total;
      transactions.push({
        ...base, producto: action, isin: '', nombre: action, descripcion: action,
        type: 'DIVIDEND', cantidad: 0, precio: 0, moneda: rowCur, total, comisiones: 0,
      });
      return;
    }

    // ── Movimientos de dinero ────────────────────────────────────────────────
    if (CASH_IN.has(kind) || CASH_OUT.has(kind) || CASH_SIGNED.has(kind)) {
      const signed = CASH_IN.has(kind) ? total
        : CASH_OUT.has(kind) ? -total
          : (num(cells, col.total) ?? 0);
      if (!signed) return;
      cash += signed;
      transactions.push({
        ...base, producto: action, isin: '', nombre: action,
        descripcion: [action, txt(cells, col.notes)].filter(Boolean).join(' · '),
        type: 'TRANSFER', cantidad: 0, precio: 0, moneda: rowCur, total: signed, comisiones: 0,
      });
      return;
    }

    if (INTERNAL.has(kind)) return;

    // ── Lo que no se importa: se dice en la vista previa ────────────────────
    if (/stock split/i.test(action)) { if (ticker) splitTickers.add(ticker); return; }
    unsupported.add(action);
  });

  if (transactions.length === 0) return { transactions: [], warnings: [] };

  // Foto de caja final: el saldo de la cuenta según el propio fichero, y cero
  // para las divisas de los valores (ese dinero nunca estuvo en la cuenta).
  const acct = accountCur || 'EUR';
  const snap = (cur, amount) => ({
    fecha: lastFecha, hora: SNAPSHOT_TIME,
    producto: `Liquidez (${cur})`, isin: `CASH_${cur}`, descripcion: `Saldo Final: ${cur}`,
    type: 'CASH', cantidad: 0, precio: 0, total: amount, moneda: cur, comisiones: 0,
    isEndingCash: true,
  });
  transactions.push(snap(acct, Math.round(cash * 100) / 100));
  for (const cur of instrumentCurrencies) if (cur !== acct) transactions.push(snap(cur, 0));

  const warnings = [];
  if (cash < -0.01) warnings.push({ code: 't212_cash_incomplete', amount: Math.round(cash * 100) / 100, currency: acct });
  if (splitTickers.size) warnings.push({ code: 't212_stock_splits', symbols: [...splitTickers] });
  if (unsupported.size) warnings.push({ code: 't212_unsupported_actions', types: [...unsupported] });

  return { transactions, warnings };
}
