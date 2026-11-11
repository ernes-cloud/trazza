# Gastos (self-hosted)

The Gastos (expenses and savings) module is included in this OSS export.
It is available to every authenticated user: there is no admin, beta or
owner allowlist. Each user enables it with the opt-in
`user_preferences.expenses_enabled`.

Tables: `expense_entries`, `expense_projects`, `savings_goals` and
`user_preferences`, with row level security and policies for the
`authenticated` role.

Recurring-end notification cron (optional env):

- `APP_TIMEZONE` (IANA timezone, default UTC)
- `EXPENSES_RECURRING_END_INTERVAL_MS` (interval in milliseconds)

This is export-only documentation. It does not include
`docs/claude/expenses.md` from the product repo.
