/**
 * Import planner — the DECISION half of the CSV import save flow.
 *
 * computeImportPlan() replicates the logic that lived inline in CarteraPage's
 * handleSaveImportedData, as a pure function of (parsed CSV, current DB state):
 * given net holdings and the broker's existing assets/positions, it produces
 * the exact mutation plan. buildTransactionRows() then derives the dedup-safe
 * transaction inserts/patches once position ids are known.
 *
 * PURITY IS THE POINT: everything here is testable with fixtures and gives a
 * verifiable idempotence property — planning against the state that results
 * from applying a plan must produce an EMPTY plan (no creates, no inserts).
 * The I/O half lives in importExecutor.js.
 *
 * Behaviour is an exact extraction (characterization-tested); semantic changes
 * belong in their own commits.
 */

// .js extensions: these modules are Node-compatible (the server imports the
// mapper/planner directly, same convention as portfolioHistory.js).
import { getAssetIdentifiers, twinAssetTicker } from './assetIdentity.js';
import { findAssetByTicker } from './existingAssets.js';
import { transCheckKey } from '../../lib/importDedupe.js';
import { noteTxCurrency } from '../portfolioHistory.js';
import {
  canonicalCashTicker,
  decoratedCashTicker,
  findCashAssetByCurrency,
  findCashPosition,
} from '../../lib/cashIdentity.js';

// Igual que ensure_asset / createAssets: el dígito de control es numérico.
const VALID_ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const CRYPTO_TICKER_RE = /^[A-Z0-9]+-[A-Z]{3}$/;

const isCashNet = (net) => net.type === 'CASH' || net.type === 'Cash';

/**
 * @param {Object} args
 * @param {Array}  args.dataSource            parsed CSV rows (all of them)
 * @param {Array}  args.netBuys               calculateNetBuys() output
 * @param {string} args.broker                import source ('degiro' | 'ibkr' | ...)
 * @param {Array}  args.existingPositions     [{ id, asset_id }] for this broker
 * @param {Object} args.existingAssetsByTicker dbTicker → asset row (batch-fetched;
 *                                            lookup exacto y luego lower(btrim))
 * @param {Object} [args.dynamicTickerMap]    identifier → Yahoo ticker
 * @param {Object} [args.importPrices]        ticker/identifier → live price
 * @param {Function} [args.resolveTickerFn]   fallback resolver (lib/tickerMap)
 *
 * @returns {{
 *   assetsToCreate:    Array<{ ref, row }>,          // ref = dbTicker
 *   assetRpcUpdates:   Array<{ assetId, args }>,  // update_asset_metadata (no price)
 *   positionUpdates:   Array<{ ref, positionId, row }>,
 *   positionsToCreate: Array<{ ref, assetId?, assetRef?, row }>,
 *   positionsToClose:  Array<string>,
 *   refToPositionId:   Object,                       // refs already resolvable
 *   skipped:           Array<{ isin, reason }>,
 *   representationConflicts: Array<{ name, ref, twinRef }>, // fondo ya guardado en
 *                                                 // la OTRA representación (euros ↔
 *                                                 // participaciones): aplicar el plan
 *                                                 // lo contaría dos veces
 * }}
 */
