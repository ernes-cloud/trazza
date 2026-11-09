-- Nuevo tipo de envío: el informe semanal de cartera (server/jobs/weeklyReport.js).
-- `email_sends` es además su clave de deduplicación (un informe por usuario y
-- semana), así que sin este valor en el CHECK el registro fallaría y el job
-- volvería a enviar en cada pasada horaria del lunes — el job lo evita negándose
-- a enviar si no puede leer la tabla, pero el registro tiene que poder escribirse.
ALTER TABLE public.email_sends DROP CONSTRAINT IF EXISTS email_sends_kind_check;
ALTER TABLE public.email_sends
  ADD CONSTRAINT email_sends_kind_check
  CHECK (kind IN ('notification', 'contact', 'beta_approved', 'test', 'weekly_report'));
