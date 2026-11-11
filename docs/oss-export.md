# OSS export tree (`tools/oss/export-oss.mjs`)

## What it does

Builds a publishable copy of the repository under a target directory:

1. Lists paths with `git ls-files` (only tracked files; no `.git`, `node_modules`, or untracked secrets).
2. **Skips** every path matched by the same rules as `tools/oss/check-sanitized.mjs` (`.claude/`, `deploy/`, `docs/claude/{production,growth,history}.md`, `informes/`, root `test*.js`, etc.).
3. **Strips** forbidden substrings (``, ``) from text files in the copy only.
4. Merges into `.gitignore`: `informes/`, `.env*`, `e2e/artifacts/`.
5. Adds `.dockerignore` when the tree did not already have one.
6. Runs `checkSanitized({ root: targetDir, hashesFile })` and exits non-zero on violations (path + reason only).

## Usage

```bash
node tools/oss/export-oss.mjs /path/to/oss-export [--hashes /path/to/hashes.txt]
```

- **Target directory** must not exist or must be empty; otherwise the script refuses to run.
- **Hashes file**: `--hashes`, or `OSS_FORBIDDEN_HASHES_FILE`, or an empty temporary file (hash scan disabled but the check still runs).

## Related

- Sanitize check only (no copy): `OSS_FORBIDDEN_HASHES_FILE=… node tools/oss/check-sanitized.mjs`
- CI/tests: `tools/oss/checkSanitized.test.js`

## Gastos in the export

The export includes the Gastos (expenses and savings) UI, route, tables and tests. Access is a **universal opt-in** (`isExpensesFeatureAllowed`: any non-empty email; each user enables the module with `user_preferences.expenses_enabled`). User-facing documentation is written to [`docs/gastos.md`](./gastos.md) during the export if it is not already present. `docs/claude/expenses.md` from the product repo is excluded.

### In-memory filters on the oss-merge migrations

The published origin files are **not edited**. Two later origin steps would otherwise fail if the raw oss-merge chain were applied verbatim:

- `20261107001100_oss_remove_modules.sql` `DROP`s `expense_entries`, `expense_projects` and `savings_goals`, but `20261111000100_expense_ownership_rls_grants.sql` expects those tables to exist. The export comments out only those three `DROP`s (`filterOssRemoveModulesGastosDrops`). Other drops (beta, blog, billing leftovers, etc.) stay in place.
- `20261107000200_oss_cleanup_plan.sql` drops `guard_user_preferences_plan()`, but `20261111000100` still `GRANT`/`REVOKE`s that function. The export wraps those statements so they run only if the function exists (`filterP02OssPlanGuardGrants`).

Both transforms live in `tools/oss/export-oss.mjs` and are applied through `filterOssPgMigrationContent`. The origin `test:pg` harnesses call the **same function** when they load those files (they do not rewrite them on disk).

### The raw oss-merge chain is not deployable

Applying `supabase/baseline` + `supabase/migrations` **verbatim** from this branch (the unfiltered oss-merge chain) is **not a supported deploy path**: `20261107001100` would drop the Gastos tables, `20261107000200` would drop the plan-guard function, and `20261111000100` would fail. The publishable, applyable artifact is the **export** produced by `tools/oss/export-oss.mjs`. Use that tree (or the harness filters, in tests only) to apply migrations.

## e2e

`e2e/dashboard.smoke.mjs` opens `/app/settings` and clicks **Guardar**. It must only run against a local or test app (`BASE_URL`, default `http://localhost:3000`). It must never be pointed at production. When no local/test server is available, this smoke is left **pending**.
