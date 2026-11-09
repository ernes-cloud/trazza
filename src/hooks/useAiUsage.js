import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/customSupabaseClient';
import { authHeaders } from '@/lib/authHeaders';

const FEATURE_LIMITS_FALLBACK = {
  chat: { daily: 100, monthly: 500 },
  analysis: { daily: 30, monthly: 100 },
  import: { daily: 50, monthly: 200 },
};

function normalizeLimitValue(value) {
  if (value == null) return Infinity;
  const n = Number(value);
  return Number.isFinite(n) ? n : Infinity;
}

function normalizeFeatureLimits(raw) {
  return {
    daily: normalizeLimitValue(raw?.daily),
    monthly: normalizeLimitValue(raw?.monthly),
  };
}

let cachedLimits = null;
let cachedLimitsUserId = null;
let limitsInFlight = null;

async function loadServerAiLimits(userId) {
  if (cachedLimits && cachedLimitsUserId === userId) return cachedLimits;
  if (limitsInFlight && cachedLimitsUserId === userId) return limitsInFlight;

  cachedLimitsUserId = userId;
  limitsInFlight = (async () => {
    try {
      const headers = await authHeaders();
      if (!headers.Authorization) return null;
      const resp = await fetch('/api/ai/limits', { headers });
      if (!resp.ok) return null;
      const body = await resp.json();
      const out = {
        enabled: Boolean(body?.enabled),
        chat: normalizeFeatureLimits(body?.chat),
        analysis: normalizeFeatureLimits(body?.analysis),
        import: normalizeFeatureLimits(body?.import),
      };
      cachedLimits = out;
      return out;
    } catch {
      return null;
    } finally {
      limitsInFlight = null;
    }
  })();

  return limitsInFlight;
}

export function resetAiLimitsCache() {
  cachedLimits = null;
  cachedLimitsUserId = null;
  limitsInFlight = null;
}

/**
 * Reads the current AI usage for a given feature from Supabase and
 * applies server-configured limits from GET /api/ai/limits (enforced in rateLimiter).
 */
export function useAiUsage(feature) {
  const [usage, setUsage] = useState({ daily: 0, monthly: 0 });
  const [limits, setLimits] = useState(FEATURE_LIMITS_FALLBACK[feature] || { daily: 100, monthly: 1000 });
  const [aiEnabled, setAiEnabled] = useState(true);
  const [loading, setLoading] = useState(true);

  // UTC A PROPÓSITO (no localTodayIso): el server cuenta la cuota por día UTC
  // (routes/rateLimiter.js getPeriods); si este día fuese local no cuadrarían.
  const today = new Date().toISOString().split('T')[0];
  const month = today.slice(0, 7);

  const refresh = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const userId = session?.user?.id;
      if (!userId) {
        resetAiLimitsCache();
        return;
      }

      const [serverLimits, usageResult] = await Promise.all([
        loadServerAiLimits(userId),
        supabase
          .from('ai_usage')
          .select('period, count')
          .eq('feature', feature)
          .in('period', [today, month]),
      ]);

      if (serverLimits?.[feature]) {
        setLimits(serverLimits[feature]);
        setAiEnabled(serverLimits.enabled);
      }

      const { data: usageRows } = usageResult;
      setUsage({
        daily: usageRows?.find((r) => r.period === today)?.count ?? 0,
        monthly: usageRows?.find((r) => r.period === month)?.count ?? 0,
      });
    } catch {
      // Non-critical — keep previous state
    } finally {
      setLoading(false);
    }
  }, [feature, today, month]);

  useEffect(() => { refresh(); }, [refresh]);

  const unlimited = !Number.isFinite(limits.daily) || !Number.isFinite(limits.monthly);
  const dailyLeft = unlimited ? Infinity : Math.max(0, limits.daily - usage.daily);
  const monthlyLeft = unlimited ? Infinity : Math.max(0, limits.monthly - usage.monthly);
  const exhausted = !unlimited && (dailyLeft === 0 || monthlyLeft === 0);

  return {
    usage,
    limits,
    dailyLeft,
    monthlyLeft,
    exhausted,
    dailyExhausted: !unlimited && dailyLeft === 0,
    monthlyExhausted: !unlimited && monthlyLeft === 0,
    unlimited,
    aiEnabled,
    loading,
    refresh,
  };
}
