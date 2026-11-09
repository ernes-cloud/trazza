-- Expenses module v1.1:
-- - recurrence_until: optional end date on recurring templates — no occurrence is
--   materialized after it (date-level comparison against the occurrence date).
-- - savings_goal_annual: the user's annual net-savings target, edited from the
--   expenses page (not Settings). NULL = no goal set.
-- Idempotent; safe to run whether or not 20260719_expense_entries.sql was applied first.

ALTER TABLE expense_entries ADD COLUMN IF NOT EXISTS recurrence_until date;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS savings_goal_annual numeric;
