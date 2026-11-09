-- Rich diagnostic context for import telemetry: error stack + code, source file
-- name/size, header line, duration, ledger-audit summary, save-plan counts…
-- The flat columns answer "how often does it fail"; details answers "why".
alter table public.import_logs
  add column if not exists details jsonb;
