/**
 * Deterministic mapper: neutral freeform-AI schema → internal Trazza schema.
 *
 * The LLM (server /api/parse-freeform) ONLY extracts what is literally in the
 * pasted text into the neutral schema:
 *   { date: 'YYYY-MM-DD'|null, ticker, assetName, type: BUY|SELL|DIVIDEND|DEPOSIT|WITHDRAWAL|FEE,
 *     quantity, price, amount, currency, sourceLine }
 * (quantity/price/amount are always positive — direction is carried by type).
 *
 * This module owns everything financial-critical and is unit-tested:
 *   - sign conventions of `total` (negative = cost, positive = receipt)
 *   - total fallback qty × price when no explicit amount was extracted
 *   - type mapping to internal types (DEPOSIT/WITHDRAWAL → TRANSFER, FEE → FEES)
 *   - row validation (which null fields block the import)
 *
 * Output rows match the schema produced by the broker parsers / analyzeCsv:
 *   { fecha: 'DD-MM-YYYY', hora, type, producto, nombre, isin, cantidad,
 *     precio, total, moneda, comisiones, isAIParsed }
 * `producto` carries the quote symbol (AAPL, SAN.MC, BTC-USD); `isin` is left
 * empty unless a real ISIN is known — CarteraPage skips rows with a non-empty
 * malformed ISIN, and getAssetIdentifiers('freeform') keys assets by symbol.
 */

// HOLDING = a current-position snapshot (portfolio table row): quantity held at
// the average purchase / break-even price. Maps to a BUY *marked isConsolidated*
// so the position and its cost basis exist WITHOUT the snapshot being replayed as
// a cash-moving purchase; the user supplies the (approximate) date in the HITL.
export const FREEFORM_TYPES = ['BUY', 'SELL', 'DIVIDEND', 'DEPOSIT', 'WITHDRAWAL', 'FEE', 'HOLDING'];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const ISIN_RE     = /^[A-Z]{2}[A-Z0-9]{10}$/;

const num = (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return (typeof n === 'number' && Number.isFinite(n) && n > 0) ? n : null;
};

// Money is cents-precision: qty × price carries float noise (100 × 4.9 =
// 490.00000000000006) that would leak into totals and dedupe keys.
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Returns the list of fields that block the import for a neutral row.
 * Empty array = row is complete and safe to map.
 * Field names: 'date' | 'type' | 'ticker' | 'quantity' | 'price' | 'amount' | 'currency'
 */
export function validateFreeformRow(row) {
  const issues = [];
  const r = row || {};

  if (!r.date || !ISO_DATE_RE.test(r.date)) issues.push('date');
  if (!FREEFORM_TYPES.includes(r.type)) issues.push('type');
  if (!r.currency || !CURRENCY_RE.test(String(r.currency).toUpperCase())) issues.push('currency');

  // Asset rows need a resolvable quote symbol — a bare company name cannot be
  // saved (assets are keyed by ticker). The HITL table resolves it before import.
  if (['BUY', 'SELL', 'DIVIDEND', 'HOLDING'].includes(r.type) && !String(r.ticker || '').trim()) {
    issues.push('ticker');
  }

  if (['BUY', 'SELL', 'HOLDING'].includes(r.type)) {
    if (num(r.quantity) == null) issues.push('quantity');
    if (num(r.price) == null) issues.push('price');
  }

  // Money-only rows are meaningless without an amount — never default to 0
  if (['DIVIDEND', 'DEPOSIT', 'WITHDRAWAL', 'FEE'].includes(r.type) && num(r.amount) == null) {
    issues.push('amount');
  }

  return issues;
}

/** 'YYYY-MM-DD' → 'DD-MM-YYYY' (internal Trazza date format). */
export function isoToTrazzaDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
}

// ── Automatic ticker resolution by asset NAME ────────────────────────────────
// The AI often extracts only the company/fund name ("Iberdrola") — instead of
// making the user type the symbol in the HITL table, resolve it with a quote
// search. The user still sees (and can edit) the auto-filled cell before
// confirming; unresolvable names stay pending exactly as before.

import { inferTickerCurrency, strictResolveTicker } from '../tickerMap.js';
import { fundNameMatches, curatedIsinForFundName } from '../../services/import/fundNavEnricher.js';

