-- Cash balance reconciliation: derive a CASH position's quantity from the
-- transaction ledger instead of trusting the incrementally-maintained value.
--
-- Background: cash balances are updated incrementally on every manual operation
-- (now atomically via adjust_position_quantity, but still incremental). Drift can
-- still creep in from pre-RPC history or interrupted multi-step operations. This
-- function recomputes the balance from the ledger so the app (or an admin) can
-- reconcile on demand.
--
-- Semantics (mirrors the app's cash flows):
--   * Anchor: the most recent is_ending_cash=true CASH row on the cash position
--     (CSV imports write these snapshots). Balance starts there; only effects
--     AFTER the anchor timestamp are applied. Without an anchor, starts at 0 and
--     applies the full history.
--   * Effects applied (same broker, same currency as the cash position):
--       CASH on the cash position (non-snapshot)  → + total_amount (signed)
--       SELL on a same-currency stock position    → + total_amount
--       DIVIDEND on a same-currency position      → + total_amount
--       FEE/FEES/TAX on a same-currency position
--         or directly on the cash position        → − |total_amount|
--       BUY → no effect (the app never deducts manual/imported BUYs from cash)
--
-- Known limitation: manual commissions are linked to an EUR cash position even
-- when the related stock trades in another currency — those rows reconcile only
-- against the EUR cash position, matching how the app applied them originally.
--
-- p_apply=false (default) returns the computed balance WITHOUT writing, so the
-- client can show a "reconciliation diff" before the user confirms.
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

  -- Anchor on the latest ending-cash snapshot, if any
  SELECT t.total_amount, t.transaction_date INTO v_balance, v_anchor_ts
  FROM transactions t
  WHERE t.position_id = p_cash_position_id
    AND t.is_ending_cash = true
  ORDER BY t.transaction_date DESC
  LIMIT 1;

  v_balance := COALESCE(v_balance, 0);

  -- Apply post-anchor cash effects from the broker's same-currency positions
  SELECT v_balance + COALESCE(SUM(
    CASE
      WHEN t.transaction_type = 'CASH' AND t.position_id = p_cash_position_id
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

REVOKE ALL ON FUNCTION recompute_cash_balance(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recompute_cash_balance(UUID, BOOLEAN) TO authenticated;
