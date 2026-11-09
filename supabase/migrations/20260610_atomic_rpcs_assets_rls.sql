-- Atomic quantity adjustments + hardened assets RLS.
--
-- Problem 1: every manual CRUD handler did SELECT quantity -> compute in JS ->
-- UPDATE quantity. Two tabs, a double click or a network retry corrupt the
-- position/cash balance. Fix: adjust_position_quantity applies the delta in a
-- single UPDATE, atomically, with an explicit ownership check.
--
-- Problem 2: the assets UPDATE policy was USING (true) — any authenticated user
-- could rewrite ticker/ISIN/price of shared assets for everyone. Fix: drop the
-- permissive policy and funnel legitimate market-data writes through a
-- SECURITY DEFINER function that only touches safe fields.

-- ── 1. adjust_position_quantity ─────────────────────────────────────────────
-- Returns the new quantity. p_min_zero clamps the result at 0 (used when
-- selling/deleting BUYs so float drift never produces negative holdings).
CREATE OR REPLACE FUNCTION adjust_position_quantity(
  p_position_id UUID,
  p_delta NUMERIC,
  p_min_zero BOOLEAN DEFAULT false
) RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_new_qty NUMERIC;
BEGIN
  UPDATE positions p
  SET quantity = CASE
        WHEN p_min_zero THEN GREATEST(0, COALESCE(p.quantity, 0) + p_delta)
        ELSE COALESCE(p.quantity, 0) + p_delta
      END
  WHERE p.id = p_position_id
    AND (
      EXISTS (SELECT 1 FROM brokers b
              WHERE b.id = p.broker_id AND b.user_id = auth.uid())
      OR EXISTS (SELECT 1 FROM portfolios pf
                 WHERE pf.id = p.portfolio_id AND pf.user_id = auth.uid())
    )
  RETURNING p.quantity INTO v_new_qty;

  IF v_new_qty IS NULL THEN
    RAISE EXCEPTION 'Position % not found or not owned by current user', p_position_id;
  END IF;

  RETURN v_new_qty;
END;
$$;

REVOKE ALL ON FUNCTION adjust_position_quantity(UUID, NUMERIC, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION adjust_position_quantity(UUID, NUMERIC, BOOLEAN) TO authenticated;

-- ── 2. update_asset_market_data ─────────────────────────────────────────────
-- The only legitimate client-side writes to shared assets rows:
--   * current_price: latest market quote (must be > 0)
--   * company_name: only for CASH_* placeholder rows, or healing rows whose
--     name is still the ISIN placeholder from a nameless import
--   * isin / sector / industry / country / asset_class: backfill only when
--     currently NULL — never overwrite (matches the Dashboard enrichment flow)
DROP FUNCTION IF EXISTS public.update_asset_market_data(UUID, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION update_asset_market_data(
  p_asset_id UUID,
  p_current_price NUMERIC DEFAULT NULL,
  p_company_name TEXT DEFAULT NULL,
  p_isin TEXT DEFAULT NULL,
  p_sector TEXT DEFAULT NULL,
  p_industry TEXT DEFAULT NULL,
  p_country TEXT DEFAULT NULL,
  p_asset_class TEXT DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  UPDATE assets a SET
    current_price = CASE
        WHEN p_current_price IS NOT NULL AND p_current_price > 0 THEN p_current_price
        ELSE a.current_price
      END,
    company_name = CASE
        WHEN p_company_name IS NOT NULL
             AND (a.ticker LIKE 'CASH\_%' OR a.company_name = a.isin OR a.company_name IS NULL)
          THEN p_company_name
        ELSE a.company_name
      END,
    isin        = COALESCE(a.isin, p_isin),
    sector      = COALESCE(a.sector, p_sector),
    industry    = COALESCE(a.industry, p_industry),
    country     = COALESCE(a.country, p_country),
    asset_class = COALESCE(a.asset_class, p_asset_class)
  WHERE a.id = p_asset_id;
END;
$$;

REVOKE ALL ON FUNCTION update_asset_market_data(UUID, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION update_asset_market_data(UUID, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- ── 3. Drop the permissive assets UPDATE policy ─────────────────────────────
-- INSERT stays open (creating a new shared asset is legitimate); existing rows
-- can no longer be mutated directly by clients — only via the function above.
DROP POLICY IF EXISTS "assets_update_authenticated" ON assets;
