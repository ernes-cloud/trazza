-- Per-user Expenses-screen widget layout: { "order": ["savings_hero",...],
-- "hidden": ["budgets"] }. Same contract as dashboard_widgets — absent/unknown
-- ids fall back to the code registry (EXPENSES_PAGE_WIDGETS), so a new widget
-- shows up for everyone without a data migration.
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS expenses_widgets jsonb;
