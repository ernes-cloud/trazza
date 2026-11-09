/**
 * Validates the incoming request as an authenticated admin user.
 * Returns the Supabase user object on success, or calls res.status().json() and returns null.
 *
 * Usage:
 *   const user = await requireAdmin(req, res, supabaseAdmin);
 *   if (!user) return; // response already sent
 */
import { isUserAdmin } from './adminResolver.js';

export async function requireAdmin(req, res, supabaseAdmin) {
  if (!supabaseAdmin) {
    res.status(503).json({ error: 'Supabase not configured on server' });
    return null;
  }

  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return null;
  }

  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return null;
  }

  try {
    const admin = await isUserAdmin({
      env: { ADMIN_EMAILS: process.env.ADMIN_EMAILS },
      supabaseAdmin,
      user,
    });
    if (!admin) {
      res.status(403).json({ error: 'Admin access required' });
      return null;
    }
  } catch (err) {
    console.error('[requireAdmin] admin resolution failed:', err?.name || 'Error');
    res.status(500).json({ error: 'Internal server error' });
    return null;
  }

  return user;
}
