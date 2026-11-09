#!/bin/sh
# Aplica baseline + migraciones en orden lexicográfico (ver supabase/README.md).
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

if [ -z "${JWT_SECRET:-}" ]; then
  echo "JWT_SECRET is required for self-hosted (GoTrue/PostgREST). Set it in .env — see docs/self-hosting.md" >&2
  exit 1
fi

ROOT="${MIGRATIONS_ROOT:-/migrations}"
BASELINE="${ROOT}/baseline/schema.sql"

if [ ! -f "$BASELINE" ]; then
  echo "Missing baseline: $BASELINE" >&2
  exit 1
fi

echo "[migrate] Applying baseline…"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$BASELINE"

echo "[migrate] Applying migrations…"
for f in $(find "${ROOT}/migrations" -maxdepth 1 -name '*.sql' | sort); do
  echo "[migrate] → $(basename "$f")"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done

echo "[migrate] Done."
