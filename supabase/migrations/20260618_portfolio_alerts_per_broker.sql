-- Per-broker portfolio alerts.
-- Evolves portfolio_alerts from one row per user to one row per (user, scope),
-- where scope = 'general' (all brokers) or a broker id. Idempotent: works whether
-- or not the original 20260618_portfolio_alerts migration was already applied.

-- Fresh install (table never created): create with the new shape.
CREATE TABLE IF NOT EXISTS portfolio_alerts (
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scope         text NOT NULL DEFAULT 'general',   -- 'general' or a broker id
  enabled       boolean NOT NULL DEFAULT true,
  threshold_pct numeric NOT NULL DEFAULT 5 CHECK (threshold_pct > 0 AND threshold_pct <= 100),
  direction     text NOT NULL DEFAULT 'both' CHECK (direction IN ('up', 'down', 'both')),
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, scope)
);

-- Upgrade path (table existed with PK on user_id only and no scope column).
ALTER TABLE portfolio_alerts ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'general';

DO $$
DECLARE pk_has_scope boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
    WHERE i.indrelid = 'portfolio_alerts'::regclass
      AND i.indisprimary
      AND a.attname = 'scope'
  ) INTO pk_has_scope;

  IF NOT pk_has_scope THEN
    ALTER TABLE portfolio_alerts DROP CONSTRAINT IF EXISTS portfolio_alerts_pkey;
    ALTER TABLE portfolio_alerts ADD PRIMARY KEY (user_id, scope);
  END IF;
END $$;

-- RLS (idempotent — the original migration may already have set this).
ALTER TABLE portfolio_alerts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'portfolio_alerts' AND policyname = 'users manage own portfolio_alerts') THEN
    CREATE POLICY "users manage own portfolio_alerts"
      ON portfolio_alerts FOR ALL
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;
