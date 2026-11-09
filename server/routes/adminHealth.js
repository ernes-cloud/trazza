/**
 * GET /api/admin/health
 *
 * Admin-only. Checks the status and latency of each external provider
 * (Yahoo Finance, Groq AI, EODHD, Supabase DB).
 *
 * Results are cached for 60 seconds server-side to avoid burning API credits
 * when admins refresh the dashboard compulsively.
 */

import { supabaseAdmin } from '../lib/adminSupabase.js';
import { requireAdmin }  from '../lib/requireAdmin.js';
import { transporter, EMAIL_PROVIDER } from '../lib/emailTransport.js';

const HEALTH_TTL = 60_000; // 60 seconds
let healthCache     = null;
let healthCacheTime = 0;

async function checkYahoo() {
  const start = Date.now();
  try {
    const r = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=1d',
      { signal: AbortSignal.timeout(6_000) }
    );
    return { provider: 'Yahoo Finance', status: r.ok ? 'ok' : 'degraded', latencyMs: Date.now() - start };
  } catch {
    return { provider: 'Yahoo Finance', status: 'down', latencyMs: Date.now() - start };
  }
}

async function checkGroq() {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { provider: 'Groq (AI)', status: 'unconfigured', latencyMs: null };
  const start = Date.now();
  try {
    // Models list endpoint — no tokens consumed
    const r = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(6_000),
    });
    return { provider: 'Groq (AI)', status: r.ok ? 'ok' : 'degraded', latencyMs: Date.now() - start };
  } catch {
    return { provider: 'Groq (AI)', status: 'down', latencyMs: Date.now() - start };
  }
}

async function checkEodhd() {
  const key = process.env.EODHD_PLATFORM_KEY;
  if (!key) return { provider: 'EODHD', status: 'unconfigured', latencyMs: null };
  const start = Date.now();
  try {
    const r = await fetch(
      `https://eodhd.com/api/real-time/AAPL?api_token=${key}&fmt=json`,
      { signal: AbortSignal.timeout(6_000) }
    );
    return { provider: 'EODHD', status: r.ok ? 'ok' : 'degraded', latencyMs: Date.now() - start };
  } catch {
    return { provider: 'EODHD', status: 'down', latencyMs: Date.now() - start };
  }
}

async function checkSmtp() {
  // El nombre lleva el proveedor porque el panel tiene que distinguir "el
  // Postfix local no responde" de "Resend rechaza la API key": son dos
  // averías distintas con dos arreglos distintos.
  const label = EMAIL_PROVIDER === 'resend' ? 'Email (Resend)' : 'Email (SMTP local)';
  const start = Date.now();
  try {
    await transporter.verify();
    return { provider: label, status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    return { provider: label, status: 'down', latencyMs: Date.now() - start };
  }
}

async function checkSupabase() {
  if (!supabaseAdmin) return { provider: 'Supabase DB', status: 'unconfigured', latencyMs: null };
  const start = Date.now();
  try {
    const { error } = await supabaseAdmin
      .from('user_preferences')
      .select('user_id')
      .limit(1);
    return { provider: 'Supabase DB', status: error ? 'degraded' : 'ok', latencyMs: Date.now() - start };
  } catch {
    return { provider: 'Supabase DB', status: 'down', latencyMs: Date.now() - start };
  }
}

export async function adminHealth(req, res) {
  const user = await requireAdmin(req, res, supabaseAdmin);
  if (!user) return;

  // Serve from cache if still fresh
  if (healthCache && Date.now() - healthCacheTime < HEALTH_TTL) {
    return res.json({ ...healthCache, cached: true });
  }

  try {
    const results = await Promise.allSettled([
      checkYahoo(),
      checkGroq(),
      checkEodhd(),
      checkSupabase(),
      checkSmtp(),
    ]);

    const providers = results.map((r, i) => {
      const fallbacks = [
        { provider: 'Yahoo Finance', status: 'down', latencyMs: null },
        { provider: 'Groq (AI)',     status: 'down', latencyMs: null },
        { provider: 'EODHD',        status: 'down', latencyMs: null },
        { provider: 'Supabase DB',  status: 'down', latencyMs: null },
        { provider: 'SMTP (Email)', status: 'down', latencyMs: null },
      ];
      return r.status === 'fulfilled' ? r.value : fallbacks[i];
    });

    const result = { providers, checkedAt: new Date().toISOString(), cached: false };
    healthCache     = result;
    healthCacheTime = Date.now();

    return res.json(result);
  } catch (err) {
    console.error('[adminHealth] Unhandled error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
