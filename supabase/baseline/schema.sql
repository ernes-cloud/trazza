-- =====================================================================
-- Trazza OSS · baseline de esquema generada desde el CATÁLOGO de producción (solo esquema, sin datos)
-- Fecha: 2026-11-07. Fuentes: pg_catalog / information_schema de producción + baseline 10ffe870 (oss-merge).
-- Sin owners, sin identificadores del proyecto, sin secretos.
--
-- CLASIFICACIÓN DE LAS 32 TABLAS DE PRODUCCIÓN
-- ENTRAN (19):
--   assets, brokers, portfolios, positions, transactions, currency_rates, ticker_mappings,
--   user_preferences, imported_data, notifications, watchlists, watchlist_items, watchlist_alerts,
--   portfolio_alerts, portfolio_metrics_cache, portfolio_snapshots, portfolio_shares, users, client_errors
-- QUEDAN FUERA (13):
--   expense_entries, expense_projects, savings_goals   (Gastos/ahorro)
--   beta_access, beta_allowlist                         (beta/allowlist)
--   blog_posts                                          (blog)
--   site_visits_daily                                   (visitas)
--   import_logs, asset_price_force_log                  (logs de admin)
--   ai_usage                                            (cuotas por plan = cobro y planes)
--   snaptrade_accounts, snaptrade_users                 (SnapTrade)
--   email_sends                                         (email)
-- DUDOSAS (justificación):
--   notifications       ENTRA: bandeja in-app de alertas de cartera; su trigger de email queda fuera.
--   portfolio_alerts    ENTRA: alertas de variación de cartera (núcleo); el envío por email es opcional.
--   portfolio_shares    ENTRA: compartir cartera es función de la app; la página pública la sirve el server (service_role).
--   portfolio_snapshots / portfolio_metrics_cache  ENTRAN: histórico y caché de métricas de cartera.
--   users               ENTRA: admin básico (perfil base_currency/target_cash).
--   client_errors       ENTRA: "health" (errores de cliente vía record_client_error, server-only).
--   ai_usage            FUERA: es contador de cuota por plan (cobro y planes).
--   import_logs         FUERA: lo leen adminStats/adminParserCandidates (logs de admin).
--   asset_price_force_log FUERA: auditoría admin; arrastra fuera force_asset_price.
--   user_preferences    ENTRA sin columna plan (OSS: QUITAR); conserva columnas email_notify_* y *_api_key (ver nota).
-- DEPENDENCIAS de lo que entra hacia lo que queda fuera:
--   FKs: ninguna (las FKs cruzadas van de fuera→dentro: asset_price_force_log→assets).
--   Trigger email_notifications (notifications → webhook de email) FUERA del baseline;
--     OSS lo instala en 20261107000400_notify_trigger_vault.sql (Vault + pg_net).
--   user_preferences.plan: columna quitada en OSS; admin básico vía ADMIN_EMAILS / server_app_config (requireAdmin).
--   force_asset_price (assets) escribe en asset_price_force_log → FUERA (ruta admin force-price no funcionará).
--   admin_user_funnel lee beta_access y plan → FUERA. handle_new_user_beta (beta) e increment_ai_usage (ai_usage) → FUERA.
--   Server: dedupe de correos (tope diario / informe semanal) en report_sends (migración 20261107000700).
--   guard_plan_column / guard_user_preferences_plan(): NO se portan (instrucción) — innecesarios sin plan.
-- NOTA: user_preferences guarda claves de API de terceros por usuario (eodhd/marketstack/yahoo/finnhub) en texto plano.
-- =====================================================================

-- OSS harness: ROLE_BOOTSTRAP_SQL puede instalar pgcrypto antes que este fichero;
-- no forzar schema `extensions` si la extensión ya existe (evita error de reubicación).
CREATE SCHEMA IF NOT EXISTS extensions;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    EXECUTE 'CREATE EXTENSION pgcrypto WITH SCHEMA extensions';
  END IF;
  -- uuid-ossp en prod; el DDL OSS usa solo gen_random_uuid() (pgcrypto / PG16).
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'uuid-ossp') THEN
    BEGIN
      EXECUTE 'CREATE EXTENSION "uuid-ossp" WITH SCHEMA extensions';
    EXCEPTION
      WHEN insufficient_privilege OR undefined_file THEN
        NULL; -- entornos mínimos sin el paquete contrib
    END;
  END IF;
