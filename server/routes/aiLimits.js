/**
 * GET /api/ai/limits — authenticated read-only AI quota configuration for the caller.
 * Does not read ai_usage or other per-user tables; limits come from env via getAiLimits.
 */

import { requireUser } from '../lib/requireUser.js';
import { getAiLimits } from '../lib/aiQuota.js';

export async function aiLimits(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const limits = getAiLimits(process.env, { email: user.email });
  res.json(limits);
}
