-- Add performance_data column to portfolio_shares.
-- Stores sampled TTWROR chart data (weekly points) captured at share-creation time.
-- Format: [{ date: 'YYYY-MM-DD', pct: number }]
-- This avoids server-side recomputation and works even when daily_snapshots is empty.

ALTER TABLE portfolio_shares
  ADD COLUMN IF NOT EXISTS performance_data JSONB;

COMMENT ON COLUMN portfolio_shares.performance_data IS
  'Sampled weekly TTWROR chart data captured when the share link was created. Array of {date, pct}.';