const RESOLVABLE_TYPES = new Set(['BUY', 'SELL', 'DIVIDEND', 'HOLDING']);
// \betc\b: Yahoo types crypto/commodity ETPs as 'ETC' (BTCE, physical gold…)
const QUOTABLE_RESULT_TYPES = /equity|etf|\betc\b|mutualfund|cryptocurrency|currency|index/i;

const normalizeForMatch = (s) =>
  (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Best quote symbol for an asset name, or null. Among valid candidates,
 * listings quoting in the row's currency win (SAN.MC over the SAN ADR for a
 * EUR row).
 *
 * La validación es `fundNameMatches` — la MISMA que usa el enricher de NAV —
 * y no una comprobación propia. La que había aquí solo exigía que la primera
 * palabra del nombre apareciera en el candidato, y para un fondo esa palabra
 * es la GESTORA, que comparten cientos de productos: pegando una cartera
 * gestionada de MyInvestor, "VANGUARD 20+ Year Euro Treasury" y "Vanguard US
 * Government Bond" se resolvieron LOS DOS a VOO (el S&P 500), y
 * "Fidelity MSCI Pacific ex-Japan" a FBGRX (Blue Chip Growth). Un ticker
 * equivocado no se ve en la tabla de revisión y valora la posición con el NAV
 * de otro producto para siempre, así que aquí se prefiere dejar la celda
 * vacía —que el usuario ve en ámbar— antes que acertar por casualidad.
 */
function pickSymbolForName(assetName, currency, results) {
  if (!normalizeForMatch(assetName)) return null;

  const candidates = (results || []).filter(
    (r) =>
      r.symbol &&
      QUOTABLE_RESULT_TYPES.test(r.type || '') &&
      fundNameMatches(assetName, r.description)
  );
  if (candidates.length === 0) return null;

  const wanted = String(currency || '').toUpperCase();
  const currencyMatch = wanted
    ? candidates.find((r) => inferTickerCurrency(r.symbol) === wanted)
    : null;
  return (currencyMatch || candidates[0]).symbol;
}

/* Palabras con las que un extracto ENCABEZA la descripción de un movimiento.
   Solo se recorta si el nombre EMPIEZA por una de ellas: así "Fondo Ibercaja
   Selección" (un fondo que de verdad se llama así) se queda intacto. */
const OPERATION_HEAD = new Set([
  'suscripcion', 'suscripciones', 'compra', 'compras', 'venta', 'ventas',
  'reembolso', 'reembolsos', 'dividendo', 'dividendos', 'aportacion',
  'traspaso', 'abono', 'cargo', 'liquidac', 'orden', 'ordenes',
]);
/* Relleno que acompaña a esa cabecera y tampoco forma parte del nombre. */
const OPERATION_FILLER = new Set([
  'iic', 'fondos', 'fondo', 'de', 'del', 'la', 'el', 'los', 'las',
  'inversion', 'inversiones', 'en', 'por', 'a',
]);

/**
 * Quita del nombre la etiqueta de la operación: "Suscripción Fondos de
 * Inversión Fidelity MSCI Japan…" → "Fidelity MSCI Japan…".
 *
 * Esa etiqueta es el TIPO de movimiento, no el activo, y arrastrarla rompe la
 * resolución del ticker por partida doble: `curatedIsinForFundName` busca por
 * clave exacta y no encuentra nada, y `fundNameMatches` toma la primera palabra
 * como la marca —"suscripcion"— que no aparece en ningún candidato, así que
 * rechaza todos. Medido con un extracto real: 17 filas sin ticker por esto.
 *
 * Devuelve el texto ORIGINAL de lo que queda (sin normalizar), porque las claves
 * curadas se comparan en mayúsculas contra el nombre tal cual lo escribe el
 * banco.
 */
export function stripOperationPrefix(name) {
  const tokens = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return String(name || '');

  const plain = (t) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');
  if (!OPERATION_HEAD.has(plain(tokens[0]))) return String(name);

  let i = 0;
  while (i < tokens.length) {
    const t = plain(tokens[i]);
    if (OPERATION_HEAD.has(t) || OPERATION_FILLER.has(t)) i += 1;
    else break;
  }
  const resto = tokens.slice(i).join(' ');
  // Si no queda nada, el nombre ERA la etiqueta: mejor devolverlo entero que vacío.
  return resto || String(name);
}

