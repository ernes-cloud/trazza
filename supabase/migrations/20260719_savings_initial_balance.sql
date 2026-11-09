-- Money the user already had saved before using the expenses module.
-- Counts as the starting point of every savings goal, of the annual savings
-- objective (achieved + projection) and of the total balance in the goals card.
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS savings_initial_balance numeric;
