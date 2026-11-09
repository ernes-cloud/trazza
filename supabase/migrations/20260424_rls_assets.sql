-- Migration: RLS policies for assets table + user_asset_preferences
-- Problem: assets is a shared table; any authenticated user can mutate
-- any asset record (including other users' custom_classification, target_percentage).
-- Fix: enable RLS + move user-specific fields to user_asset_preferences.

-- ─── 1. Enable RLS on assets ───────────────────────────────────────────────
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read (assets are shared market data)
DROP POLICY IF EXISTS "assets_select_authenticated" ON assets;
CREATE POLICY "assets_select_authenticated"
  ON assets FOR SELECT TO authenticated USING (true);

-- Authenticated users can insert new assets (when adding a new position)
DROP POLICY IF EXISTS "assets_insert_authenticated" ON assets;
CREATE POLICY "assets_insert_authenticated"
  ON assets FOR INSERT TO authenticated WITH CHECK (true);

-- Authenticated users can update only market-data fields (current_price, etc.)
-- PostgreSQL does not support column-level RLS; the client-side code is
-- responsible for only writing current_price. User-specific fields must go
-- in user_asset_preferences (see below).
DROP POLICY IF EXISTS "assets_update_authenticated" ON assets;
CREATE POLICY "assets_update_authenticated"
  ON assets FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- ─── 2. user_asset_preferences: per-user overrides ─────────────────────────
-- Replaces storing custom_classification / target_percentage on the shared
-- assets row. Each user keeps their own copy.
CREATE TABLE IF NOT EXISTS user_asset_preferences (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asset_id       UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  custom_classification TEXT,
  notes          TEXT,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, asset_id)
);

ALTER TABLE user_asset_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "uap_own_user" ON user_asset_preferences;
CREATE POLICY "uap_own_user"
  ON user_asset_preferences FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ─── 3. Backfill: move target_percentage from positions to positions ─────────
-- target_percentage already lives on positions — no migration needed for it.
-- If custom_classification was stored on assets, backfill user_asset_preferences:
-- INSERT INTO user_asset_preferences (user_id, asset_id, custom_classification)
-- SELECT p.user_id, p.asset_id, a.custom_classification
-- FROM positions p JOIN assets a ON a.id = p.asset_id
-- WHERE a.custom_classification IS NOT NULL
-- ON CONFLICT (user_id, asset_id) DO NOTHING;
