-- Migration: corporate_actions table
-- Tracks stock splits, reverse splits, spin-offs, and mergers so the
-- FIFO cost basis engine can adjust historical quantities and prices.

CREATE TABLE IF NOT EXISTS corporate_actions (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  asset_id       UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  -- 'SPLIT' | 'REVERSE_SPLIT' | 'SPINOFF' | 'MERGER'
  action_type    TEXT NOT NULL,
  effective_date DATE NOT NULL,
  -- For SPLIT 10:1 → ratio = 10  (qty × ratio, price ÷ ratio)
  -- For REVERSE_SPLIT 1:10 → ratio = 0.1
  ratio          DECIMAL(20, 10) NOT NULL,
  notes          TEXT,
  created_at     TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT valid_action_type CHECK (action_type IN ('SPLIT', 'REVERSE_SPLIT', 'SPINOFF', 'MERGER')),
  CONSTRAINT positive_ratio CHECK (ratio > 0)
);

CREATE INDEX IF NOT EXISTS corporate_actions_asset_date
  ON corporate_actions(asset_id, effective_date);

-- All authenticated users can read (public reference data)
ALTER TABLE corporate_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "corporate_actions_read" ON corporate_actions;
CREATE POLICY "corporate_actions_read"
  ON corporate_actions FOR SELECT TO authenticated USING (true);

-- Only service_role (backend) inserts corporate actions
-- Uncomment if you want to allow admin users to insert:
-- CREATE POLICY "corporate_actions_insert_admin" ON corporate_actions
--   FOR INSERT TO authenticated WITH CHECK (auth.jwt() ->> 'role' = 'admin');
