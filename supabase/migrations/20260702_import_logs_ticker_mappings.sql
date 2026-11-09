-- ============================================================================
-- 1) import_logs — persistent import telemetry (server-only via service role)
-- ============================================================================
-- Every parse/save attempt from the client lands here through POST /api/log-import.
-- Powers the admin success-rate metric and failure diagnosis. RLS is enabled
-- with NO policies: only the server (service role) can read/write.

create table if not exists public.import_logs (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  stage         text not null check (stage in ('parse', 'save')),
  broker        text,
  ok            boolean not null default false,
  format        text,
  rows          integer,
  transactions  integer,
  buy_sell      integer,
  error         text,
  -- Distinct unrecognized row descriptions (missing parser keywords — gold data)
  unrecognized  text[],
  -- Anonymized CSV sample, ONLY when the user explicitly consents to share it
  csv_sample    text
);

alter table public.import_logs enable row level security;

create index if not exists idx_import_logs_created_at
  on public.import_logs (created_at desc);

-- ============================================================================
-- 2) ticker_mappings — shared ISIN → Yahoo ticker cache (crowd-populated)
-- ============================================================================
-- Each ISIN gets resolved via Yahoo search ONCE; every user benefits afterwards.
-- 'manual' rows (user-confirmed assignments) beat 'auto' rows and are never
-- overwritten by automatic resolution.

create table if not exists public.ticker_mappings (
  isin        text primary key check (isin ~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$'),
  ticker      text not null check (char_length(ticker) between 1 and 20),
  source      text not null default 'auto' check (source in ('auto', 'manual')),
  updated_at  timestamptz not null default now()
);

alter table public.ticker_mappings enable row level security;

drop policy if exists ticker_mappings_select on public.ticker_mappings;
create policy ticker_mappings_select on public.ticker_mappings
  for select to authenticated using (true);

drop policy if exists ticker_mappings_insert on public.ticker_mappings;
create policy ticker_mappings_insert on public.ticker_mappings
  for insert to authenticated with check (true);

-- Updates allowed so wrong auto-resolutions can be corrected; the client only
-- overwrites 'auto' rows (manual assignments are authoritative).
drop policy if exists ticker_mappings_update on public.ticker_mappings;
create policy ticker_mappings_update on public.ticker_mappings
  for update to authenticated using (true) with check (true);
