# Trazza (OSS)

Open-source portfolio tracking: multi-broker imports, live valuations, performance metrics (TWR, FIFO, Modified Dietz), watchlists, rebalancing, backtests, and optional AI-assisted import validation.

This tree is the **OSS carve-out** (portfolio app only). It does not ship landing/blog, expenses, Stripe billing, or production ops docs from the private monorepo.

## Features

- CSV import (DeGiro, IBKR, Binance, and more) with preview and deduplication
- Multi-broker positions, cash reconciliation, and shared portfolio links
- Dashboard widgets, alerts, favorites, and admin user tools
- Market data via Yahoo Finance (primary) with optional EODHD
- Optional Groq-powered AI (import validation, chat, scoring) with env-based quotas

## Quick start

### Prerequisites

- Node.js ≥ 22
- A Supabase project ([cloud](https://supabase.com) or [self-hosted Docker](./docs/self-hosting.md))

### Local development

```bash
cp .env.example .env
# Fill VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

npm ci
cd server && npm ci && cd ..

# Terminal 1 — API (default :4000)
cd server && node index.js

# Terminal 2 — frontend (:3000)
VITE_VALIDATION_SERVER_URL=http://localhost:4000 npm run dev
```

**Dotenv:** the Express server loads `server/.env` first, then the repo root `.env` (`server/loadEnv.js`). Vite reads `VITE_*` from the environment when you start `npm run dev` / `npm run build` (typically via root `.env`).

### Docker (recommended for production-like runs)

> **Tested path:** `docker compose --profile cloud up --build` is the profile verified in CI and for local production-like runs. The **`self-hosted` profile is EXPERIMENTAL and UNTESTED** — use it only if you accept breakage and missing features; details in [docs/self-hosting.md](./docs/self-hosting.md).

**Supabase Cloud** — external project, app + nginx only (tested):

```bash
cp .env.example .env
docker compose --profile cloud up --build
# UI → http://localhost:8080  API health → app container GET /health
```

**Self-hosted Supabase (EXPERIMENTAL, UNTESTED)** — adds Postgres, GoTrue, PostgREST, Kong, and migrations:

```bash
# See docs/self-hosting.md for JWT_SECRET, keys, and first admin
docker compose --profile self-hosted up --build
```

### Static assets vs API

- **nginx (`web` service)** serves the Vite `dist/` output on port **80** (mapped to `HTTP_PORT`, default **8080**).
- **Express (`app` service)** listens on **`PORT`** (default **4000**). It exposes **`GET /health`** and all `/api/*`, `/webhooks/*`, and `/share-data/*` routes. It does **not** serve `dist/`; nginx proxies those paths to the app.
- **`WEB_STATIC_ROOT`:** set to the real webroot that serves the built front (Compose uses `/app/dist`). `/share` fails if the HTML is not found there. Default: `/srv/www/<host>`. Details: [docs/self-hosting.md](./docs/self-hosting.md).

## Admin and AI limits (OSS model)

There is **no paid tier**, **no `plan` column** in the database, and **no** global stats route such as **`/api/admin/stats`**. Access control is server configuration only.

### Who is admin

1. **`ADMIN_EMAILS`** (recommended): comma-separated list in `server/.env`. Only Supabase accounts with a verified email match.
2. **Fallback:** if `ADMIN_EMAILS` is empty, the **first registered and verified user** becomes admin (stored in `server_app_config`). The server logs a warning on startup.

Admins get unlimited AI quota and access to `/app/admin` (users, import health, manual snapshots, etc.). There is **no** API to change “plan” or fetch global admin statistics.

### AI limits for everyone else

Requires `GROQ_API_KEY` on the server; without it, AI routes return **503**. With a key, limits come from environment variables (the UI loads them via `GET /api/ai/limits`):

| Variable | Purpose |
|---|---|
| `AI_DAILY_LIMIT_USER` / `AI_MONTHLY_LIMIT_USER` | Default cap across all AI features |
| `AI_DAILY_LIMIT_CHAT`, `AI_DAILY_LIMIT_ANALYSIS`, `AI_DAILY_LIMIT_IMPORT` | Per-feature daily overrides |
| `AI_MONTHLY_LIMIT_CHAT`, … | Per-feature monthly overrides |

Code defaults when unset: chat 100/500, analysis 30/100, import 50/200 (day/month).

### Email

Without `RESEND_API_KEY` or SMTP (`EMAIL_HOST`, …), contact and notification email paths return **503** (`email_not_configured`). No production addresses are injected in development.

## Tests

Full CI runs `npm run lint`, `npm test`, `npm run build`, and Playwright smokes. Locally:

```bash
npm run lint
npm test
```

See `supabase/README.md` for database baseline + migration order.

## License

Released under the [MIT License](./LICENSE). Copyright holder line is pending final legal name (`TODO` in LICENSE).

`package.json` keeps `"private": true` so this workspace is not accidentally published to npm as the upstream product name; the OSS release on GitHub is still MIT.

## Security

See [SECURITY.md](./SECURITY.md). Self-hosting hardening and backups: [docs/self-hosting.md](./docs/self-hosting.md).
