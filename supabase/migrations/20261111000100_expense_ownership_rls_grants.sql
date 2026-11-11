-- P0-2 Gastos: policies solo para authenticated, GRANTs explícitos y triggers de
-- pertenencia en FKs «laterales» (project_id, recurring_source_id, goal_id).
--
-- Las tablas de gastos nacieron con policy FOR ALL sin rol → caen en PUBLIC/anon
-- junto a los privilegios por defecto de Postgres. Eso no sustituye el aislamiento
-- por RLS cuando auth.uid() está presente, pero ensucia la superficie y los tests
-- de regresión exigen el mismo contrato que el resto de tablas con user_id
-- (20260716_core_tables_rls.sql): TO authenticated + GRANT explícito.
--
-- project_id / recurring_source_id / goal_id son FK reales a filas de OTRO
-- usuario si el cliente miente en el UUID. RLS no lo ve: la fila nueva es «tuya»
-- y la referenciada ni siquiera es visible. Un CHECK validando histórico podría
-- bloquear el despliegue; estos triggers solo actúan hacia delante (INSERT/UPDATE).

-- ── 1. Policies FOR ALL → solo authenticated ─────────────────────────────────
DROP POLICY IF EXISTS "users manage own expense_entries" ON public.expense_entries;
CREATE POLICY "users manage own expense_entries"
  ON public.expense_entries FOR ALL TO authenticated
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "users manage own expense_projects" ON public.expense_projects;
CREATE POLICY "users manage own expense_projects"
  ON public.expense_projects FOR ALL TO authenticated
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "users manage own savings_goals" ON public.savings_goals;
CREATE POLICY "users manage own savings_goals"
  ON public.savings_goals FOR ALL TO authenticated
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

DROP POLICY IF EXISTS user_preferences_own_user ON public.user_preferences;
CREATE POLICY user_preferences_own_user
  ON public.user_preferences FOR ALL TO authenticated
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

-- ── 2. Privilegios de tabla: ni PUBLIC ni anon ───────────────────────────────
REVOKE ALL ON public.expense_entries, public.expense_projects, public.savings_goals, public.user_preferences
  FROM PUBLIC;
REVOKE ALL ON public.expense_entries, public.expense_projects, public.savings_goals, public.user_preferences
  FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.expense_entries, public.expense_projects, public.savings_goals, public.user_preferences
  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.expense_entries, public.expense_projects, public.savings_goals, public.user_preferences
  TO service_role;

-- ── 3. expense_entries: project_id y recurring_source_id del mismo user_id ───
CREATE OR REPLACE FUNCTION public.guard_expense_entry_references()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.project_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.expense_projects p
       WHERE p.id = NEW.project_id AND p.user_id = NEW.user_id
     )
  THEN
    RAISE EXCEPTION
      'project_id no pertenece al usuario de la entrada'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.recurring_source_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.expense_entries e
       WHERE e.id = NEW.recurring_source_id AND e.user_id = NEW.user_id
     )
  THEN
    RAISE EXCEPTION
      'recurring_source_id no pertenece al usuario de la entrada'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_expense_entry_references ON public.expense_entries;
CREATE TRIGGER guard_expense_entry_references
  BEFORE INSERT OR UPDATE ON public.expense_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_expense_entry_references();

-- ── 4. expense_projects: goal_id del mismo user_id ───────────────────────────
CREATE OR REPLACE FUNCTION public.guard_expense_project_goal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.goal_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.savings_goals g
       WHERE g.id = NEW.goal_id AND g.user_id = NEW.user_id
     )
  THEN
    RAISE EXCEPTION
      'goal_id no pertenece al usuario del proyecto'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_expense_project_goal ON public.expense_projects;
CREATE TRIGGER guard_expense_project_goal
  BEFORE INSERT OR UPDATE ON public.expense_projects
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_expense_project_goal();

-- ── 5. EXECUTE en funciones trigger (Postgres revoca EXECUTE a PUBLIC por defecto
--    en funciones nuevas; sin esto el cliente no puede disparar los guards ni
--    guard_user_preferences_plan en cada guardado de Ajustes) ─────────────────
-- P0-1: aplicar GRANT/REVOKE de guard_user_preferences_plan solo si existe
DO $oss_p01_plan_guard$
BEGIN
  IF to_regprocedure('public.guard_user_preferences_plan()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.guard_user_preferences_plan() FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.guard_user_preferences_plan() TO authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.guard_user_preferences_plan() TO service_role';
  END IF;
END
$oss_p01_plan_guard$;

REVOKE ALL ON FUNCTION public.guard_expense_entry_references() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.guard_expense_entry_references() TO authenticated;
GRANT EXECUTE ON FUNCTION public.guard_expense_entry_references() TO service_role;

REVOKE ALL ON FUNCTION public.guard_expense_project_goal() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.guard_expense_project_goal() TO authenticated;
GRANT EXECUTE ON FUNCTION public.guard_expense_project_goal() TO service_role;
