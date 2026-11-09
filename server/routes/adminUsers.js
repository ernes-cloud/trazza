/**
 * GET  /api/admin/users?page=1&q=email
 *
 * Admin-only user management endpoints.
 *
 * GET returns paginated users (20/page) joined with preferences + total AI calls.
 * Supports optional ?q= filter by email (case-insensitive).
 */

import { supabaseAdmin } from '../lib/adminSupabase.js';
import { requireAdmin }  from '../lib/requireAdmin.js';

const PER_PAGE     = 20;

export async function adminListUsers(req, res) {
  const admin = await requireAdmin(req, res, supabaseAdmin);
  if (!admin) return;

  const page  = Math.max(1, parseInt(req.query.page) || 1);
  // ?q[]=… llega como array; .toLowerCase() lanzaría TypeError → 500.
  if (req.query.q != null && typeof req.query.q !== 'string') {
    return res.status(400).json({ error: 'Invalid query' });
  }
  const query = (req.query.q || '').toLowerCase().trim();

  try {
    let users = [];
    let authTotal = 0;

    if (query) {
      // When searching, fetch all users across pages to filter correctly.
      // The Supabase Auth API has no server-side email search, so we paginate
      // through all pages and filter locally. Acceptable for beta scale (<10k users).
      let fetchPage = 1;
      while (true) {
        const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page: fetchPage, perPage: 1000 });
        if (error) {
          console.error('[adminUsers] listUsers error:', error.message);
          return res.status(500).json({ error: 'Internal server error' });
        }
        const chunk = data?.users || [];
        users.push(...chunk);
        if (chunk.length < 1000) break;
        fetchPage++;
      }
      users = users.filter(u => (u.email || '').toLowerCase().includes(query));
      authTotal = users.length;
      // Paginate filtered results
      const offset = (page - 1) * PER_PAGE;
      users = users.slice(offset, offset + PER_PAGE);
    } else {
      // Normal pagination without search
      const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.listUsers({
        page,
        perPage: PER_PAGE,
      });
      if (authErr) {
        console.error('[adminUsers] listUsers error:', authErr.message);
        return res.status(500).json({ error: 'Internal server error' });
      }
      users = authData?.users || [];
      authTotal = authData?.total ?? 0;
    }

    if (users.length === 0) {
      return res.json({ users: [], page, perPage: PER_PAGE, total: authTotal });
    }

    const userIds = users.map(u => u.id);

    // Fetch preferences
    const { data: prefs } = await supabaseAdmin
      .from('user_preferences')
      .select('user_id, preferred_currency')
      .in('user_id', userIds);

    // Fetch total AI calls per user
    const { data: usage } = await supabaseAdmin
      .from('ai_usage')
      .select('user_id, count')
      .in('user_id', userIds);

    // Build lookup maps
    const prefsMap = Object.fromEntries((prefs || []).map(p => [p.user_id, p]));
    const usageMap = {};
    for (const r of (usage || [])) {
      usageMap[r.user_id] = (usageMap[r.user_id] || 0) + (r.count || 0);
    }

    const result = users.map(u => ({
      id:          u.id,
      email:       u.email || '',
      createdAt:   u.created_at,
      lastSignIn:  u.last_sign_in_at || null,
      plan:        'user',
      preferredCurrency: prefsMap[u.id]?.preferred_currency || null,
      totalCalls:  usageMap[u.id] || 0,
    }));

    return res.json({
      users:   result,
      page,
      perPage: PER_PAGE,
      total:   authTotal,
    });

  } catch (err) {
    console.error('[adminUsers] Unhandled error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
