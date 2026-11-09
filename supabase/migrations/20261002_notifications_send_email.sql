-- El interruptor de email de cada alerta de Favoritos (`watchlist_alerts.email_notify`)
-- no lo leía nadie: el webhook de `notifications` → emailNotify mandaba correo de
-- TODA fila insertada. Esta columna deja que quien inserta diga "solo en la app".
--
-- NOT NULL DEFAULT true: las filas existentes y cualquier insert que no la
-- mencione siguen mandando correo como hasta ahora. emailNotify solo corta con
-- un `false` explícito.
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS send_email boolean NOT NULL DEFAULT true;
