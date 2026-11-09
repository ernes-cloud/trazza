-- Fix security warnings from Supabase linter (WARN level).
--
-- 1. increment_ai_usage: add SET search_path (mutable search_path warning)
--    + revoke from anon/authenticated (called only by trazza-server via service role)
-- 2. handle_new_user_beta: revoke from anon/authenticated
--    (trigger function — not a REST endpoint)
-- 3. update_asset_market_data: revoke from anon only
--    (authenticated users DO call this via RPC to update market prices)

-- ── 1. increment_ai_usage ────────────────────────────────────────────────────
-- grant-exempt: service_role
CREATE OR REPLACE FUNCTION public.increment_ai_usage(
  p_user_id uuid,
  p_feature  text,
  p_period   text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO ai_usage (user_id, feature, period, count)
  VALUES (p_user_id, p_feature, p_period, 1)
  ON CONFLICT (user_id, feature, period)
  DO UPDATE SET
    count      = ai_usage.count + 1,
    updated_at = now()
  RETURNING count INTO v_count;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_ai_usage(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_ai_usage(uuid, text, text) TO service_role;

-- ── 2. handle_new_user_beta ──────────────────────────────────────────────────
-- Trigger function: fires on auth.users INSERT. Never a REST API endpoint.
REVOKE EXECUTE ON FUNCTION public.handle_new_user_beta() FROM anon;
REVOKE EXECUTE ON FUNCTION public.handle_new_user_beta() FROM authenticated;

-- ── 3. update_asset_market_data ─────────────────────────────────────────────
-- Called by authenticated clients via Supabase RPC to update live prices.
-- The function already guards with: IF auth.uid() IS NULL THEN RAISE EXCEPTION.
-- Only revoke anon access.
REVOKE EXECUTE ON FUNCTION public.update_asset_market_data(uuid, numeric, text, text, text, text, text, text) FROM anon;
