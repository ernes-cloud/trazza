-- SIN APLICAR (2026-10-27 / r17; renombrada r17b → 20261029000300).
-- FASE 2 — cierra INSERT directo en `assets`.
--
-- Versión: 20261029000300 (20261029000100 y 20261029000200 reservadas para
-- rebotes; no reutilizarlas). Antes: 20261027000200_assets_insert_revoke.
--
-- Prerrequisito: FASE 1 (`20261027000100_assets_insert_server_only.sql`) +
-- server/cliente con POST /api/assets → ensure_asset YA desplegados. Sin eso
-- el import/alta rompe con 42501 / "unresolved asset reference".
--
-- ESPERA OBLIGATORIA (r19): NO aplicar esta FASE 2 hasta ≥ 24 h después de
-- `c2` (cliente nuevo publicado). Las pestañas abiertas con el JS viejo siguen
-- haciendo `.from('assets').insert` directo; al cerrar la policy reciben 42501
-- y pierden el lote hasta recargar. Ver docs/claude/history.md (r18/r19) y
-- SERVIDOR.md.
--
-- Qué cambia:
--   - DROP de la política assets_insert_authenticated (SIN IF EXISTS: en prod
--     es la única de INSERT; un nombre distinto debe fallar en caliente).
--   - REVOKE INSERT/DELETE/TRUNCATE + UPDATE/REFERENCES/TRIGGER de PUBLIC,
--     anon y authenticated; REVOKE SELECT a anon (ningún flujo anónimo,
--     landing ni prerender lee `assets`; sharePortfolio usa service_role;
--     el cliente autenticado sigue con SELECT + update_asset_metadata).
--   - GRANT SELECT a authenticated; ALL de escritura a service_role.
--
-- RIESGO DE DESPLIEGUE: NO `supabase db push` a ciegas — ver cabecera de
-- 20261027000100 y docs/claude/history.md (versiones 8 dígitos + 20261017_*
-- duplicados). Aplicar una a una o `migration repair` antes.
--
-- Verificar tras FASE 2:
--   select policyname, cmd from pg_policies where tablename = 'assets';
--     -- solo assets_select_authenticated (SELECT); sin assets_insert_*
--   select has_table_privilege('authenticated', 'public.assets', 'insert'); -- false
--   select has_table_privilege('authenticated', 'public.assets', 'update'); -- false
--   select has_table_privilege('anon', 'public.assets', 'select'); -- false

DROP POLICY "assets_insert_authenticated" ON public.assets;

REVOKE INSERT, DELETE, TRUNCATE ON public.assets FROM PUBLIC, anon, authenticated;
REVOKE UPDATE, REFERENCES, TRIGGER ON public.assets FROM PUBLIC, anon, authenticated;
REVOKE SELECT ON public.assets FROM anon;
GRANT SELECT ON public.assets TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assets TO service_role;
