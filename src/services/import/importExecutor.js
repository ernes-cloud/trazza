/**
 * Import executor — the I/O half of the CSV import save flow.
 *
 * Applies the mutation plan produced by importPlanner.computeImportPlan()
 * against Supabase, BATCHED (the old inline loop did one SELECT + one write
 * per asset: >120 sequential round-trips for a 60-asset CSV; this does bulk
 * inserts and parallel batches), then resolves the final ref → positionId map
 * and persists the deduplicated transaction rows from buildTransactionRows().
 *
 * NO decisions here: any error throws with context and the caller handles UX.
 * The supabase client is injected — the module is unit-testable with a fake.
 */

import { buildTransactionRows } from './importPlanner.js';
import { createAssets } from '@/services/assetCreateService';

const ASSET_CHUNK = 100;
const TX_CHUNK = 500;
const PARALLEL = 10;

async function inParallelBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

/**
 * @returns {{ insertedCount: number, patchedCount: number, positionIdMap: Object }}
 */
export async function applyImportPlan({
  plan,
  dataSource,
  broker,
  brokerId,
  portfolioId,
  existingTransMap,
  supabase,
  createAssetsFn = createAssets,
}) {
  const refToAssetId = {};

  // ── 1. Bulk-create missing assets (vía server / demo mock; no INSERT directo) ─
  if (plan.assetsToCreate.length > 0) {
    const created = await createAssetsFn(plan.assetsToCreate.map(a => a.row));
    for (const row of created || []) refToAssetId[row.ticker] = row.id;
  }

  // ── 3. Position updates (parallel batches, fail loudly) ─────────────────────
  await inParallelBatches(plan.positionUpdates, PARALLEL, async ({ positionId, row, ref }) => {
    const { error } = await supabase.from('positions').update(row).eq('id', positionId);
    if (error) throw new Error(`Position update "${ref}": ${error.message}`);
  });

  // ── 4. Bulk-create positions (resolving assetRef → id from step 1) ──────────
  const positionIdMap = { ...plan.refToPositionId };
  if (plan.positionsToCreate.length > 0) {
    const rows = plan.positionsToCreate.map(p => {
      const assetId = p.assetId ?? refToAssetId[p.assetRef];
      if (!assetId) throw new Error(`Position "${p.ref}": unresolved asset reference`);
      return { ...p.row, asset_id: assetId, portfolio_id: portfolioId, broker_id: brokerId };
    });
    for (let i = 0; i < rows.length; i += ASSET_CHUNK) {
      const chunk = rows.slice(i, i + ASSET_CHUNK);
      const refs = plan.positionsToCreate.slice(i, i + ASSET_CHUNK);
      const { data: created, error } = await supabase.from('positions').insert(chunk).select('id, asset_id');
      if (error) throw new Error(`Positions insert (${chunk.length} rows): ${error.message}`);
      // Supabase preserves insert order in the returned rows
      (created || []).forEach((row, idx) => { positionIdMap[refs[idx].ref] = row.id; });
    }
  }

  // ── 4b. Metadata backfill for existing assets ───────────────────────────────
  // AFTER the positions exist: update_asset_metadata only touches assets the
  // user holds. No price — the shared price is written by the server cron.
  await inParallelBatches(plan.assetRpcUpdates, PARALLEL, async ({ args }) => {
    const { error } = await supabase.rpc('update_asset_metadata', args);
    if (error) console.warn(`[import] metadata RPC failed for ${args.p_asset_id}: ${error.message}`);
  });

  // ── 5. Close leftover positions ─────────────────────────────────────────────
  if (plan.positionsToClose.length > 0) {
    const { error } = await supabase.from('positions').update({ quantity: 0 }).in('id', plan.positionsToClose);
    if (error) throw error;
  }

  // ── 6. Transaction history: dedupe-safe inserts + backfill patches ──────────
  const { rowsToInsert, rowsToPatch } = buildTransactionRows({
    dataSource,
    broker,
    positionIdMap,
    existingTransMap,
  });

  for (let i = 0; i < rowsToInsert.length; i += TX_CHUNK) {
    const { error } = await supabase.from('transactions').insert(rowsToInsert.slice(i, i + TX_CHUNK));
    if (error) throw error;
  }

  await inParallelBatches(rowsToPatch, 25, ({ id, patch }) =>
    supabase.from('transactions').update(patch).eq('id', id)
      .then(({ error }) => { if (error) console.error('Error backfilling transaction:', error); })
  );

  return { insertedCount: rowsToInsert.length, patchedCount: rowsToPatch.length, positionIdMap };
}