const sleepMs = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/**
 * Fills the `ticker` of asset rows that only carry `assetName`, searching by
 * name (injected searchTickers — Yahoo in prod; NEVER the EODHD fallback, its
 * quota is too small for speculative name lookups). One search per unique
 * name, paced sequentially. Rows are returned as a new array; resolved rows
 * carry `autoResolved: true` so the UI can hint the value came from a search.
 */
export async function resolveMissingTickers(rows, searchTickers, { pauseMs = 200 } = {}) {
  const all = rows || [];
  const needsTicker = (row) =>
    RESOLVABLE_TYPES.has(row?.type) &&
    !String(row?.ticker || '').trim() &&
    String(row?.assetName || '').trim().length > 0;

  // One resolution per unique name, and ONE listing for all its rows. The
  // listing currency preference comes from the POSITION's currency (its
  // BUY/SELL rows): a dividend arrives converted to EUR, and resolving it
  // against EUR would pick a different exchange (TL0.DE) than the USD buys
  // (TSLA), splitting the asset in two.
  const preferredCurrency = {};
  for (const row of all) {
    if (!needsTicker(row)) continue;
    const key = stripOperationPrefix(row.assetName.trim()).toLowerCase();
    const isTrade = ['BUY', 'SELL', 'HOLDING'].includes(row.type);
    if (!(key in preferredCurrency) || (isTrade && !preferredCurrency[key].fromTrade)) {
      preferredCurrency[key] = { currency: row.currency, fromTrade: isTrade };
    }
  }

  const cache = {};
  const out = [];
  for (const row of all) {
    if (!needsTicker(row)) {
      out.push(row);
      continue;
    }

    // El nombre limpio manda: es el del activo, y la etiqueta de la operación
    // ya viaja en `type`. También se publica en la fila para que la posición no
    // acabe llamándose "Suscripción Fondos de Inversión …".
    const name = stripOperationPrefix(row.assetName.trim());
    const key = name.toLowerCase();
    if (!(key in cache)) {
      if (Object.keys(cache).length > 0) await sleepMs(pauseMs);
      try {
        const wanted = preferredCurrency[key]?.currency;
        // El ISIN curado va PRIMERO cuando el nombre es uno de los que la
        // plataforma ya tiene verificados (los fondos de las carteras
        // gestionadas llegan con el nombre truncado a ~30 caracteres, y ahí
        // ninguna búsqueda por nombre acierta la clase).
        cache[key] =
          (await resolveByIsin(row.isin, wanted, searchTickers)) ||
          (await resolveByIsin(curatedIsinForFundName(name), wanted, searchTickers)) ||
          pickSymbolForName(name, wanted, await searchTickers(name));
      } catch (_) {
        cache[key] = null; // network/quota error → row stays pending in the HITL
      }
    }
    const limpio = name !== row.assetName.trim() ? { assetName: name } : {};
    out.push(cache[key]
      ? { ...row, ...limpio, ticker: cache[key], autoResolved: true }
      : { ...row, ...limpio });
  }
  return out;
}

/**
 * ISIN → symbol, tried BEFORE the name search when the AI extracted one: it
 * identifies the instrument exactly, which covers cases no name heuristic can
 * (e.g. "ETC Group Physical Bitcoin" was renamed to Bitwise after an
 * acquisition — only its ISIN still matches). Static TICKER_MAP first (no
 * network), then a quote search by ISIN.
 */
