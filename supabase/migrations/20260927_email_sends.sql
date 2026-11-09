-- Registro de CADA correo que la plataforma intenta enviar.
--
-- Por qué hacía falta: el único rastro de un envío era `addLog`, que escribe
-- en un anillo de 500 entradas EN MEMORIA (`server/lib/logBuffer.js`). Se
-- pierde al reiniciar el server y no cabe ni un mes de historial. Y peor: el
-- webhook de notificaciones devolvía 200 incluso cuando el envío fallaba
-- ("para que Supabase no reintente"), así que un aviso perdido no dejaba
-- ninguna huella en ningún sitio. Con 3 correos al día, un fallo silencioso
-- puede durar semanas sin que nadie lo note.
--
-- UNA FILA POR INTENTO COMPLETO (no por reintento): `attempts` cuenta los
-- intentos internos. Al volumen actual son ~1.100 filas al año.

CREATE TABLE IF NOT EXISTS public.email_sends (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Qué disparó el correo. Sirve para responder "¿se están entregando las
  -- notificaciones?" sin que el formulario de contacto contamine la métrica.
  kind        TEXT        NOT NULL CHECK (kind IN ('notification', 'contact', 'beta_approved', 'test')),
  recipient   TEXT        NOT NULL,
  -- Solo cuando el correo va a un usuario conocido; el de contacto no lo tiene.
  user_id     UUID,
  subject     TEXT,
  -- 'resend' o 'smtp' (Postfix local). Queda registrado para poder comparar
  -- la tasa de fallo antes y después de la migración de proveedor.
  provider    TEXT        NOT NULL,
  status      TEXT        NOT NULL CHECK (status IN ('sent', 'failed')),
  attempts    INTEGER     NOT NULL DEFAULT 1,
  -- Resumen del último error (código + responseCode + mensaje), NULL si fue bien.
  error       TEXT,
  -- Id del proveedor: es lo que permite buscar el correo en el panel de Resend
  -- cuando alguien dice "no me ha llegado".
  message_id  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- El listado natural es cronológico inverso.
CREATE INDEX IF NOT EXISTS email_sends_created_at_idx
  ON public.email_sends (created_at DESC);
-- La consulta que de verdad importa: qué ha fallado. Parcial porque los
-- fallos son una minoría diminuta del total.
CREATE INDEX IF NOT EXISTS email_sends_failed_idx
  ON public.email_sends (created_at DESC) WHERE status = 'failed';

-- Mismo modelo que `import_logs` y `client_errors`: RLS activa y CERO
-- policies, así que ni `anon` ni `authenticated` la tocan. Solo service role,
-- o sea el Express. La tabla contiene direcciones de correo de usuarios: no
-- es dato que deba poder consultarse desde un navegador.
ALTER TABLE public.email_sends ENABLE ROW LEVEL SECURITY;
