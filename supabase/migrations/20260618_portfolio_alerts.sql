-- Portfolio-level price alert (one per user, "cartera general").
-- Notifies the user when their TOTAL portfolio's daily change crosses ±threshold.
-- The server cron (notificationCron.js) evaluates this and inserts a notification,
-- which the existing webhook turns into an email.

CREATE TABLE IF NOT EXISTS portfolio_alerts (
  user_id       uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled       boolean NOT NULL DEFAULT true,
  threshold_pct numeric NOT NULL DEFAULT 5 CHECK (threshold_pct > 0 AND threshold_pct <= 100),
  direction     text NOT NULL DEFAULT 'both' CHECK (direction IN ('up', 'down', 'both')),
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

-- Each user fully manages their own alert row. The cron uses the service role
-- key, which bypasses RLS.
ALTER TABLE portfolio_alerts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'portfolio_alerts' AND policyname = 'users manage own portfolio_alerts') THEN
    CREATE POLICY "users manage own portfolio_alerts"
      ON portfolio_alerts FOR ALL
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;
