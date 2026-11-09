/**
 * Verifies the Supabase JWT from Authorization: Bearer <token> and returns the
 * user, or responds 401 and returns null. Same verification the rate limiter
 * does, without consuming any AI-plan quota — for authenticated endpoints that
 * are not LLM features.
 */

import { supabaseAdmin } from './adminSupabase.js';

export async function requireUser(req, res) {
  if (!supabaseAdmin) {
    res.status(503).json({ error: 'Server not configured (Supabase credentials missing)' });
    return null;
  }
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return null;
  }
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (error || !user) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return null;
  }
  return user;
}
