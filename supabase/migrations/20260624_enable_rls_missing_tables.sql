-- Fix: Enable RLS on tables that have policies but RLS not activated.
-- Supabase linter flagged: assets, currency_rates, watchlists, watchlist_items.

-- ── assets ───────────────────────────────────────────────────────────────────
ALTER TABLE public.assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can view assets"       ON public.assets;
DROP POLICY IF EXISTS "assets_update_authenticated"  ON public.assets;
DROP POLICY IF EXISTS "assets_select_authenticated"  ON public.assets;
DROP POLICY IF EXISTS "assets_insert_authenticated"  ON public.assets;

-- All authenticated users can read shared market data
CREATE POLICY "assets_select_authenticated"
  ON public.assets FOR SELECT TO authenticated USING (true);

-- Authenticated users can insert new assets (adding a new position)
CREATE POLICY "assets_insert_authenticated"
  ON public.assets FOR INSERT TO authenticated WITH CHECK (true);

-- UPDATE is NOT allowed directly — clients must call update_asset_market_data()
-- (SECURITY DEFINER RPC defined in 20260610_atomic_rpcs_assets_rls.sql)

-- ── currency_rates ───────────────────────────────────────────────────────────
ALTER TABLE public.currency_rates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can view currency rates" ON public.currency_rates;
DROP POLICY IF EXISTS "currency_rates_select_all"      ON public.currency_rates;

-- Shared FX data: everyone reads, only service-role writes (bypasses RLS)
CREATE POLICY "currency_rates_select_all"
  ON public.currency_rates FOR SELECT TO authenticated USING (true);

-- ── watchlists ───────────────────────────────────────────────────────────────
ALTER TABLE public.watchlists ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own watchlists" ON public.watchlists;
DROP POLICY IF EXISTS "watchlists_own_user"             ON public.watchlists;

CREATE POLICY "watchlists_own_user"
  ON public.watchlists FOR ALL TO authenticated
  USING  (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ── watchlist_items ──────────────────────────────────────────────────────────
ALTER TABLE public.watchlist_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own watchlist items" ON public.watchlist_items;
DROP POLICY IF EXISTS "watchlist_items_own_user"             ON public.watchlist_items;

CREATE POLICY "watchlist_items_own_user"
  ON public.watchlist_items FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.watchlists w
      WHERE w.id = watchlist_items.watchlist_id
        AND w.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.watchlists w
      WHERE w.id = watchlist_items.watchlist_id
        AND w.user_id = auth.uid()
    )
  );
