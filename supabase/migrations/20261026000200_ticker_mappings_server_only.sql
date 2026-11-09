-- SIN APLICAR (2026-10-26). Auditoría 7f2c915d, A2.
--
-- ticker_mappings es el catálogo COMPARTIDO ISIN → ticker: lo que hay aquí
-- decide qué activo (y qué precio) recibe todo el que importe ese ISIN. Las
-- políticas de 20260702 eran `insert … with check (true)` y
-- `update … using (true) with check (true)`, así que cualquier cuenta podía
-- cambiar IE00B4L5Y983 a otro ticker — incluidas las filas 'manual', que el
-- comentario daba por protegidas pero la BD no protegía.
--
-- Desde ahora solo escribe el service role: POST /api/ticker-mappings
-- (server/routes/tickerMappings.js) verifica cada par contra la búsqueda de
-- Yahoo por ESE ISIN e inserta sin sobrescribir (ignoreDuplicates). La lectura
-- para `authenticated` no cambia (ticker_mappings_select).
--
-- Se quitan las políticas Y los privilegios de tabla: sin política RLS el
-- INSERT/UPDATE ya fallan, pero sin el GRANT ni siquiera llegan a evaluarse,
-- y una política permisiva añadida por error en el futuro no reabriría nada.
-- El service role salta RLS y conserva sus propios GRANTs.
--
-- `anon` pierde también SELECT: ningún flujo anónimo, landing ni prerender lee
-- esta tabla (comprobado r15: solo src/services/tickerMappingService.js bajo
-- sesión autenticada + mock demo). authenticated conserva SELECT.
--
-- Orden de despliegue en DOS FASES (r17/r17b; ver history.md): mismo tren que
-- A1 (20261026000100) y assets ensure/revoke (20261027000100 / 20261029000300) →
-- run-snapshots → assetPricesWritten > 0. No se publica a medias.
-- RIESGO: NO `supabase db push` a ciegas (versiones 8 dígitos + 20261017_*
-- duplicados); aplicar una a una o `migration repair` antes.
--
-- Verificar tras aplicar:
--   select policyname, cmd from pg_policies where tablename = 'ticker_mappings';  -- solo ticker_mappings_select (SELECT)
--   select has_table_privilege('authenticated', 'public.ticker_mappings', 'insert'); -- false
--   select has_table_privilege('authenticated', 'public.ticker_mappings', 'update'); -- false
--   select has_table_privilege('anon', 'public.ticker_mappings', 'select'); -- false
--   select has_table_privilege('service_role',  'public.ticker_mappings', 'insert'); -- true

DROP POLICY IF EXISTS ticker_mappings_insert ON public.ticker_mappings;
DROP POLICY IF EXISTS ticker_mappings_update ON public.ticker_mappings;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.ticker_mappings FROM PUBLIC, anon, authenticated;
REVOKE SELECT ON public.ticker_mappings FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ticker_mappings TO service_role;