export function computeImportPlan({
  dataSource,
  netBuys,
  broker,
  existingPositions,
  existingAssetsByTicker,
  dynamicTickerMap = {},
  importPrices = {},
  resolveTickerFn = (x) => x,
}) {
  const plan = {
    assetsToCreate: [],
    assetRpcUpdates: [],
    positionUpdates: [],
    positionsToCreate: [],
    positionsToClose: [],
    refToPositionId: {},
    skipped: [],
    representationConflicts: [],
  };

  const existingPosMap = (existingPositions || []).reduce((acc, p) => { acc[p.asset_id] = p; return acc; }, {});
  const visitedPositionIds = new Set();
  // Asset IDs (existing only) with explicit BUY/SELL activity in this CSV —
  // the only ones whose leftover positions may be closed.
  const processedAssetIds = new Set();
  const plannedRefs = new Set(); // refs already handled (netBuys pass + closed pass)

  // ── 1. Open holdings: update/create asset + position per net row ───────────
  for (const net of netBuys || []) {
    const isCashRow = isCashNet(net) || (net.isin || '').startsWith('CASH_');
    if (!isCashRow && net.isin && !VALID_ISIN_RE.test(net.isin)) {
      plan.skipped.push({ isin: net.isin, reason: 'malformed-isin' });
      continue;
    }

    const { dbTicker: ref } = getAssetIdentifiers(net, broker);
    const identifier = net.isin || net.producto;
    const ticker = dynamicTickerMap[identifier] || resolveTickerFn(identifier);

    // net.precio is in asset's own currency; importPrices[ticker] is raw Yahoo USD — wrong for EUR assets
    // Cash y fondos monetarios valen 1 por unidad POR DEFINICIÓN (la cantidad ya
    // son euros): nunca un precio de mercado, que multiplicaría el importe por el NAV.
    const currentPrice = (isCashNet(net) || net.noQuote === true)
      ? 1
      : (net.currentPrice || net.precio || importPrices[ticker] || importPrices[identifier] || 0);

    // Cash: resolve by the broker's existing cash POSITION first (not a shared
    // asset another user may already own). Then alias lookup via cashIdentity.
    // Bare `CASH` is never matched. Non-cash uses findAssetByTicker (exact +
    // lower(btrim)) like ensure_asset.
    const cashCur = net.moneda || 'EUR';
    const cashPos = isCashRow
      ? findCashPosition(existingPositions, { currency: cashCur })
      : null;
    let asset = cashPos
      ? (cashPos.assets?.id
        ? cashPos.assets
        : (Object.values(existingAssetsByTicker || {}).find((a) => a?.id === cashPos.asset_id)
          || findAssetByTicker(existingAssetsByTicker, cashPos.assets?.ticker)
          || null))
      : findAssetByTicker(existingAssetsByTicker, ref);
    if (!asset && isCashRow) {
      asset = findCashAssetByCurrency(existingAssetsByTicker, cashCur);
    }
    plannedRefs.add(ref);

    // ¿Este broker ya tiene el fondo abierto en la OTRA representación? El
    // plan crearía una segunda posición y el fondo contaría dos veces.
    const twinRef = isCashNet(net) ? null : twinAssetTicker(net, broker);
    const twinAsset = twinRef && findAssetByTicker(existingAssetsByTicker, twinRef);
    const twinPos = twinAsset && existingPosMap[twinAsset.id];
    if (twinPos && Number(twinPos.quantity ?? 1) > 0) {
      plan.representationConflicts.push({ name: net.name || net.producto || ref, ref, twinRef });
    }

    if (!asset) {
      const cleanName = (net.producto || net.name || '').replace(/\s*\([A-Z]{3}\)$/, '').trim();
      plan.assetsToCreate.push({
        ref,
        row: {
          ticker: ref,
          company_name: cleanName || net.producto,
          asset_class: isCashNet(net) ? 'Cash' : CRYPTO_TICKER_RE.test(ref) ? 'Crypto' : 'Stock',
          currency: net.moneda || 'EUR',
          current_price: currentPrice,
          isin: net.isin,
        },
      });
      // New asset → new position (asset id resolved by the executor via ref)
      plan.positionsToCreate.push({
        ref,
        assetRef: ref,
        row: {
          quantity: net.qty,
          entry_price: net.precio,
          custom_classification: isCashNet(net) ? 'Cash' : 'Others',
        },
      });
      continue;
    }

    // Existing asset: backfill metadata via RPC (update_asset_metadata). The
    // PRICE of a shared asset is no longer written from the client: only the
    // server cron does (server/lib/assetPrices.js, audit 7f2c915d A1).
    const metadataArgs = {
      p_asset_id: asset.id,
      p_company_name: String(ticker || '').startsWith('CASH_') ? (net.name || null) : null,
      p_isin: net.isin || null,
    };
    if (metadataArgs.p_company_name || metadataArgs.p_isin) {
      plan.assetRpcUpdates.push({ assetId: asset.id, args: metadataArgs });
    }

    processedAssetIds.add(asset.id);

    // Prefer the broker's cash position even when the CSV ref points at a
    // different shared asset (another user's CASH_EUR (EUR) in the table).
    const existingPos = cashPos || existingPosMap[asset.id];
    if (existingPos) {
      // NEVER destroy a known cost basis with an unknown one: in-kind transfers
      // (crypto deposits, stock transfers) arrive at price 0 — if this position
      // already has an entry_price, keep it instead of zeroing the BEP.
      const entryPrice = (!net.precio && existingPos.entry_price > 0)
        ? existingPos.entry_price
        : net.precio;
      plan.positionUpdates.push({
        ref,
        positionId: existingPos.id,
        row: {
          quantity: net.qty,
          entry_price: entryPrice,
          custom_classification: isCashNet(net) ? 'Cash' : 'Others',
        },
      });
      visitedPositionIds.add(existingPos.id);
      plan.refToPositionId[ref] = existingPos.id;
    } else {
      plan.positionsToCreate.push({
        ref,
        assetId: asset.id,
        row: {
          quantity: net.qty,
          entry_price: net.precio,
          custom_classification: isCashNet(net) ? 'Cash' : 'Others',
        },
      });
    }
  }

  // ── 2. CLOSED assets (history but zero open qty) still need a qty=0 position
  // so their SELL/DIVIDEND/TAX rows can be linked and saved. ──────────────────
  for (const t of (dataSource || []).filter(tr => !tr.isConsolidated)) {
    if (!['BUY', 'SELL', 'DIVIDEND', 'TAX'].includes(t.type)) continue;
    if (!t.isin || !VALID_ISIN_RE.test(t.isin)) continue;
    const { dbTicker: ref } = getAssetIdentifiers(t, broker);
    if (plannedRefs.has(ref)) continue;
    plannedRefs.add(ref);

    const closedAsset = findAssetByTicker(existingAssetsByTicker, ref);
    if (!closedAsset) {
      const cleanName = (t.nombre || t.producto || '').replace(/\s*\([A-Z]{3}\)$/, '').trim();
      plan.assetsToCreate.push({
        ref,
        row: {
          ticker: ref,
          company_name: cleanName || t.producto || t.isin,
          asset_class: 'Stock',
          currency: t.moneda || 'EUR',
          current_price: 0,
          isin: t.isin,
        },
      });
      plan.positionsToCreate.push({
        ref,
        assetRef: ref,
        row: { quantity: 0, entry_price: 0, custom_classification: 'Others' },
      });
      continue;
    }

    const existingClosedPos = existingPosMap[closedAsset.id];
    if (existingClosedPos) {
      plan.refToPositionId[ref] = existingClosedPos.id;
    } else {
      plan.positionsToCreate.push({
        ref,
        assetId: closedAsset.id,
        row: { quantity: 0, entry_price: 0, custom_classification: 'Others' },
      });
    }
  }

  // ── 3. Close leftover positions whose asset had BUY/SELL in this CSV but
  // whose position wasn't the one visited (duplicate positions per asset). ────
  plan.positionsToClose = (existingPositions || [])
    .filter(p => !visitedPositionIds.has(p.id) && processedAssetIds.has(p.asset_id))
    .map(p => p.id);

  return plan;
}