END $$;
-- pg_net/vault: no en baseline; trigger de email en 20261107000400_notify_trigger_vault.sql.
-- enums: producción no tiene enums en public.

-- ===== Tablas (orden por dependencias FK) =====
-- origen: producción; columnas de baseline 10ffe870 sustituidas por las de prod (catálogo pg_attribute/pg_attrdef/pg_constraint)
CREATE TABLE public.users (
  id uuid NOT NULL,
  base_currency text DEFAULT 'USD'::text NOT NULL,
  target_cash_percentage numeric(5,2) DEFAULT 10.00,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT users_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT users_pkey PRIMARY KEY (id)
);

-- origen: producción; columnas de baseline 10ffe870 sustituidas por las de prod (catálogo pg_attribute/pg_attrdef/pg_constraint)
CREATE TABLE public.brokers (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT brokers_pkey PRIMARY KEY (id),
  CONSTRAINT brokers_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT brokers_user_id_name_key UNIQUE (user_id, name)
);

-- origen: producción; columnas de baseline 10ffe870 sustituidas por las de prod (catálogo pg_attribute/pg_attrdef/pg_constraint)
CREATE TABLE public.portfolios (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  name text DEFAULT 'Main Portfolio'::text NOT NULL,
  target_allocation jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT portfolios_pkey PRIMARY KEY (id),
  CONSTRAINT portfolios_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

-- origen: producción; columnas de baseline 10ffe870 sustituidas por las de prod (catálogo pg_attribute/pg_attrdef/pg_constraint)
CREATE TABLE public.assets (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  ticker text NOT NULL,
  company_name text NOT NULL,
  sector text,
  asset_class text,
  currency text DEFAULT 'USD'::text NOT NULL,
  current_price numeric(12,2),
  week_52_high numeric(12,2),
  week_52_low numeric(12,2),
  last_updated timestamp with time zone DEFAULT now(),
  created_at timestamp with time zone DEFAULT now(),
  isin text,
  country text,
  industry text,
  CONSTRAINT assets_pkey PRIMARY KEY (id),
  CONSTRAINT assets_ticker_key UNIQUE (ticker)
);

-- origen: producción; columnas de baseline 10ffe870 sustituidas por las de prod (catálogo pg_attribute/pg_attrdef/pg_constraint)
CREATE TABLE public.positions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  portfolio_id uuid NOT NULL,
  broker_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  quantity numeric(12,4) NOT NULL,
  entry_price numeric(12,2) NOT NULL,
  entry_date date DEFAULT CURRENT_DATE,
  target_percentage numeric(5,2),
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  custom_classification text DEFAULT 'Otros'::text,
  notes text,
  CONSTRAINT positions_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.assets(id) ON DELETE CASCADE,
  CONSTRAINT positions_broker_id_fkey FOREIGN KEY (broker_id) REFERENCES public.brokers(id) ON DELETE CASCADE,
  CONSTRAINT positions_pkey PRIMARY KEY (id),
  CONSTRAINT positions_portfolio_id_fkey FOREIGN KEY (portfolio_id) REFERENCES public.portfolios(id) ON DELETE CASCADE
);

-- origen: producción; columnas de baseline 10ffe870 sustituidas por las de prod (catálogo pg_attribute/pg_attrdef/pg_constraint)
CREATE TABLE public.transactions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  position_id uuid NOT NULL,
  transaction_type text NOT NULL,
  quantity numeric(12,4) NOT NULL,
  price numeric(12,2) NOT NULL,
  total_amount numeric(12,2) NOT NULL,
  transaction_date timestamp with time zone DEFAULT now(),
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  eur_total numeric,
  transaction_currency text,
  fx_rate numeric,
  commission numeric,
  is_ending_cash boolean DEFAULT false,
  CONSTRAINT transactions_pkey PRIMARY KEY (id),
  CONSTRAINT transactions_position_id_fkey FOREIGN KEY (position_id) REFERENCES public.positions(id) ON DELETE CASCADE,
  CONSTRAINT transactions_transaction_type_check CHECK ((transaction_type = ANY (ARRAY['BUY'::text, 'SELL'::text, 'DIVIDEND'::text, 'FEE'::text, 'FEES'::text, 'TAX'::text, 'CASH'::text, 'TRANSFER'::text])))
);

