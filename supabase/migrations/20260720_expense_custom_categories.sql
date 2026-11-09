-- User-defined custom categories for the expenses module, stored as
-- { "expense": ["Mascota", ...], "income": ["Bonus", ...] } on the prefs row.
-- Custom categories are stored by their display name (they have no i18n key);
-- the UI falls back to the raw name for anything not in the predefined set.
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS custom_categories jsonb;
