import { supabaseAdmin } from './adminSupabase.js';

/**
 * Persistent idempotency for server-sent emails (weekly report, notification cap).
 * Table `report_sends` is service_role-only; RLS on, no policies.
 */

export async function countReportSendsForDayPrefix({ userId, kind, dayPrefix }) {
  if (!supabaseAdmin || !userId) return null;
  const { count, error } = await supabaseAdmin
    .from('report_sends')
    .select('user_id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('kind', kind)
    .like('period_key', `${dayPrefix}:%`);
  if (error) {
    return null;
  }
  return count ?? 0;
}

/**
 * @returns {Promise<{ claimed: boolean } | null>} null = could not reach DB (caller may fail open)
 */
export async function claimReportSend({ userId, kind, periodKey }) {
  if (!supabaseAdmin || !userId || !periodKey) return null;
  const { data, error } = await supabaseAdmin
    .from('report_sends')
    .upsert(
      { user_id: userId, kind, period_key: periodKey },
      { onConflict: 'user_id,kind,period_key', ignoreDuplicates: true },
    )
    .select('user_id');
  if (error) return null;
  return { claimed: (data?.length ?? 0) > 0 };
}