-- origen: producción; columnas de baseline 10ffe870 sustituidas por las de prod (catálogo pg_attribute/pg_attrdef/pg_constraint)
CREATE TABLE public.currency_rates (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  from_currency text NOT NULL,
  to_currency text NOT NULL,
  rate numeric(12,6) NOT NULL,
  last_updated timestamp with time zone DEFAULT now(),
  CONSTRAINT currency_rates_from_currency_to_currency_key UNIQUE (from_currency, to_currency),
  CONSTRAINT currency_rates_pkey PRIMARY KEY (id)
);

-- origen: producción; columnas de baseline 10ffe870 sustituidas por las de prod (catálogo pg_attribute/pg_attrdef/pg_constraint)
CREATE TABLE public.ticker_mappings (
  isin text NOT NULL,
  ticker text NOT NULL,
  source text DEFAULT 'auto'::text NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT ticker_mappings_isin_check CHECK ((isin ~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$'::text)),
  CONSTRAINT ticker_mappings_pkey PRIMARY KEY (isin),
  CONSTRAINT ticker_mappings_source_check CHECK ((source = ANY (ARRAY['auto'::text, 'manual'::text]))),
  CONSTRAINT ticker_mappings_ticker_check CHECK (((char_length(ticker) >= 1) AND (char_length(ticker) <= 20)))
);

-- origen: producción; columnas de baseline 10ffe870 sustituidas por las de prod (catálogo pg_attribute/pg_attrdef/pg_constraint)
CREATE TABLE public.user_preferences (
  user_id uuid NOT NULL,
  dark_mode boolean DEFAULT false,
  updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()),
  preferred_currency text DEFAULT 'USD'::text,
  marketstack_api_key text,
  yahoo_finance_api_key text,
  yahoo_finance_api_host text,
  eodhd_api_key text,
  language text DEFAULT 'es'::text,
  -- OSS: QUITAR (corrección: plan es de cobro/planes; sin guard_plan_column no se porta)
  -- plan text DEFAULT 'free'::text NOT NULL
  email_notifications_enabled boolean DEFAULT true,
  email_notify_dividends boolean DEFAULT true,
  email_notify_earnings boolean DEFAULT true,
  email_notify_alerts boolean DEFAULT true,
  email_notify_weekly_report boolean DEFAULT true,
  finnhub_api_key text DEFAULT ''::text,
  expenses_enabled boolean DEFAULT false NOT NULL,
  savings_goal_annual numeric,
  savings_initial_balance numeric,
  expense_budgets jsonb,
  custom_categories jsonb,
  dashboard_widgets jsonb,
  expenses_widgets jsonb,
  recurring_end_alerts jsonb,
  privacy_mode boolean DEFAULT false,
  onboarding_completed boolean DEFAULT false,
  CONSTRAINT user_preferences_pkey PRIMARY KEY (user_id),
  -- OSS: QUITAR (depende de plan)
  -- CONSTRAINT user_preferences_plan_check CHECK ((plan = ANY (ARRAY['free'::text, 'premium'::text, 'admin'::text])))
  CONSTRAINT user_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

-- origen: producción; columnas de baseline 10ffe870 sustituidas por las de prod (catálogo pg_attribute/pg_attrdef/pg_constraint)
CREATE TABLE public.imported_data (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid,
  broker_id uuid,
  transactions jsonb DEFAULT '[]'::jsonb NOT NULL,
  prices jsonb DEFAULT '{}'::jsonb NOT NULL,
  ticker_map jsonb DEFAULT '{}'::jsonb NOT NULL,
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT imported_data_broker_id_fkey FOREIGN KEY (broker_id) REFERENCES public.brokers(id) ON DELETE CASCADE,
  CONSTRAINT imported_data_pkey PRIMARY KEY (id),
  CONSTRAINT imported_data_user_id_broker_id_key UNIQUE (user_id, broker_id),
  CONSTRAINT imported_data_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

-- origen: producción; columnas de baseline 10ffe870 sustituidas por las de prod (catálogo pg_attribute/pg_attrdef/pg_constraint)
CREATE TABLE public.notifications (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  is_read boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  link text,
  type text,
  send_email boolean DEFAULT true NOT NULL,
  CONSTRAINT notifications_pkey PRIMARY KEY (id),
  CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);

-- origen: producción; columnas de baseline 10ffe870 sustituidas por las de prod (catálogo pg_attribute/pg_attrdef/pg_constraint)
CREATE TABLE public.watchlists (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL,
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  CONSTRAINT watchlists_pkey PRIMARY KEY (id),
  CONSTRAINT watchlists_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);

-- origen: producción; columnas de baseline 10ffe870 sustituidas por las de prod (catálogo pg_attribute/pg_attrdef/pg_constraint)
CREATE TABLE public.watchlist_items (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  watchlist_id uuid NOT NULL,
  ticker text NOT NULL,
  alert_threshold numeric,
  last_alert_sent timestamp with time zone,
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  CONSTRAINT watchlist_items_pkey PRIMARY KEY (id),
  CONSTRAINT watchlist_items_watchlist_id_fkey FOREIGN KEY (watchlist_id) REFERENCES public.watchlists(id) ON DELETE CASCADE
);

-- origen: producción; columnas de baseline 10ffe870 sustituidas por las de prod (catálogo pg_attribute/pg_attrdef/pg_constraint)
CREATE TABLE public.watchlist_alerts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  watchlist_item_id uuid,
  alert_type text NOT NULL,
  target_value numeric NOT NULL,
  initial_price numeric,
  status text DEFAULT 'PENDING'::text,
  created_at timestamp with time zone DEFAULT now(),
  triggered_at timestamp with time zone,
  email_notify boolean DEFAULT false,
  CONSTRAINT watchlist_alerts_pkey PRIMARY KEY (id),
  CONSTRAINT watchlist_alerts_watchlist_item_id_fkey FOREIGN KEY (watchlist_item_id) REFERENCES public.watchlist_items(id) ON DELETE CASCADE
);

-- origen: producción; columnas de baseline 10ffe870 sustituidas por las de prod (catálogo pg_attribute/pg_attrdef/pg_constraint)
CREATE TABLE public.portfolio_alerts (
  user_id uuid NOT NULL,
  enabled boolean DEFAULT true NOT NULL,
  threshold_pct numeric DEFAULT 5 NOT NULL,
  direction text DEFAULT 'both'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  scope text DEFAULT 'general'::text NOT NULL,
  CONSTRAINT portfolio_alerts_direction_check CHECK ((direction = ANY (ARRAY['up'::text, 'down'::text, 'both'::text]))),
  CONSTRAINT portfolio_alerts_pkey PRIMARY KEY (user_id, scope),
  CONSTRAINT portfolio_alerts_threshold_pct_check CHECK (((threshold_pct > (0)::numeric) AND (threshold_pct <= (100)::numeric))),
  CONSTRAINT portfolio_alerts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

-- origen: producción; columnas de baseline 10ffe870 sustituidas por las de prod (catálogo pg_attribute/pg_attrdef/pg_constraint)
CREATE TABLE public.portfolio_metrics_cache (
  user_id uuid NOT NULL,
  scope text DEFAULT 'general'::text NOT NULL,
  currency text NOT NULL,
  metrics jsonb NOT NULL,
  computed_at timestamp with time zone DEFAULT now(),
  CONSTRAINT portfolio_metrics_cache_pkey PRIMARY KEY (user_id, scope),
  CONSTRAINT portfolio_metrics_cache_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

-- origen: producción; columnas de baseline 10ffe870 sustituidas por las de prod (catálogo pg_attribute/pg_attrdef/pg_constraint)
CREATE TABLE public.portfolio_snapshots (
  user_id uuid NOT NULL,
  scope text DEFAULT 'general'::text NOT NULL,
  snapshot_date date NOT NULL,
  total_value_eur numeric NOT NULL,
  positions_value_eur numeric DEFAULT 0 NOT NULL,
  cash_eur numeric DEFAULT 0 NOT NULL,
  invested_eur numeric,
  breakdown jsonb,
  quote_misses integer DEFAULT 0 NOT NULL,
  computed_at timestamp with time zone DEFAULT now(),
  CONSTRAINT portfolio_snapshots_pkey PRIMARY KEY (user_id, scope, snapshot_date),
  CONSTRAINT portfolio_snapshots_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

-- origen: producción; columnas de baseline 10ffe870 sustituidas por las de prod (catálogo pg_attribute/pg_attrdef/pg_constraint)
CREATE TABLE public.portfolio_shares (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  label text,
  mode text DEFAULT 'live'::text NOT NULL,
  snapshot_data jsonb,
  broker_ids uuid[],
  config jsonb DEFAULT '{"show_pnl": true, "show_chart": true, "show_values": true, "show_cost_basis": false, "show_broker_names": false}'::jsonb NOT NULL,
  expires_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  cached_metrics jsonb,
  performance_data jsonb,
  CONSTRAINT portfolio_shares_pkey PRIMARY KEY (id),
  CONSTRAINT portfolio_shares_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT valid_share_mode CHECK ((mode = ANY (ARRAY['live'::text, 'snapshot'::text])))
);

-- origen: producción; columnas de baseline 10ffe870 sustituidas por las de prod (catálogo pg_attribute/pg_attrdef/pg_constraint)
CREATE TABLE public.client_errors (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  fingerprint text NOT NULL,
  kind text NOT NULL,
  message text NOT NULL,
  stack text,
  component_stack text,
  route text,
  user_agent text,
  app_version text,
  occurrences integer DEFAULT 1 NOT NULL,
  first_seen timestamp with time zone DEFAULT now() NOT NULL,
  last_seen timestamp with time zone DEFAULT now() NOT NULL,
  resolved_at timestamp with time zone,
  CONSTRAINT client_errors_fingerprint_key UNIQUE (fingerprint),
  CONSTRAINT client_errors_kind_check CHECK ((kind = ANY (ARRAY['render'::text, 'window'::text, 'promise'::text]))),
  CONSTRAINT client_errors_pkey PRIMARY KEY (id)
);

-- ===== Índices (origen: producción pg_indexes; se omiten los que respaldan PK/UNIQUE) =====
CREATE INDEX idx_brokers_user ON public.brokers USING btree (user_id);
CREATE INDEX idx_portfolios_user ON public.portfolios USING btree (user_id);
CREATE UNIQUE INDEX assets_ticker_norm_key ON public.assets USING btree (lower(btrim(ticker))); -- corrección/producción: unicidad normalizada de ticker
CREATE INDEX idx_positions_asset ON public.positions USING btree (asset_id);
CREATE INDEX idx_positions_broker ON public.positions USING btree (broker_id);
CREATE INDEX idx_positions_portfolio ON public.positions USING btree (portfolio_id);
CREATE INDEX idx_transactions_position ON public.transactions USING btree (position_id);
CREATE INDEX idx_imported_data_broker_id ON public.imported_data USING btree (broker_id);
CREATE INDEX idx_notifications_user_id ON public.notifications USING btree (user_id);
CREATE INDEX idx_watchlists_user_id ON public.watchlists USING btree (user_id);
CREATE INDEX idx_watchlist_items_watchlist_id ON public.watchlist_items USING btree (watchlist_id);
CREATE INDEX idx_watchlist_alerts_watchlist_item_id ON public.watchlist_alerts USING btree (watchlist_item_id);
CREATE INDEX idx_portfolio_snapshots_user_date ON public.portfolio_snapshots USING btree (user_id, scope, snapshot_date);
CREATE INDEX portfolio_shares_user_id_idx ON public.portfolio_shares USING btree (user_id);
CREATE INDEX client_errors_last_seen_idx ON public.client_errors USING btree (last_seen DESC);
CREATE INDEX client_errors_unresolved_idx ON public.client_errors USING btree (last_seen DESC) WHERE (resolved_at IS NULL);

-- ===== RLS (origen: producción; relforcerowsecurity=false en todas) =====
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brokers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portfolios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.currency_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticker_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.imported_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.watchlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.watchlist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.watchlist_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portfolio_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portfolio_metrics_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portfolio_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portfolio_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_errors ENABLE ROW LEVEL SECURITY;

-- ===== Políticas (origen: producción pg_policies) =====
CREATE POLICY "Users can update own data" ON public.users AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = id));
CREATE POLICY "Users can view own data" ON public.users AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = id));
CREATE POLICY "brokers_own_user" ON public.brokers AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "portfolios_own_user" ON public.portfolios AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "assets_select_authenticated" ON public.assets AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);
CREATE POLICY "positions_own_user" ON public.positions AS PERMISSIVE FOR ALL TO authenticated
  USING (((EXISTS ( SELECT 1
   FROM brokers b
  WHERE ((b.id = positions.broker_id) AND (b.user_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM portfolios pf
  WHERE ((pf.id = positions.portfolio_id) AND (pf.user_id = auth.uid()))))))
  WITH CHECK (((EXISTS ( SELECT 1
   FROM brokers b
  WHERE ((b.id = positions.broker_id) AND (b.user_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM portfolios pf
  WHERE ((pf.id = positions.portfolio_id) AND (pf.user_id = auth.uid()))))));
CREATE POLICY "transactions_own_user" ON public.transactions AS PERMISSIVE FOR ALL TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM positions p
  WHERE ((p.id = transactions.position_id) AND ((EXISTS ( SELECT 1
           FROM brokers b
          WHERE ((b.id = p.broker_id) AND (b.user_id = auth.uid())))) OR (EXISTS ( SELECT 1
           FROM portfolios pf
          WHERE ((pf.id = p.portfolio_id) AND (pf.user_id = auth.uid())))))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM positions p
  WHERE ((p.id = transactions.position_id) AND ((EXISTS ( SELECT 1
           FROM brokers b
          WHERE ((b.id = p.broker_id) AND (b.user_id = auth.uid())))) OR (EXISTS ( SELECT 1
           FROM portfolios pf
          WHERE ((pf.id = p.portfolio_id) AND (pf.user_id = auth.uid())))))))));
CREATE POLICY "currency_rates_select_all" ON public.currency_rates AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);
CREATE POLICY "ticker_mappings_select" ON public.ticker_mappings AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);
CREATE POLICY "user_preferences_own_user" ON public.user_preferences AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "imported_data_own_user" ON public.imported_data AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "notifications_own_user" ON public.notifications AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "watchlists_own_user" ON public.watchlists AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "watchlist_items_own_user" ON public.watchlist_items AS PERMISSIVE FOR ALL TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM watchlists w
  WHERE ((w.id = watchlist_items.watchlist_id) AND (w.user_id = auth.uid())))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM watchlists w
  WHERE ((w.id = watchlist_items.watchlist_id) AND (w.user_id = auth.uid())))));
