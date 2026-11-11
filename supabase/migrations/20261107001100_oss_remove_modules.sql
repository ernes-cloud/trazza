-- OSS D3: retira tablas y funciones de módulos excluidos (Gastos, beta, blog,
-- embudo/visitas, SnapTrade, force-asset-price). Conserva ai_usage e import_logs
-- (cuotas IA y GET /api/admin/parser-candidates).
-- Idempotente: IF EXISTS en todo.

-- ── Triggers / funciones ─────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS on_auth_user_created_beta ON auth.users;

-- grant-exempt: service_role
DROP FUNCTION IF EXISTS public.handle_new_user_beta();
DROP FUNCTION IF EXISTS public.admin_user_funnel();
DROP FUNCTION IF EXISTS public.force_asset_price(uuid, numeric, text, uuid);

-- ── Tablas (orden: hijas antes que padres cuando aplica) ───────────────────
DROP TABLE IF EXISTS public.asset_price_force_log CASCADE;
-- P0-1: Gastos reintegrado; DROP de expense_entries omitido en el export
-- P0-1: Gastos reintegrado; DROP de expense_projects omitido en el export
-- P0-1: Gastos reintegrado; DROP de savings_goals omitido en el export
DROP TABLE IF EXISTS public.beta_access CASCADE;
DROP TABLE IF EXISTS public.beta_allowlist CASCADE;
DROP TABLE IF EXISTS public.blog_posts CASCADE;
DROP TABLE IF EXISTS public.site_visits_daily CASCADE;
DROP TABLE IF EXISTS public.snaptrade_accounts CASCADE;
DROP TABLE IF EXISTS public.snaptrade_users CASCADE;
DROP TABLE IF EXISTS public.email_sends CASCADE;
