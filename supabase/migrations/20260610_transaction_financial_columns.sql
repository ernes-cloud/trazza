  -- Add first-class financial columns to transactions.
  -- Until now the actual trade currency lived only inside free-text `notes`
  -- ("Compra 10 MSFT @360,65 USD (US5949181045)" / "Compra Internacional (USD)")
  -- and trade commissions lived only inside the imported_data JSON blob.
  -- Parsing financial facts from prose at runtime is fragile; promote them to columns.

  ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS transaction_currency TEXT,
    ADD COLUMN IF NOT EXISTS fx_rate NUMERIC,
    ADD COLUMN IF NOT EXISTS commission NUMERIC;

  COMMENT ON COLUMN transactions.transaction_currency IS
    'ISO 4217 currency the trade was actually executed in (may differ from the asset''s listing currency, e.g. USD stock bought on Xetra in EUR). NULL = unknown, client falls back to parsing notes.';
  COMMENT ON COLUMN transactions.fx_rate IS
    'Exchange rate transaction_currency -> EUR at execution time, when the broker export provides it. NULL = unknown, client falls back to historical rate lookup.';
  COMMENT ON COLUMN transactions.commission IS
    'Trade commission embedded in a BUY/SELL (always invoiced in EUR by DeGiro/IBKR). NULL for rows imported before this column existed; backfilled on re-import. Standalone FEE rows keep using total_amount.';

  -- ── Backfill transaction_currency from notes ────────────────────────────────
  -- Format 1 — raw DeGiro description: "Compra 10 MSFT @360,65 USD (US...)"
  UPDATE transactions
  SET transaction_currency = (regexp_match(notes, '@[0-9.,]+\s+([A-Z]{3})\s+\('))[1]
  WHERE transaction_currency IS NULL
    AND notes ~ '@[0-9.,]+\s+[A-Z]{3}\s+\(';

  -- Format 2 — classification string: "Compra Directa (EUR)" / "Venta Internacional (USD)"
  UPDATE transactions
  SET transaction_currency = (regexp_match(notes, '(?:Compra|Venta)\s+(?:Directa|Internacional)\s+\(([A-Z]{3})\)'))[1]
  WHERE transaction_currency IS NULL
    AND notes ~ '(?:Compra|Venta)\s+(?:Directa|Internacional)\s+\([A-Z]{3}\)';
