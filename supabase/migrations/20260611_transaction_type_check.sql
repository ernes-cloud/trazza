-- Extend the transaction_type CHECK constraint.
-- The original constraint only allowed BUY/SELL/DIVIDEND/FEE/TAX/CASH, but the
-- importers also emit:
--   * FEES     — IBKR fee rows (Transaction Fee, Misc. Fee…)
--   * TRANSFER — DeGiro/IBKR/Binance cash deposits & withdrawals
-- Saving a DeGiro/IBKR import failed the whole bulk insert with
-- "violates check constraint transactions_transaction_type_check".

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_transaction_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_transaction_type_check
  CHECK (transaction_type IN ('BUY','SELL','DIVIDEND','FEE','FEES','TAX','CASH','TRANSFER'));

-- recompute_cash_balance must also count TRANSFER rows (deposits/withdrawals on the
-- cash position) as cash effects, now that they can actually be stored.
-- grant-exempt: service_role
CREATE OR REPLACE FUNCTION recompute_cash_balance(
  p_cash_position_id UUID,
  p_apply BOOLEAN DEFAULT false
) RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_broker_id UUID;
  v_currency  TEXT;
  v_balance   NUMERIC := 0;
  v_anchor_ts TIMESTAMPTZ := NULL;
BEGIN
  SELECT p.broker_id, a.currency INTO v_broker_id, v_currency
  FROM positions p
  JOIN assets a ON a.id = p.asset_id
  WHERE p.id = p_cash_position_id
    AND (a.asset_class = 'Cash' OR a.ticker LIKE 'CASH\_%')
    AND EXISTS (SELECT 1 FROM brokers b
                WHERE b.id = p.broker_id AND b.user_id = auth.uid());

  IF v_broker_id IS NULL THEN
    RAISE EXCEPTION 'Cash position % not found or not owned by current user', p_cash_position_id;
  END IF;

  SELECT t.total_amount, t.transaction_date INTO v_balance, v_anchor_ts
  FROM transactions t
  WHERE t.position_id = p_cash_position_id
    AND t.is_ending_cash = true
  ORDER BY t.transaction_date DESC
  LIMIT 1;

  v_balance := COALESCE(v_balance, 0);

  SELECT v_balance + COALESCE(SUM(
    CASE
      WHEN t.transaction_type IN ('CASH', 'TRANSFER') AND t.position_id = p_cash_position_id
        THEN t.total_amount
      WHEN t.transaction_type IN ('SELL', 'DIVIDEND') AND a.currency = v_currency
        THEN ABS(t.total_amount)
      WHEN t.transaction_type IN ('FEE', 'FEES', 'TAX')
           AND (a.currency = v_currency OR t.position_id = p_cash_position_id)
        THEN -ABS(t.total_amount)
      ELSE 0
    END), 0)
  INTO v_balance
  FROM transactions t
  JOIN positions p ON p.id = t.position_id
  JOIN assets a    ON a.id = p.asset_id
  WHERE p.broker_id = v_broker_id
    AND t.is_ending_cash = false
    AND (v_anchor_ts IS NULL OR t.transaction_date > v_anchor_ts)
    AND (
      t.position_id = p_cash_position_id
      OR (a.asset_class <> 'Cash' AND a.ticker NOT LIKE 'CASH\_%')
    );

  IF p_apply THEN
    UPDATE positions SET quantity = v_balance WHERE id = p_cash_position_id;
  END IF;

  RETURN v_balance;
END;
$$;

REVOKE ALL ON FUNCTION public.recompute_cash_balance(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_cash_balance(uuid, boolean) TO service_role;
