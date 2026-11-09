-- Server-only dedupe / daily notification email slots (OSS; replaces email_sends for crons).

CREATE TABLE IF NOT EXISTS public.report_sends (
  user_id    uuid NOT NULL,
  kind       text NOT NULL,
  period_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind, period_key)
);

ALTER TABLE public.report_sends ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.report_sends FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.report_sends TO service_role;
