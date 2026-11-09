-- Security finding I-1: positions_own_user / transactions_own_user used OR between
-- broker and portfolio ownership in WITH CHECK, so an authenticated user could
-- INSERT or UPDATE a row that referenced their broker and another user's portfolio
-- (or the symmetric case). Require every non-null ownership reference to belong
-- to auth.uid() (NULL-aware AND on both broker_id and portfolio_id).
--
-- NO-MERGE: this branch (oss-merge) never merges back to developSecond; keep the
-- hardened policies here without assuming prod dashboard drift matches develop.
--
-- Idempotent: safe to re-run after baseline + full migration chain (see supabase/README.md).

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS positions_own_user ON public.positions;

CREATE POLICY positions_own_user
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

DROP POLICY IF EXISTS transactions_own_user ON public.transactions;

CREATE POLICY transactions_own_user
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

COMMIT;
