-- Nuevo tipo de envío: el correo de activación (server/jobs/activationEmail.js),
-- que va a quien se registró hace 24–72 h y aún no ha metido ninguna operación.
--
-- SIN APLICAR aún (r16/r17b): conviene en el MISMO tren que 20261026–028
-- (FASE 1). NO `supabase db push` a ciegas — versiones 8 dígitos + cuatro
-- 20261017_* duplicados; aplicar una a una o `migration repair` (history.md).
--
-- Sin este valor el envío sale igual, pero su fila en `email_sends` se rechaza
-- (el registro es fire-and-forget y solo deja un aviso en el log). La
-- deduplicación NO depende de esta tabla: va en `app_metadata` de la cuenta.
ALTER TABLE public.email_sends DROP CONSTRAINT IF EXISTS email_sends_kind_check;
ALTER TABLE public.email_sends
  ADD CONSTRAINT email_sends_kind_check
  CHECK (kind IN ('notification', 'contact', 'beta_approved', 'test', 'weekly_report', 'activation'));
