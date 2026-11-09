-- SIN APLICAR (2026-10-28, r15b).
--
-- `email_sends` tiene RLS ON y CERO policies (correcto: solo service_role),
-- pero anon/authenticated conservaban ALL (incluye TRUNCATE, que no pasa por
-- RLS). El cliente (`src/`) NO lee ni escribe esta tabla (verificado 2026-10-27:
-- `rg email_sends src/` → 0 coincidencias); el server escribe con service_role
-- vía `sendEmail` / jobs. Este REVOKE cierra el hueco de grants residuales.
--
-- Verificar tras aplicar:
--   select has_table_privilege('anon', 'public.email_sends', 'select');         -- false
--   select has_table_privilege('authenticated', 'public.email_sends', 'insert'); -- false
--   select has_table_privilege('service_role', 'public.email_sends', 'insert');   -- true

REVOKE ALL ON public.email_sends FROM anon, authenticated;
GRANT ALL ON public.email_sends TO service_role;
