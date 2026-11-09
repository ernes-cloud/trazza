-- Canonical RLS for the CORE user tables.
--
-- Until now these policies only existed in the Supabase dashboard (the base
-- schema predates the versioned migrations folder), so they were neither
-- auditable nor reproducible from the repo. Several client queries rely 100%
-- on them (e.g. CarteraPage.handleInlineUpdate updates positions filtering
-- only by asset_id — assets are SHARED across users, so without a correct
-- positions UPDATE policy that would be a cross-user write).
--
-- This migration is idempotent and AUTHORITATIVE: it drops every existing
-- policy on these tables and recreates the canonical set. The service role
-- (server/) bypasses RLS and is unaffected.
--
-- Ownership model (must match adjust_position_quantity in
-- 20260610_atomic_rpcs_assets_rls.sql):
--   brokers / portfolios / user_preferences / notifications / imported_data
--                                  → direct user_id column
--   positions                     → owning broker AND owning portfolio (each
--                                   non-null ref must belong to auth.uid())
--   transactions                  → via their position (same AND rule on p)

-- ── 0. Drop every existing policy on the affected tables ────────────────────
DO $$
DECLARE pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname, tablename FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'brokers', 'portfolios', 'positions', 'transactions',
        'user_preferences', 'notifications', 'imported_data'
      )
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, pol.tablename);
  END LOOP;
END $$;

-- ── 1. Tables with a direct user_id column ───────────────────────────────────
-- Core tables are expected to exist once the baseline schema is loaded.
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'brokers', 'portfolios', 'user_preferences', 'notifications',
    'imported_data'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated
         USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid())',
      tbl || '_own_user', tbl
    );
  END LOOP;
END $$;

-- ── 2. positions — broker AND portfolio (NULL-aware per ref) ─────────────────
ALTER TABLE public.positions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "positions_own_user"
  ON public.positions FOR ALL TO authenticated
  USING (
    (broker_id IS NULL OR EXISTS (
      SELECT 1 FROM public.brokers b
      WHERE b.id = positions.broker_id AND b.user_id = (SELECT auth.uid())
    ))
    AND (portfolio_id IS NULL OR EXISTS (
      SELECT 1 FROM public.portfolios pf
      WHERE pf.id = positions.portfolio_id AND pf.user_id = (SELECT auth.uid())
    ))
  )
  WITH CHECK (
    (broker_id IS NULL OR EXISTS (
      SELECT 1 FROM public.brokers b
      WHERE b.id = positions.broker_id AND b.user_id = (SELECT auth.uid())
    ))
    AND (portfolio_id IS NULL OR EXISTS (
      SELECT 1 FROM public.portfolios pf
      WHERE pf.id = positions.portfolio_id AND pf.user_id = (SELECT auth.uid())
    ))
  );

-- ── 3. transactions — owned via their position ───────────────────────────────
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "transactions_own_user"
  ON public.transactions FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.positions p
      WHERE p.id = transactions.position_id
        AND (p.broker_id IS NULL OR EXISTS (
          SELECT 1 FROM public.brokers b
          WHERE b.id = p.broker_id AND b.user_id = (SELECT auth.uid())
        ))
        AND (p.portfolio_id IS NULL OR EXISTS (
          SELECT 1 FROM public.portfolios pf
          WHERE pf.id = p.portfolio_id AND pf.user_id = (SELECT auth.uid())
        ))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.positions p
      WHERE p.id = transactions.position_id
        AND (p.broker_id IS NULL OR EXISTS (
          SELECT 1 FROM public.brokers b
          WHERE b.id = p.broker_id AND b.user_id = (SELECT auth.uid())
        ))
        AND (p.portfolio_id IS NULL OR EXISTS (
          SELECT 1 FROM public.portfolios pf
          WHERE pf.id = p.portfolio_id AND pf.user_id = (SELECT auth.uid())
        ))
    )
  );
