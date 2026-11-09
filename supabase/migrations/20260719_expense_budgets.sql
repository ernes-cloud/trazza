-- Per-category monthly budget limits for the expenses module.
-- Stored as a small JSON map { "<categorySlug>": <monthlyLimit>, ... } on the
-- user's preferences row (a separate table would be ceremony for a <20-key map).
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS expense_budgets jsonb;
