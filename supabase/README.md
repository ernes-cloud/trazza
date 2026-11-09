# Supabase schema (OSS)

## Applying the database

Self-hosters and CI start from a **baseline** dump, then run every file in
`supabase/migrations/` in **lexicographic (timestamp) order**:

1. `supabase/baseline/schema.sql` (or `supabase/baseline/*.sql` in sorted order)
2. All `supabase/migrations/*.sql` once, in sort order

The OSS harness reapplies **step 2 only** a second time to prove idempotency
(`tools/oss/rlsBaseline.pg.test.js`).

## Do not re-run a single old migration in isolation

Migrations are written to be **idempotent only when replayed as the full ordered
chain** on top of the current baseline. Running one historical file alone—on a
database that already received later hardening—can **regress** security:

| Early migration | What it recreates if run alone | Later hardening undone |
|-----------------|--------------------------------|-------------------------|
| `20260424_rls_assets.sql` | `assets_insert_authenticated` with `WITH CHECK (true)` | `20261027000100` / `20261029000300` (server-only asset writes) |
| `20260610_atomic_rpcs_assets_rls.sql` | `GRANT EXECUTE ON update_asset_market_data … TO authenticated` | `20261026000100_asset_market_data_service_role.sql` (service role only) |
| `20260702_import_logs_ticker_mappings.sql` | `ticker_mappings_insert` with `WITH CHECK (true)` | `20261026000200_ticker_mappings_server_only.sql` |
| `20260716_core_tables_rls.sql` | Drops and recreates all core RLS policies | `20261107000300_fix_positions_transactions_with_check.sql` (I-1 AND form on positions/transactions) if that fix has not run yet |

**Always** apply `baseline` + **all** migrations in order (or use the platform’s
normal migration runner that does the same). Never cherry-pick an older SQL file
onto production or a long-lived fork without replaying everything that follows it.

## Security note (I-1)

Cross-tenant writes on `positions` / `transactions` are blocked by NULL-aware
**AND** policies on `broker_id` and `portfolio_id` (see
`20260716_core_tables_rls.sql` and `20261107000300_fix_positions_transactions_with_check.sql`).
The baseline dump may still show the old OR form; the migration chain replaces it.

## Notification email webhook (Vault)

Migration `20261107000400_notify_trigger_vault.sql` installs an `AFTER INSERT`
trigger on `public.notifications` that POSTs to your Trazza server
(`/webhooks/notify`) when **Supabase Vault** and **pg_net** are available.

Store these secrets in Vault (Dashboard → Project Settings → Vault, or SQL):

| Vault secret name | Purpose |
|-------------------|---------|
| `notify_webhook_url` | Full URL, e.g. `https://your-host/webhooks/notify` |
| `notify_webhook_secret` | Same value as server `WEBHOOK_SECRET` (sent as `x-webhook-secret`) |

If `vault`, `pg_net`, either secret, or the extensions are missing, the trigger
is a no-op and never raises an error.
