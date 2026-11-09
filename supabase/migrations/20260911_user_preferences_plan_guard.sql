-- Cierra una ESCALADA DE PRIVILEGIOS: cualquier usuario registrado podía
-- convertirse en admin con una sola sentencia desde la consola del navegador.
--
-- La cadena era:
--   1. `plan` ('free' | 'premium' | 'admin') vive en `user_preferences`.
--   2. La policy de esa tabla (20260716_core_tables_rls.sql) es FOR ALL con
--      USING/WITH CHECK (user_id = auth.uid()). Eso acota la FILA, no la
--      COLUMNA: el dueño de la fila puede escribir CUALQUIER campo de ella.
--   3. `requireAdmin` (server/lib/requireAdmin.js) concede el panel de admin a
--      quien tenga plan = 'admin', y `withRateLimit` (server/routes/rateLimiter.js)
--      le da cuota de IA ilimitada.
--
--   await supabase.from('user_preferences')
--     .update({ plan: 'admin' }).eq('user_id', <su propio id>);
--
--   ...y con eso se abría GET /api/admin/users (auth.admin.listUsers -> el email
--   de TODOS los usuarios), GET /api/admin/logs (import_logs.csv_sample ->
--   extractos de broker de OTROS usuarios), el cambio de plan de cualquiera y
--   el bypass de la cuota de IA.
--
-- POR QUE UN TRIGGER Y NO `REVOKE UPDATE (plan)`:
--   (a) SettingsPage guarda con .upsert({ user_id, ...settings }) donde
--       `settings` salio de un select('*') -- el payload incluye SIEMPRE la
--       columna `plan`. Sin el privilegio de columna, PostgREST genera un UPDATE
--       que la toca y Postgres responde "permission denied for column plan":
--       se romperia el guardado de ajustes ENTERO, no solo la escalada.
--   (b) Un REVOKE de columna obliga a re-GRANTear cada columna NUEVA de
--       `user_preferences`, y esta tabla crece por migracion constantemente
--       (dashboard_widgets, expenses_widgets, recurring_end_alerts...). Olvidar
--       un GRANT seria un "la preferencia no guarda" silencioso -- exactamente
--       la clase de fallo invisible que el CLAUDE.md ya documenta.
--   El trigger no bloquea que la columna VIAJE en el payload, solo que ATERRICE
--   en un valor privilegiado. Reescribir el mismo plan (lo que hace Ajustes en
--   cada guardado) pasa; elevarlo, no.

-- ── 0. Preflight: la tabla y la columna tienen que existir ───────────────────
-- `user_preferences` es anterior a esta carpeta de migraciones (se creo desde la
-- UI de Supabase), asi que no se puede dar por hecho su DDL.
DO $$
BEGIN
  IF to_regclass('public.user_preferences') IS NULL THEN
    RAISE EXCEPTION 'public.user_preferences no existe: revisa el proyecto antes de aplicar esto';
  END IF;
END $$;

-- ── 1–2. Guardia + trigger (solo si la columna `plan` existe todavía) ─────
DO $$
BEGIN
  IF to_regclass('public.user_preferences') IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'user_preferences'
      AND column_name  = 'plan'
  ) THEN
    RETURN;
  END IF;

  EXECUTE $guard$
CREATE OR REPLACE FUNCTION public.guard_user_preferences_plan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.plan, 'free') <> 'free'
     AND (TG_OP = 'INSERT' OR NEW.plan IS DISTINCT FROM OLD.plan)
  THEN
    RAISE EXCEPTION
      'plan no es escribible por el rol % (usa el service role: PATCH /api/admin/users/:id/plan)',
      current_user
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$fn$;
$guard$;

  DROP TRIGGER IF EXISTS guard_plan_column ON public.user_preferences;
  CREATE TRIGGER guard_plan_column
    BEFORE INSERT OR UPDATE ON public.user_preferences
    FOR EACH ROW
    EXECUTE FUNCTION public.guard_user_preferences_plan();
END $$;

-- ── 3. Como comprobar que funciona ───────────────────────────────────────────
-- Desde el SQL editor de Supabase (que corre como `postgres`, no como
-- `authenticated`), hay que ponerse en la piel del cliente para que el trigger
-- se active. Sustituye <UUID> por un user_id real de pruebas:
--
--   -- Debe FALLAR con 42501:
--   BEGIN;
--     SET LOCAL ROLE authenticated;
--     SET LOCAL request.jwt.claims = '{"sub":"<UUID>","role":"authenticated"}';
--     UPDATE public.user_preferences SET plan = 'admin' WHERE user_id = '<UUID>';
--   ROLLBACK;
--
--   -- Debe PASAR (es lo que hace el guardado de Ajustes en cada click):
--   BEGIN;
--     SET LOCAL ROLE authenticated;
--     SET LOCAL request.jwt.claims = '{"sub":"<UUID>","role":"authenticated"}';
--     UPDATE public.user_preferences
--        SET plan = plan, preferred_currency = preferred_currency
--      WHERE user_id = '<UUID>';
--   ROLLBACK;
--
-- Y para auditar si alguien ya se auto-promociono antes de este parche:
--   SELECT u.email, p.plan
--     FROM public.user_preferences p
--     JOIN auth.users u ON u.id = p.user_id
--    WHERE p.plan IN ('admin', 'premium')
--    ORDER BY p.plan;
