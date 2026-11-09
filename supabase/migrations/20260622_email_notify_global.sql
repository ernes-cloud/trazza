-- Add two global email notification preferences to user_preferences.
-- email_notify_weekly_report   → weekly PDF portfolio report (sent to all portfolios)
-- email_notify_portfolio_alerts → AI-powered portfolio vigilance alerts (all portfolios combined)

ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS email_notify_weekly_report   boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS email_notify_portfolio_alerts boolean DEFAULT false;