async function resolveByIsin(isin, currency, searchTickers) {
  const clean = String(isin || '').trim().toUpperCase();
  if (!/^[A-Z]{2}[A-Z0-9]{10}$/.test(clean)) return null;

  const staticMapped = strictResolveTicker(clean);
  if (staticMapped) return staticMapped;

  const results = (await searchTickers(clean)) || [];
  const candidates = (results.filter((r) => r.symbol && QUOTABLE_RESULT_TYPES.test(r.type || '')))
    // Un ISIN identifica el fondo, pero Yahoo devuelve VARIOS listados suyos: el
    // símbolo de NAV (0P…) y las cotizaciones en bolsa de otras clases (FEPA.MU
    // es la clase R en Múnich, no la P-ACC-EUR del extracto — otra clase es otro
    // NAV). Se prefiere el 0P…, que es la clase que el ISIN nombra. Misma regla
    // que ya aplica fundNavEnricher al ordenar sus candidatos.
    .sort((a, b) => (b.symbol.startsWith('0P') ? 1 : 0) - (a.symbol.startsWith('0P') ? 1 : 0));
  if (candidates.length === 0) return null;
  const wanted = String(currency || '').toUpperCase();
  const currencyMatch = wanted
    ? candidates.find((r) => inferTickerCurrency(r.symbol) === wanted)
    : null;
  return (currencyMatch || candidates[0]).symbol;
}

/**
 * Maps validated neutral rows to internal Trazza transaction rows.
 * Rows that still fail validation are skipped — never silently defaulted.
 */
export function freeformToTrazza(rows) {
  return (rows || [])
    .filter(r => validateFreeformRow(r).length === 0)
    .map(r => {
      const qty    = num(r.quantity) || 0;
      let price    = num(r.price) || 0;
      let amount   = num(r.amount);
      let currency = String(r.currency).toUpperCase();
      const ticker = String(r.ticker || '').trim();
      const name   = String(r.assetName || '').trim();

      // GBX/GBp = pence. The LLM is instructed to pass pence prices through
      // verbatim; the ÷100 normalisation is deterministic and lives HERE.
      // The extracted amount may be in pounds (DeGiro's ledger column) or in
      // pence (qty × pence price) — arithmetic disambiguates.
      if (currency === 'GBX') {
        price = price / 100;
        currency = 'GBP';
        if (amount != null && qty > 0 && price > 0) {
          const asPence = Math.abs(amount / 100 - qty * price);
          const asPounds = Math.abs(amount - qty * price);
          if (asPence < asPounds) amount = amount / 100;
        }
      }

      // Only a strictly-valid ISIN rides along (CarteraPage skips rows whose
      // non-empty ISIN is malformed). The asset is still keyed by ticker.
      const isin = ISIN_RE.test(String(r.isin || '')) ? r.isin : '';

      const base = {
        fecha: isoToTrazzaDate(r.date),
        hora: '00:00',
        producto: ticker || name,
        nombre: name || ticker,
        isin,
        cantidad: 0,
        precio: 0,
        moneda: currency,
        comisiones: 0,     // never inferred from pasted text; user can add later
        isAIParsed: true,
        sourceLine: r.sourceLine || '',
      };

      switch (r.type) {
        case 'BUY':
          // Explicit extracted amount wins over qty×price (it may include
          // exchange-specific rounding); both are costs → negative total.
          return { ...base, type: 'BUY', cantidad: qty, precio: price, total: -(amount ?? round2(qty * price)) };
        case 'HOLDING':
          // Position snapshot → BUY *marcado como consolidado*. Sin el flag,
          // calculateNetBuys lo trata como una compra real y RESTA su coste del
          // ledger de caja: pegar una tabla de posiciones (sin ingresos, porque
          // un snapshot no los tiene) dejaba la liquidez en -23.949 € y la
          // pantalla mostraba "Margen utilizado" de la nada (bug 2026-07-26).
          // Consolidado = define la posición y su coste medio, no mueve caja ni
          // se escribe al histórico de transacciones — misma semántica que los
          // snapshots de IBKR/Binance.
          return { ...base, type: 'BUY', isConsolidated: true, cantidad: qty, precio: price, total: -(amount ?? round2(qty * price)) };
        case 'SELL':
          return { ...base, type: 'SELL', cantidad: qty, precio: price, total: +(amount ?? round2(qty * price)) };
        case 'DIVIDEND':
          return { ...base, type: 'DIVIDEND', total: amount };
        case 'FEE':
          return { ...base, type: 'FEES', total: -Math.abs(amount) };
        case 'DEPOSIT':
          return { ...base, type: 'TRANSFER', total: amount };
        case 'WITHDRAWAL':
          return { ...base, type: 'TRANSFER', total: -amount };
        default:
          return null; // unreachable after validation
      }
    })
    .filter(Boolean);
}
