-- Daily portfolio value snapshots, written by the server-side cron
-- (server/jobs/portfolioSnapshots.js). One row per user/scope/day with the
-- portfolio's REAL observed value — unlike the client's on-the-fly historical
-- reconstruction (today's Yahoo series), these are values actually seen on
-- each date, immune to split/delisting/share-class distortions.
--
-- v1 writes scope 'general' only. invested_eur is reserved for when the cron
-- adopts computeInvestedHybrid (cost basis); NULL until then.
-- NOTE (consumo): el chart de evolución seguirá con la reconstrucción actual
-- hasta que se acumulen suficientes snapshots — no integrar antes de tener datos.

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scope               TEXT NOT NULL DEFAULT 'general',   -- 'general' or a broker UUID
  snapshot_date       DATE NOT NULL,                     -- Europe/Madrid calendar date
  total_value_eur     NUMERIC NOT NULL,                  -- positions + cash, EUR
  positions_value_eur NUMERIC NOT NULL DEFAULT 0,
  cash_eur            NUMERIC NOT NULL DEFAULT 0,
  invested_eur        NUMERIC,                           -- reserved (cost basis), NULL for now
  breakdown           JSONB,                             -- [{ "t": ticker, "v": value_eur }]
  quote_misses        INT NOT NULL DEFAULT 0,            -- positions valued with DB price fallback
  computed_at         TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, scope, snapshot_date)
);

-- Chart queries read a user's series ordered by date
CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_user_date
  ON portfolio_snapshots (user_id, scope, snapshot_date);

ALTER TABLE portfolio_snapshots ENABLE ROW LEVEL SECURITY;

-- Users read their own series; ALL writes go through the service-role cron
-- (bypasses RLS) — no insert/update/delete policies on purpose.
DROP POLICY IF EXISTS "psnap_own_user_select" ON portfolio_snapshots;
CREATE POLICY "psnap_own_user_select"
  ON portfolio_snapshots FOR SELECT TO authenticated
  USING (user_id = auth.uid());