/**
 * Transaction rows for the history table, deduplicated against the DB.
 * Pure: needs the FINAL ref → positionId map (after the executor created the
 * planned positions) and the existing-transactions map keyed by transCheckKey.
 *
 * @returns {{ rowsToInsert: Array<Object>, rowsToPatch: Array<{id, patch}> }}
 */
export function buildTransactionRows({ dataSource, broker, positionIdMap, existingTransMap }) {
  // MULTISET of stored rows per key (see buildExistingTransMap): each CSV row
  // consumes ONE stored occurrence, so N identical partial fills (same order
  // executed as N 1-share trades at the same price/minute) match N stored
  // rows — and whatever the DB is missing gets inserted. A unique-key Set
  // silently dropped every fill after the first, halving the cost basis.
  // Legacy single-object maps are normalised to 1-element buckets.
  const remaining = new Map();
  for (const [key, value] of existingTransMap) {
    remaining.set(key, Array.isArray(value) ? [...value] : [value]);
  }
  const rowsToInsert = [];
  const rowsToPatch = [];

  // ISIN-only fallback map: dividends/taxes report in base currency (e.g. EUR)
  // but their position was stored with the native currency (USD/CAD).
  const isinPositionMap = {};
  for (const [dbTicker, posId] of Object.entries(positionIdMap)) {
    const m = dbTicker.match(/^([A-Z]{2}[A-Z0-9]{10})\s*\([A-Z]{3}\)$/);
    if (m) isinPositionMap[m[1]] = posId;
  }

  // NEVER write `isConsolidated` proxy trades to history — snapshots, not events.
  for (const t of (dataSource || []).filter(tr => !tr.isConsolidated)) {
    const { dbTicker } = getAssetIdentifiers(t, broker);
    let targetPositionId = positionIdMap[dbTicker];

    if (!targetPositionId && (t.type === 'DIVIDEND' || t.type === 'TAX' || t.type === 'FEES' || t.type === 'FEE') && t.isin) {
      targetPositionId = isinPositionMap[t.isin];
    }
    if (!targetPositionId && t.type === 'TRANSFER') {
      const cur = (t.moneda || 'EUR').toUpperCase();
      targetPositionId = positionIdMap[decoratedCashTicker(cur)]
        || positionIdMap[canonicalCashTicker(cur)];
    }
    // Fees without an ISIN (connectivity, interest, custody…) → cash position.
    if (!targetPositionId && (t.type === 'FEE' || t.type === 'FEES' || t.type === 'TAX')) {
      const cur = (t.moneda || 'EUR').toUpperCase();
      targetPositionId = positionIdMap[decoratedCashTicker(cur)]
        || positionIdMap[canonicalCashTicker(cur)];
    }
    if (!targetPositionId) continue;

    const dateParts = t.fecha.includes('-') ? t.fecha.split('-') : t.fecha.split('/');
    const isoDate = dateParts.length === 3 ? [...dateParts].reverse().join('-') : t.fecha;
    const time = (t.hora && t.hora.length === 5) ? `${t.hora}:00` : (t.hora || '00:00:00');
    const fullDate = `${isoDate}T${time}`;

    // Raw description preferred over classification string: it carries ISIN and
    // embedded FX rate — needed for correct filtering and cost computation.
    const notesValue = t.descripcion || t.classification || null;

    const checkKey = transCheckKey({
      transaction_date: fullDate,
      transaction_type: t.type,
      quantity: t.cantidad || 0,
      price: t.precio || 0,
      total_amount: t.type === 'CASH' ? t.total : Math.abs(t.total),
      notes: notesValue,
      position_id: targetPositionId,
    });
    const txCurrency = noteTxCurrency(notesValue, t.moneda || null);
    const tradeCommission = (t.type === 'BUY' || t.type === 'SELL') && parseFloat(t.comisiones || 0) > 0
      ? Math.abs(parseFloat(t.comisiones))
      : null;

    const bucket = remaining.get(checkKey);
    if (!bucket || bucket.length === 0) {
      rowsToInsert.push({
        position_id: targetPositionId,
        transaction_type: t.type,
        quantity: t.cantidad || 0,
        price: t.precio || 0,
        total_amount: t.type === 'CASH' ? t.total : Math.abs(t.total),
        transaction_date: fullDate,
        notes: notesValue,
        is_ending_cash: t.isEndingCash || false,
        eur_total: t.totalEUR != null ? Math.abs(t.totalEUR) : null,
        transaction_currency: txCurrency,
        fx_rate: t.fxRate != null ? t.fxRate : null,
        commission: tradeCommission,
      });
      // Deliberately NOT registered as existing: a second identical CSV row is
      // another real partial fill and must insert too.
    } else {
      // Consume one stored occurrence; backfill new columns and/or upgrade
      // notes from classification → raw description on it.
      const existing = bucket.shift();
      const patch = {};
      if (t.totalEUR != null && existing.eur_total == null) patch.eur_total = Math.abs(t.totalEUR);
      if (t.descripcion && existing.notes !== t.descripcion) patch.notes = t.descripcion;
      if (tradeCommission != null && existing.commission == null) patch.commission = tradeCommission;
      if (txCurrency && existing.transaction_currency == null) patch.transaction_currency = txCurrency;
      if (Object.keys(patch).length > 0) rowsToPatch.push({ id: existing.id, patch });
    }
  }

  return { rowsToInsert, rowsToPatch };
}
