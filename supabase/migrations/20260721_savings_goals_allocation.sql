-- Envelope model for savings goals: the user assigns money from their
-- accumulated savings to each goal, so the same euro isn't counted toward
-- several goals at once. Progress = allocated_amount / target_amount.
ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS allocated_amount numeric NOT NULL DEFAULT 0;
