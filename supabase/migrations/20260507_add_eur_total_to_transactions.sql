-- Add eur_total to transactions: the actual EUR equivalent paid/received at transaction
-- time, extracted from the DeGiro CSV FX-conversion row (Retirada Cambio de Divisa).
-- For EUR-denominated transactions this is NULL (total_amount is already in EUR).
-- For foreign-currency transactions (USD, GBP, etc.) this stores the real historical
-- EUR cost, avoiding the FX-timing distortion caused by converting at today's rate.

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS eur_total NUMERIC;

COMMENT ON COLUMN transactions.eur_total IS
  'EUR amount at transaction date for non-EUR positions (from broker FX row). NULL for EUR-denominated transactions.';
