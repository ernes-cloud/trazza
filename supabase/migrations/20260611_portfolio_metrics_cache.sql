-- Cross-screen metrics cache: the brokers screen is where transactions change
-- (imports, manual ops) and where the shared FIFO pipeline always recomputes.
-- It publishes its computed totals here so the Dashboard and the share-portfolio
-- server can serve EXACTLY the same numbers instantly, instead of recomputing
-- (the share server in particular started with cold FX caches, making "Invertido"
-- lag behind the brokers screen until its caches warmed up).
--
-- Consumers validate freshness with metrics->>'txCount' (cache is used only when
-- it matches the live transaction count for the same scope) and currency.

CREATE TABLE IF NOT EXISTS portfolio_metrics_cache (
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scope       TEXT NOT NULL DEFAULT 'general',  -- 'general' or a broker UUID
  currency    TEXT NOT NULL,                    -- currency the metrics are denominated in
  metrics     JSONB NOT NULL,                   -- computeHistoryTotals output + txCount
  computed_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, scope)
);

ALTER TABLE portfolio_metrics_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pmc_own_user" ON portfolio_metrics_cache;
CREATE POLICY "pmc_own_user"
  ON portfolio_metrics_cache FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- The share server reads through the service-role key (bypasses RLS) — no extra policy.
