-- Purpose-based savings goals for the expenses module ("save X for the bike by
-- date Y"). Progress is DERIVED client-side from expense_entries net savings in
-- the goal's [start_date → today] window — no contribution ledger in v1, so
-- overlapping goals count the same savings toward each of them.

CREATE TABLE IF NOT EXISTS savings_goals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  target_amount numeric NOT NULL CHECK (target_amount > 0),
  target_date   date NOT NULL,
  start_date    date NOT NULL DEFAULT CURRENT_DATE,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_savings_goals_user ON savings_goals (user_id, target_date);

ALTER TABLE savings_goals ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'savings_goals' AND policyname = 'users manage own savings_goals') THEN
    CREATE POLICY "users manage own savings_goals"
      ON savings_goals FOR ALL
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;