CREATE POLICY "Users can manage own alerts" ON public.watchlist_alerts AS PERMISSIVE FOR ALL TO public
  USING ((EXISTS ( SELECT 1
   FROM (watchlist_items wi
     JOIN watchlists w ON ((w.id = wi.watchlist_id)))
  WHERE ((wi.id = watchlist_alerts.watchlist_item_id) AND (w.user_id = auth.uid())))));
CREATE POLICY "users manage own portfolio_alerts" ON public.portfolio_alerts AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "pmc_own_user" ON public.portfolio_metrics_cache AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "psnap_own_user_select" ON public.portfolio_snapshots AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));
CREATE POLICY "share_owner_all" ON public.portfolio_shares AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

-- ===== Funciones =====
-- C1: cada CREATE lleva GRANT EXECUTE explícito a authenticated o la línea
-- `-- grant-exempt: service_role` justo encima (ver tools/oss/migrationGrants.js).
-- origen: producción; corrección: search_path='' (cuerpo ya cualificado con public.* y auth.uid()); EXECUTE solo service_role.
-- grant-exempt: service_role
CREATE OR REPLACE FUNCTION public.ensure_asset(p_ticker text, p_company_name text DEFAULT NULL::text, p_asset_class text DEFAULT NULL::text, p_currency text DEFAULT NULL::text, p_isin text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = ''
AS $function$
DECLARE
  t text;
  v_name text;
  v_currency text;
  v_isin text;
  v_price numeric;
  v_class text;
  aid uuid;
BEGIN
  -- Sin upper(): preservar casing real (prod tiene tickers en minúsculas).
  t := btrim(coalesce(p_ticker, ''));
  IF t = '' THEN
    RAISE EXCEPTION 'ticker required';
  END IF;

  -- Existente: devolver id sin validar ni tocar (placeholders con espacios,
  -- paréntesis, barra, corchetes, ampersand, o casing mixto). Exacto gana;
  -- si no, lower(btrim) case-insensitive (ticker guardado con espacios / otro case).
  SELECT a.id INTO aid FROM public.assets a WHERE a.ticker = t OR lower(btrim(a.ticker)) = lower(t) ORDER BY (a.ticker = t) DESC LIMIT 1;
  IF FOUND THEN
    RETURN aid;
  END IF;

  -- Solo altas nuevas: misma regla que createAssets.sanitizeTicker.
  IF char_length(t) > 120 OR t ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid ticker';
  END IF;

  v_isin := nullif(upper(btrim(coalesce(p_isin, ''))), '');
  IF v_isin IS NOT NULL
     AND v_isin !~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$'
     AND v_isin !~ '^CASH_[A-Z0-9]{3,5}$' THEN
    RAISE EXCEPTION 'invalid isin';
  END IF;

  v_name := coalesce(nullif(btrim(p_company_name), ''), t);
  v_currency := coalesce(nullif(upper(btrim(p_currency)), ''), 'USD');
  IF v_currency !~ '^[A-Z]{3,5}$' THEN
    RAISE EXCEPTION 'invalid currency';
  END IF;

  v_class := nullif(btrim(coalesce(p_asset_class, '')), '');
  -- Liquidez: precio unitario 1 por definición (CHF/EUR/USDT…).
  -- LIKE: escapar `_` → 'CASH\_%' (sin eso CASHX… también matchearía).
  IF t LIKE 'CASH\_%' OR upper(coalesce(v_class, '')) = 'CASH' THEN
    v_price := 1;
    IF v_class IS NULL OR upper(v_class) <> 'CASH' THEN
      v_class := 'Cash';
    END IF;
  ELSE
    v_price := NULL;
  END IF;

  INSERT INTO public.assets (ticker, company_name, asset_class, currency, isin, current_price)
  VALUES (t, v_name, v_class, v_currency, v_isin, v_price)
  -- Sin árbitro: también absorbe la carrera contra assets_ticker_norm_key
  -- ('btc-usd' y 'BTC-USD' a la vez); el SELECT de abajo devuelve la fila ganadora.
  ON CONFLICT DO NOTHING;

  SELECT a.id INTO aid FROM public.assets a WHERE a.ticker = t OR lower(btrim(a.ticker)) = lower(t) ORDER BY (a.ticker = t) DESC LIMIT 1;
  RETURN aid;
END;
$function$;
REVOKE ALL ON FUNCTION public.ensure_asset(text,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_asset(text,text,text,text,text) TO service_role;

-- origen: producción (ya search_path=''); corrección: REVOKE explícito; producción da EXECUTE a authenticated → se mantiene.
CREATE OR REPLACE FUNCTION public.update_asset_metadata(p_asset_id uuid, p_company_name text DEFAULT NULL::text, p_isin text DEFAULT NULL::text, p_sector text DEFAULT NULL::text, p_industry text DEFAULT NULL::text, p_country text DEFAULT NULL::text, p_asset_class text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  UPDATE public.assets a SET
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
  WHERE a.id = p_asset_id
    AND EXISTS (
      SELECT 1 FROM public.positions p
      WHERE p.asset_id = a.id
        AND (
          EXISTS (SELECT 1 FROM public.brokers b WHERE b.id = p.broker_id AND b.user_id = auth.uid())
          OR EXISTS (SELECT 1 FROM public.portfolios pf WHERE pf.id = p.portfolio_id AND pf.user_id = auth.uid())
        )
    );

  RETURN FOUND;
END;
$function$;
REVOKE ALL ON FUNCTION public.update_asset_metadata(uuid,text,text,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_asset_metadata(uuid,text,text,text,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_asset_metadata(uuid,text,text,text,text,text,text) TO service_role;

-- origen: producción; corrección: search_path pasaba de 'public, pg_temp' a '' (el cuerpo ya usa public.client_errors; NOW() es pg_catalog).
-- grant-exempt: service_role
CREATE OR REPLACE FUNCTION public.record_client_error(p_fingerprint text, p_kind text, p_message text, p_stack text DEFAULT NULL::text, p_component_stack text DEFAULT NULL::text, p_route text DEFAULT NULL::text, p_user_agent text DEFAULT NULL::text, p_app_version text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path = ''
AS $function$
  INSERT INTO public.client_errors AS ce (
    fingerprint, kind, message, stack, component_stack, route, user_agent, app_version
  )
  VALUES (
    p_fingerprint, p_kind, p_message, p_stack, p_component_stack, p_route, p_user_agent, p_app_version
  )
  ON CONFLICT (fingerprint) DO UPDATE SET
    occurrences = ce.occurrences + 1,
    last_seen   = NOW(),
    stack           = COALESCE(EXCLUDED.stack, ce.stack),
    component_stack = COALESCE(EXCLUDED.component_stack, ce.component_stack),
    route           = COALESCE(EXCLUDED.route, ce.route),
    user_agent      = COALESCE(EXCLUDED.user_agent, ce.user_agent),
    app_version     = COALESCE(EXCLUDED.app_version, ce.app_version),
    resolved_at     = NULL;
$function$;
REVOKE ALL ON FUNCTION public.record_client_error(text,text,text,text,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_client_error(text,text,text,text,text,text,text,text) TO service_role;

-- origen: producción (INVOKER, search_path=''; EXECUTE solo service_role en prod).
-- grant-exempt: service_role
CREATE OR REPLACE FUNCTION public.update_asset_market_data(p_asset_id uuid, p_current_price numeric DEFAULT NULL::numeric, p_company_name text DEFAULT NULL::text, p_isin text DEFAULT NULL::text, p_sector text DEFAULT NULL::text, p_industry text DEFAULT NULL::text, p_country text DEFAULT NULL::text, p_asset_class text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_stored NUMERIC;
  v_apply_price BOOLEAN := false;
BEGIN
  SELECT a.current_price INTO v_stored FROM public.assets a WHERE a.id = p_asset_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF p_current_price IS NOT NULL
     AND p_current_price <> 'NaN'::numeric
     AND p_current_price > 0
     AND p_current_price < 1e9
     AND (v_stored IS NULL OR v_stored <= 0 OR v_stored = 'NaN'::numeric
          OR p_current_price >= v_stored * 0.15)
  THEN
    v_apply_price := true;
  END IF;

  UPDATE public.assets a SET
    current_price = CASE WHEN v_apply_price THEN p_current_price ELSE a.current_price END,
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

  RETURN v_apply_price;
END;
$function$;
REVOKE ALL ON FUNCTION public.update_asset_market_data(uuid,numeric,text,text,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_asset_market_data(uuid,numeric,text,text,text,text,text,text) TO service_role;

-- origen: producción (INVOKER, RLS aplica; search_path=public se conserva); corrección: sin EXECUTE a anon/PUBLIC.
CREATE OR REPLACE FUNCTION public.adjust_position_quantity(p_position_id uuid, p_delta numeric, p_min_zero boolean DEFAULT false)
 RETURNS numeric
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
$function$;
REVOKE ALL ON FUNCTION public.adjust_position_quantity(uuid,numeric,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.adjust_position_quantity(uuid,numeric,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.adjust_position_quantity(uuid,numeric,boolean) TO service_role;

-- origen: producción (INVOKER); corrección: sin EXECUTE a anon/PUBLIC.
-- grant-exempt: service_role
CREATE OR REPLACE FUNCTION public.recompute_cash_balance(p_cash_position_id uuid, p_apply boolean DEFAULT false)
 RETURNS numeric
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
$function$;
REVOKE ALL ON FUNCTION public.recompute_cash_balance(uuid,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_cash_balance(uuid,boolean) TO service_role;

-- Triggers: ninguno se porta (email_notifications FUERA por email; guard_plan_column excluido por instrucción).

-- ===== Grants (corrección: más estrictos que producción y que baseline 10ffe870) =====
-- Sin TRUNCATE/REFERENCES/TRIGGER/MAINTAIN para anon ni authenticated. anon sin acceso a ninguna tabla incluida.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated, PUBLIC;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- authenticated: CRUD solo donde el cliente lo usa (git grep de src/ en 9e3c4e6d) y RLS lo limita al dueño.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.brokers, public.portfolios, public.positions, public.transactions, public.user_preferences,
  public.imported_data, public.notifications, public.watchlists, public.watchlist_items, public.watchlist_alerts,
  public.portfolio_alerts, public.portfolio_metrics_cache, public.portfolio_shares
  TO authenticated;
GRANT SELECT ON public.assets, public.ticker_mappings, public.currency_rates, public.portfolio_snapshots TO authenticated;
GRANT SELECT, UPDATE ON public.users TO authenticated;  -- políticas de prod: ver/editar propio
-- client_errors: server-only (sin grants a authenticated).
-- service_role: como producción (todos los privilegios).
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
-- Tablas creadas en migraciones posteriores: GRANT explícito en cada migración (sin ALTER DEFAULT PRIVILEGES).
