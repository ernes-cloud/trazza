// Seguimiento de gastos/ahorros (opt-in feature).
//
// Pure module: aggregation and recurrence math over expense_entries rows.
// Rows come in two shapes:
// - Regular entries (recurrence 'none'): the only rows that count toward totals.
// - Templates (recurrence 'monthly'): never aggregated; the client materializes
//   their missed occurrences as regular rows via computeMissingOccurrences
//   (idempotent — the DB pins it with a UNIQUE (recurring_source_id, source_month)).
//   Deleting ONE occurrence tombstones it (expense_entries.skipped) instead of
//   removing the row, so the key survives and the catch-up never regenerates it;
//   skipped rows are filtered out of the state before any aggregation runs.
//
// Amounts are stored positive; `type` ('expense'|'income') carries the sign.
//
// Fachada: la implementación vive en services/expenses/ (entries, recurring,
// summaries, goals). Este fichero solo reexporta su API pública, así que los
// imports de siempre siguen valiendo.

export * from './expenses/fx.js';
export * from './expenses/entries.js';
export * from './expenses/recurring.js';
export * from './expenses/summaries.js';
export * from './expenses/goals.js';
