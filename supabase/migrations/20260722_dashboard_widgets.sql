-- Per-user dashboard widget layout: { "order": ["summary","growth",...],
-- "hidden": ["news"] }. Absent/unknown ids fall back to the code registry, so
-- adding a new widget later shows up for everyone without a data migration.
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS dashboard_widgets jsonb;
