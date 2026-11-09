-- Fix "Informes globales" checkbox not persisting: the 20260622 migration was
-- never applied to the live DB, so the wide SELECT in SettingsPage errored and
-- the fallback forced these flags to false (and the upsert failed).
-- Idempotent: safe to run whether or not 20260622 was applied.

-- Ensure the weekly report preference exists (the one option that stays).
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS email_notify_weekly_report boolean DEFAULT false;

-- Remove the portfolio vigilance alerts preference (option removed from Settings).
ALTER TABLE user_preferences
  DROP COLUMN IF EXISTS email_notify_portfolio_alerts;
