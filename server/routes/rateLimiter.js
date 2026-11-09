/**
 * rateLimiter — Express middleware factory
 *
 * Usage:
 *   import { withRateLimit } from './rateLimiter.js';
 *   app.post('/api/portfolio-chat', withRateLimit('chat'), portfolioChat);
 *
 * Flow:
 *  1. Extract Supabase JWT from Authorization: Bearer <token>
 *  2. Verify user via supabase.auth.getUser()
 *  3. Read current daily + monthly counts (service role bypasses RLS)
 *  4. Return 429 if either limit is exceeded
 *  5. Attach req.userId + req.incrementUsage() for the route handler to call
 *     after a successful AI response (so failed calls don't consume quota)
 */

import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { getAiLimits } from '../lib/aiQuota.js';
import { isUserAdmin, parseAdminEmails } from '../lib/adminResolver.js';

// URL is not a secret — fall back to the frontend var so local setups only
// need to add the service-role key (same fallback as lib/adminSupabase.js).
const SUPABASE_URL      = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Service-role client: bypasses RLS — only used server-side.
// ws transport required for Node.js < 22 (no native WebSocket).
const supabaseAdmin = (SUPABASE_URL && SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth:     { persistSession: false },
      realtime: { transport: ws },
    })
  : null;

let lastFailClosedLogAt = 0;
function logFailClosedOnce(reason, detail) {
  const now = Date.now();
  if (now - lastFailClosedLogAt < 60_000) return;
  lastFailClosedLogAt = now;
  console.error(`[rateLimiter] fail-closed (${reason}):`, detail || 'service unavailable');
}

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

/**
 * Returns today's date strings: { today: 'YYYY-MM-DD', month: 'YYYY-MM' }
 */
function getPeriods() {
  const today = new Date().toISOString().split('T')[0];
  return { today, month: today.slice(0, 7) };
}

/**
 * Express middleware factory. `feature` must be one of the AI_LIMITS keys.
 */
export function withRateLimit(feature) {
  return async (req, res, next) => {
    if (!['chat', 'analysis', 'import'].includes(feature)) {
      return res.status(400).json({ error: 'Unsupported AI feature' });
    }

    // Sin service-role: en desarrollo se deja pasar; en producción se CIERRA
    // (antes quedaban las rutas de IA abiertas sin auth ni cuota).
    if (!supabaseAdmin) {
      if (isProduction()) {
        logFailClosedOnce('no_supabase_admin');
        return res.status(503).json({ error: 'service_unavailable' });
      }
      req.incrementUsage = async () => {};
      return next();
    }

    // Extract JWT from Authorization header
    const authHeader = req.headers['authorization'] || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing Authorization header' });
    }
    const token = authHeader.slice(7);

    // Verify user identity via Supabase Auth
    const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
    if (authErr || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const userId = user.id;
    const { today, month } = getPeriods();

    let adminByResolver = false;
    try {
      adminByResolver = await isUserAdmin({
        env: { ADMIN_EMAILS: process.env.ADMIN_EMAILS },
        supabaseAdmin,
        user,
      });
    } catch (e) {
      console.warn('[rateLimiter] admin resolution failed:', e?.name || 'Error');
      adminByResolver = false;
    }

    const adminEmailsDefined = parseAdminEmails(process.env.ADMIN_EMAILS).length > 0;
    const aiLimits = getAiLimits(process.env, {
      email: user.email,
      isFirstUser: !adminEmailsDefined && adminByResolver,
    });
    const limits = aiLimits[feature];
    const aiEnabled = Boolean(aiLimits.enabled);
    const adminUnlimited = !Number.isFinite(limits?.daily) || !Number.isFinite(limits?.monthly);

    // Admins bypass rate limiting entirely
    if (adminUnlimited) {
      req.userId   = userId;
      req.userPlan = 'admin';
      req.aiEnabled = true;
      req.incrementUsage = async () => {};
      return next();
    }

    // Read current usage counts — also wrapped to avoid hanging on DB errors.
    // En producción corre antes del atajo !aiEnabled (fail-closed si ai_usage falla).
    let dayCount = 0, monthCount = 0;
    let aiUsageUnavailableInDev = false;
    try {
      const { data: rows, error: dbErr } = await supabaseAdmin
        .from('ai_usage')
        .select('period, count')
        .eq('user_id', userId)
        .eq('feature', feature)
        .in('period', [today, month]);

      if (dbErr) {
        console.warn('[rateLimiter] ai_usage query failed (table missing?):', dbErr.message);
        if (isProduction()) {
          logFailClosedOnce('ai_usage_query', dbErr.message);
          return res.status(503).json({ error: 'service_unavailable' });
        }
        aiUsageUnavailableInDev = true;
      } else {
        dayCount   = rows?.find(r => r.period === today)?.count ?? 0;
        monthCount = rows?.find(r => r.period === month)?.count ?? 0;
      }
    } catch (e) {
      console.warn('[rateLimiter] ai_usage query threw:', e.message);
      if (isProduction()) {
        logFailClosedOnce('ai_usage_throw', e.message);
        return res.status(503).json({ error: 'service_unavailable' });
      }
      aiUsageUnavailableInDev = true;
    }

    // Let routes return their own post-validation ai_not_configured error.
    if (!aiEnabled) {
      req.userId   = userId;
      req.userPlan = 'user';
      req.aiEnabled = false;
      req.incrementUsage = async () => {};
      return next();
    }

    if (aiUsageUnavailableInDev) {
      req.userId = userId;
      req.userPlan = 'user';
      req.aiEnabled = true;
      req.incrementUsage = async () => {};
      return next();
    }

    if (dayCount >= limits.daily) {
      return res.status(429).json({
        error: 'Daily AI limit reached',
        reason: 'daily',
        used:   dayCount,
        limit:  limits.daily,
      });
    }
    if (monthCount >= limits.monthly) {
      return res.status(429).json({
        error: 'Monthly AI limit reached',
        reason: 'monthly',
        used:   monthCount,
        limit:  limits.monthly,
      });
    }

    // Attach helpers for the route handler
    req.userId   = userId;
    req.userPlan = 'user';
    req.aiEnabled = true;

    // Call this after a successful AI response to atomically increment both counters.
    req.incrementUsage = async () => {
      try {
        await Promise.all([
          supabaseAdmin.rpc('increment_ai_usage', { p_user_id: userId, p_feature: feature, p_period: today }),
          supabaseAdmin.rpc('increment_ai_usage', { p_user_id: userId, p_feature: feature, p_period: month }),
        ]);
      } catch (e) {
        console.warn('[rateLimiter] increment_ai_usage failed:', e.message);
      }
    };

    next();
  };
}
