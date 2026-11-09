-- ============================================================================
-- SnapTrade broker-API integration — credential + account mapping storage
-- ============================================================================
-- snaptrade_users holds the per-user SnapTrade userSecret: it is a CREDENTIAL
-- (grants read access to the user's brokerage data) and must never reach the
-- browser. Both tables have RLS enabled with NO policies — only the server
-- (service role) reads/writes; the client goes through /api/snaptrade/*.

create table if not exists public.snaptrade_users (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  st_user_secret text not null,
  created_at     timestamptz not null default now()
);

alter table public.snaptrade_users enable row level security;

-- Maps a connected SnapTrade account to the Trazza broker it feeds, so
-- re-syncs land in the same broker and the UI can show connection state.
create table if not exists public.snaptrade_accounts (
  st_account_id    text primary key,
  user_id          uuid not null references auth.users (id) on delete cascade,
  broker_id        uuid,
  institution_name text,
  last_sync_at     timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists idx_snaptrade_accounts_user
  on public.snaptrade_accounts (user_id);

alter table public.snaptrade_accounts enable row level security;
