-- Portfolio sharing: users can generate public links to share their portfolio
-- with configurable privacy settings, broker selection and optional expiration.

CREATE TABLE IF NOT EXISTS portfolio_shares (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label         TEXT,
  mode          TEXT        NOT NULL DEFAULT 'live'
                            CONSTRAINT valid_share_mode CHECK (mode IN ('live', 'snapshot')),
  snapshot_data JSONB,                  -- populated when mode = 'snapshot'
  broker_ids    UUID[],                 -- NULL = all brokers included
  config        JSONB       NOT NULL DEFAULT '{
    "show_values": true,
    "show_pnl": true,
    "show_cost_basis": false,
    "show_chart": true,
    "show_broker_names": false
  }'::jsonb,
  expires_at    TIMESTAMPTZ,            -- NULL = never expires
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE portfolio_shares ENABLE ROW LEVEL SECURITY;

-- Owners can manage their own shares (create, read, update, delete)
DROP POLICY IF EXISTS "share_owner_all" ON portfolio_shares;
CREATE POLICY "share_owner_all" ON portfolio_shares
  FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Index for fast lookup by owner
CREATE INDEX IF NOT EXISTS portfolio_shares_user_id_idx ON portfolio_shares(user_id);
