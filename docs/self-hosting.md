# Self-hosting Trazza

> **⚠️ EXPERIMENTAL / UNTESTED:** The Docker Compose **`self-hosted` profile** (Postgres + GoTrue + PostgREST + Kong in compose) is **not** covered by the same build/up verification as the **`cloud` profile**. Expect gaps vs managed Supabase and possible compose breakage. For a supported path, use **Supabase Cloud** + `docker compose --profile cloud up --build`.

Trazza supports two deployment modes:

1. **Supabase Cloud (tested)** — managed Postgres + Auth; you run Trazza’s Express API and static frontend in Docker (or bare metal). Compose profile: `cloud`.
2. **Supabase in Docker (EXPERIMENTAL, UNTESTED)** — the compose `self-hosted` profile runs Postgres, applies schema migrations, and exposes a minimal Auth + PostgREST stack behind Kong.

## Architecture

| Component | Role | Default port |
|-----------|------|--------------|
| `web` (nginx) | Serves `dist/`, proxies `/api/*`, `/webhooks/*`, `/share-data/*` to Express | 8080 (host) |
| `app` (Express) | API, crons, webhooks; `GET /health` | 4000 (internal) |
| `kong` (self-hosted) | Supabase-compatible API gateway | 8000 |
| `db` (self-hosted) | PostgreSQL with Supabase extensions | 5432 (internal) |

Content-Security-Policy for HTML responses is defined in `docker/nginx/templates/snippets/html-headers.conf.template`. The Docker `web` image substitutes **`CSP_SUPABASE_ORIGIN`** at container start (official nginx image envsubst). Do not weaken `script-src` or `style-src`; add hosts via the template only when you introduce new connect targets.


## Share pages (`/share`) and `WEB_STATIC_ROOT`

Express serves `/share/:token` by reading the built frontend HTML from disk. Set **`WEB_STATIC_ROOT`** to the real webroot that serves that built front (Compose sets `/app/dist`). If the HTML is not found there, `/share` fails. Default when unset: `/srv/www/<host>` (hostname from `APP_URL` / `VITE_APP_URL`). See `.env.example`.

## Supabase Cloud mode

1. Create a Supabase project. Note **Project URL**, **anon key**, and **service_role key**.
2. Copy `.env.example` → `.env`:
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` — baked into the frontend at **build** time (`docker compose` build args).
   - `SUPABASE_SERVICE_ROLE_KEY` — runtime secret for the `app` service.
   - `ALLOWED_ORIGINS` — your public origin (e.g. `https://portfolio.example.com`).
   - `VITE_APP_URL` / `APP_URL` — same origin for share links and emails.
3. Apply database schema:
   - Run `supabase/baseline/schema.sql`, then every file in `supabase/migrations/` in **sorted filename order** (see `supabase/README.md`).
4. Start: `docker compose --profile cloud up --build`
5. Healthchecks: `curl -f http://localhost:8080/health` (proxied to Express).

### First admin

- Set `ADMIN_EMAILS=you@example.com` (comma-separated, lowercased in code).
- If unset, the **first confirmed user** receives admin capabilities (see server rate limiter / `requireAdmin`).

## Self-hosted Supabase (Docker profile) — EXPERIMENTAL, UNTESTED

**Warning:** This section describes the **`self-hosted` Compose profile**, which is **experimental and untested** in this repository (unlike `cloud`, where `docker compose build` / `up` is verified). Do not rely on it for production without your own validation.

This profile is **opinionated and minimal**: Auth + REST via Kong. It does not mirror every Supabase managed feature (Realtime, Storage, Edge Functions). Verify against your needs before production.

### 1. Secrets

In `.env`:

```env
POSTGRES_PASSWORD=choose-a-strong-password
JWT_SECRET=at-least-32-random-bytes
VITE_SUPABASE_URL=http://localhost:8000
SUPABASE_PUBLIC_URL=http://localhost:8000
CSP_SUPABASE_ORIGIN=http://localhost:8000
SITE_URL=http://localhost:8080
VITE_APP_URL=http://localhost:8080
ALLOWED_ORIGINS=http://localhost:8080
```

`JWT_SECRET` is not required for `docker compose --profile cloud` (Compose uses `${JWT_SECRET:-}` so the file parses without it). For `self-hosted`, the one-shot `migrate` service exits with an error if `JWT_SECRET` is unset, before GoTrue/PostgREST start.

Generate **anon** and **service_role** JWTs with the same `JWT_SECRET` and your Supabase project ref claims (standard Supabase JWT generator or `supabase status` from the official CLI). Set:

- `VITE_SUPABASE_ANON_KEY` — build-time
- `SUPABASE_SERVICE_ROLE_KEY` — runtime for `app`

**CSP note:** set `CSP_SUPABASE_ORIGIN` to the **origin** of `SUPABASE_PUBLIC_URL` (e.g. `http://localhost:8000` when Kong is on port 8000). The default `https://*.supabase.co` is for Supabase Cloud. No image rebuild is required — the `web` service re-renders the snippet on start. For a custom public API URL behind TLS, use that origin (e.g. `https://api.example.com`).

### 2. Migrations

The one-shot `migrate` service runs `docker/migrate/apply-migrations.sh`:

1. `supabase/baseline/schema.sql`
2. All `supabase/migrations/*.sql` in lexicographic order

Re-running `docker compose up` does **not** re-apply migrations unless you remove the `migrate` container and database volume.

### 3. Start stack (experimental)

```bash
docker compose --profile self-hosted up --build
```

Prefer `docker compose --profile cloud up --build` when you use Supabase Cloud (tested).

Order: `db` healthy → `migrate` completes → `auth` + `rest` → `kong` → `app` + `web`.

### 4. Groq (optional)

Set `GROQ_API_KEY` in `.env`. Without it, AI features disable gracefully (`server/lib/aiRouteGate.js`). Tune quotas with `AI_DAILY_LIMIT_*` / `AI_MONTHLY_LIMIT_*` in `.env.example`.

### 5. Email and webhooks (optional)

- **Resend** or **SMTP** env vars — required for `/api/contact` and notification emails.
- **`WEBHOOK_SECRET`** — must match Supabase Vault `notify_webhook_secret` if you enable the notification trigger (`supabase/README.md`).

### 6. Backups

- **Cloud:** use Supabase backups / PITR.
- **Self-hosted:** snapshot the `db-data` Docker volume or `pg_dump` on a schedule; store off-host. Test restores regularly.

### 7. Crons

Background jobs (notifications, portfolio snapshots, weekly report) run inside the `app` container unless `DISABLE_CRONS=1`. For horizontally scaled API replicas, run a single cron leader or set `DISABLE_CRONS=1` on secondary replicas.

## Development without Docker

See the root [README.md](../README.md). Use `DISABLE_CRONS=1` when pointing a local server at a shared database.
