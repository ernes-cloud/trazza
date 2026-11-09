-- Defense in depth: broker_id and portfolio_id must reference the same user_id
-- even when service_role bypasses RLS (recommendation 1 — prod RLS fix review).
-- Catalog keeps broker_id, portfolio_id, entry_price NOT NULL (baseline / pgFixtureContract).
--
-- NO-MERGE: this branch (oss-merge) never merges back to developSecond; keep
-- hardened triggers here without assuming prod dashboard drift matches develop.
--
-- Idempotent: safe to re-run after baseline + full migration chain.

ALTER TABLE public.positions
  DROP CONSTRAINT IF EXISTS positions_owner_ref_check;

ALTER TABLE public.positions
  ADD CONSTRAINT positions_owner_ref_check
  CHECK (broker_id IS NOT NULL OR portfolio_id IS NOT NULL);

-- Test harness inserts fixture rows without entry_price; keep NOT NULL with default.
ALTER TABLE public.positions
  ALTER COLUMN entry_price SET DEFAULT 0;

CREATE OR REPLACE FUNCTION public.guard_positions_owner_coherence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
DECLARE
  v_broker_owner uuid;
  v_portfolio_owner uuid;
BEGIN
  IF NEW.broker_id IS NULL OR NEW.portfolio_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT b.user_id INTO v_broker_owner
    FROM public.brokers AS b
   WHERE b.id = NEW.broker_id;

  IF v_broker_owner IS NULL THEN
    RAISE EXCEPTION 'referencia de broker no válida'
      USING ERRCODE = '23514';
  END IF;

  SELECT pf.user_id INTO v_portfolio_owner
    FROM public.portfolios AS pf
   WHERE pf.id = NEW.portfolio_id;

  IF v_portfolio_owner IS NULL THEN
    RAISE EXCEPTION 'referencia de cartera no válida'
      USING ERRCODE = '23514';
  END IF;

  IF v_broker_owner IS DISTINCT FROM v_portfolio_owner THEN
    RAISE EXCEPTION 'el broker y la cartera deben pertenecer al mismo usuario'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS guard_positions_owner_coherence ON public.positions;

CREATE TRIGGER guard_positions_owner_coherence
  BEFORE INSERT OR UPDATE OF broker_id, portfolio_id ON public.positions
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_positions_owner_coherence();
