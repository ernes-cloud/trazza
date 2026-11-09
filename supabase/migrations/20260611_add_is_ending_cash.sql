-- The CSV import writes is_ending_cash on every transaction row (true only for
-- ending-cash snapshot rows, e.g. MyInvestor exports), and recompute_cash_balance
-- anchors on it — but no migration ever created the column, so imports fail with
-- "Could not find the 'is_ending_cash' column of 'transactions' in the schema cache".

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS is_ending_cash BOOLEAN DEFAULT false;

COMMENT ON COLUMN transactions.is_ending_cash IS
  'True for CASH rows that are broker-statement ending-balance snapshots (not flow events). Used as the anchor by recompute_cash_balance.';

-- Refresh the PostgREST schema cache so the API sees the new column immediately
NOTIFY pgrst, 'reload schema';
