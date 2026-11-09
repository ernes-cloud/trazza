-- AI usage rate limiting table
-- Tracks per-user, per-feature usage for daily and monthly limits.
-- period is 'YYYY-MM-DD' (daily) or 'YYYY-MM' (monthly).

CREATE TABLE IF NOT EXISTS ai_usage (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feature    text NOT NULL CHECK (feature IN ('chat', 'analysis', 'import')),
  period     text NOT NULL,
  count      integer NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (user_id, feature, period)
);

-- Users can only read their own rows. The server uses the service role key
-- to bypass RLS for writes (check + increment).
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'ai_usage' AND policyname = 'users read own ai_usage'
  ) THEN
    CREATE POLICY "users read own ai_usage"
      ON ai_usage FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- Atomic increment via a stored procedure so two simultaneous requests
-- for the same user+feature+period cannot both slip past the limit check.
CREATE OR REPLACE FUNCTION increment_ai_usage(
  p_user_id uuid,
  p_feature  text,
  p_period   text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
