-- Tombstone for a deleted recurring occurrence.
--
-- Deleting one occurrence of a monthly template used to DELETE the row, which
-- left a hole that computeMissingOccurrences re-filled on the very next
-- materialization pass (any later add/edit): "eliminar solo este" was undone by
-- the system a minute later. Marking the row instead keeps the
-- (recurring_source_id, source_month) key alive, so the catch-up sees the month
-- as already handled and never regenerates it.
--
-- Skipped rows are excluded from EVERY aggregation client-side (the hook filters
-- them out of the published state); they exist only to hold the gap.
-- The client degrades gracefully when this migration has not been applied yet:
-- an undefined `skipped` reads as false, and the UPDATE falls back to a DELETE.

ALTER TABLE expense_entries ADD COLUMN IF NOT EXISTS skipped boolean NOT NULL DEFAULT false;
