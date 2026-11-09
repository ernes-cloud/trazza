-- Add cached_metrics column to portfolio_shares.
-- Stores pre-computed financial metrics captured from the owner's Dashboard
-- at share-creation time. Used by the public share endpoint when live
-- transaction history is not available in the transactions table
-- (e.g. when the owner's imports are loaded in the frontend but not yet
-- confirmed / saved to the DB).
--
-- The column is populated for both 'live' and 'snapshot' mode shares.
-- For live shares the server merges these cached values with fresh position
-- prices fetched at request time.

ALTER TABLE portfolio_shares
  ADD COLUMN IF NOT EXISTS cached_metrics JSONB;

COMMENT ON COLUMN portfolio_shares.cached_metrics IS
  'Pre-computed portfolio metrics (all values in EUR) captured when the share link was created.';
