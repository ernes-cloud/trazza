/**
 * POST /api/admin/run-snapshots
 *
 * Admin-only: triggers a portfolio snapshots run on demand (the cron runs
 * hourly on its own — this is for testing/backfilling today's row).
 */

import { supabaseAdmin } from '../lib/adminSupabase.js';
import { requireAdmin } from '../lib/requireAdmin.js';
import { runPortfolioSnapshots } from '../jobs/portfolioSnapshots.js';

export async function adminRunSnapshots(req, res) {
  const user = await requireAdmin(req, res, supabaseAdmin);
  if (!user) return;

  try {
    const summary = await runPortfolioSnapshots();
    if (summary?.error) return res.status(500).json(summary);
    res.json(summary);
  } catch (e) {
    console.error('[adminSnapshots] run failed:', e.message);
    res.status(500).json({ error: e.message });
  }
}
