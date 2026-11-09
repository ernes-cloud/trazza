-- Personal expense/income tracking (opt-in feature, orthogonal to the investment
-- tables — it must NEVER feed portfolio math). Recurring entries are stored as
-- template rows (recurrence='monthly'); the client materializes missed occurrences
-- as real rows (recurrence='none') pointing back via recurring_source_id, one per
-- (template, month) — enforced by the partial UNIQUE index below.

CREATE TABLE IF NOT EXISTS expense_entries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type                text NOT NULL CHECK (type IN ('expense', 'income')),
  category            text NOT NULL DEFAULT 'other',
  amount              numeric NOT NULL CHECK (amount > 0), -- always positive; sign comes from type
  currency            text NOT NULL DEFAULT 'EUR',
  entry_date          date NOT NULL,
  notes               text,
  recurrence          text NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none', 'monthly')),
  recurrence_day      integer CHECK (recurrence_day BETWEEN 1 AND 31),
  recurrence_active   boolean NOT NULL DEFAULT true,
  recurring_source_id uuid REFERENCES expense_entries(id) ON DELETE SET NULL,
  source_month        text, -- 'YYYY-MM' on materialized occurrences
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expense_entries_user_date
  ON expense_entries (user_id, entry_date);

-- Materialization idempotence: at most one occurrence per template and month,
-- even if two tabs run the catch-up insert concurrently.
CREATE UNIQUE INDEX IF NOT EXISTS uq_expense_entries_source_month
  ON expense_entries (recurring_source_id, source_month)
  WHERE recurring_source_id IS NOT NULL;

ALTER TABLE expense_entries ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'expense_entries' AND policyname = 'users manage own expense_entries') THEN
    CREATE POLICY "users manage own expense_entries"
      ON expense_entries FOR ALL
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

-- Opt-in flag: the feature is hidden (nav + page) until the user enables it in Settings.
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS expenses_enabled boolean NOT NULL DEFAULT false;
