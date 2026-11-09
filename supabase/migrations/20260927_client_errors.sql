-- Errores de JavaScript del navegador, agrupados por huella.
--
-- Cierra el hueco que dejaba la plataforma sin ninguna telemetría de cliente:
-- los fallos se descubrían mirando la pantalla, porque el servidor devolvía
-- 200 mientras la UI enseñaba un dato equivocado. Los monitores de uptime no
-- ven nada de eso.
--
-- Se guarda en la propia base (UE) y no en un tercero, así que la promesa de
-- "datos almacenados en Europa" de la landing y la lista de terceros de la
-- política de privacidad siguen siendo ciertas sin cambiar una línea de copy.
--
-- UNA FILA POR HUELLA, no por ocurrencia: un bug de render se dispara en bucle
-- y una tabla por evento sería ilegible en horas. `occurrences` cuenta.

CREATE TABLE IF NOT EXISTS public.client_errors (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint     TEXT        NOT NULL UNIQUE,
  kind            TEXT        NOT NULL CHECK (kind IN ('render', 'window', 'promise')),
  message         TEXT        NOT NULL,
  stack           TEXT,
  component_stack TEXT,
  -- RUTA normalizada ('/share/:token'), nunca la URL real: ese token da acceso
  -- público a la cartera de alguien y no puede acabar en una tabla de logs.
  route           TEXT,
  user_agent      TEXT,
  app_version     TEXT,
  occurrences     INTEGER     NOT NULL DEFAULT 1,
  first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Triaje manual desde el panel de admin.
  resolved_at     TIMESTAMPTZ
);

-- El listado natural es "lo que ha fallado últimamente y sigue sin resolver".
CREATE INDEX IF NOT EXISTS client_errors_last_seen_idx
  ON public.client_errors (last_seen DESC);
CREATE INDEX IF NOT EXISTS client_errors_unresolved_idx
  ON public.client_errors (last_seen DESC) WHERE resolved_at IS NULL;

-- Mismo modelo que `import_logs`: RLS activa y CERO policies, así que ni
-- `anon` ni `authenticated` pueden leerla ni escribirla. Solo service role —
-- es decir, el Express. Un error de cliente puede llevar trozos de stack de
-- otro usuario y no es dato que nadie deba poder consultar desde el navegador.
ALTER TABLE public.client_errors ENABLE ROW LEVEL SECURITY;

-- Registrar una ocurrencia. Es una función y no un upsert porque hay que
-- INCREMENTAR el contador y mover `last_seen` conservando `first_seen`: con un
-- upsert habría que leer antes, y dos usuarios fallando a la vez perderían una
-- de las dos cuentas (read-modify-write). `ON CONFLICT … DO UPDATE` lo resuelve
-- de forma atómica en una sola sentencia.
--
-- Al reaparecer un error ya marcado como resuelto, `resolved_at` vuelve a NULL:
-- una regresión tiene que salir de nuevo en la lista, no quedarse enterrada.
-- grant-exempt: service_role
CREATE OR REPLACE FUNCTION public.record_client_error(
  p_fingerprint     TEXT,
  p_kind            TEXT,
  p_message         TEXT,
  p_stack           TEXT DEFAULT NULL,
  p_component_stack TEXT DEFAULT NULL,
  p_route           TEXT DEFAULT NULL,
  p_user_agent      TEXT DEFAULT NULL,
  p_app_version     TEXT DEFAULT NULL
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  INSERT INTO public.client_errors AS ce (
    fingerprint, kind, message, stack, component_stack, route, user_agent, app_version
  )
  VALUES (
    p_fingerprint, p_kind, p_message, p_stack, p_component_stack, p_route, p_user_agent, p_app_version
  )
  ON CONFLICT (fingerprint) DO UPDATE SET
    occurrences = ce.occurrences + 1,
    last_seen   = NOW(),
    -- El último ejemplar gana: el stack más reciente es el que corresponde al
    -- despliegue actual.
    stack           = COALESCE(EXCLUDED.stack, ce.stack),
    component_stack = COALESCE(EXCLUDED.component_stack, ce.component_stack),
    route           = COALESCE(EXCLUDED.route, ce.route),
    user_agent      = COALESCE(EXCLUDED.user_agent, ce.user_agent),
    app_version     = COALESCE(EXCLUDED.app_version, ce.app_version),
    resolved_at     = NULL;
$$;

-- La llama SOLO el Express con service role. Fuera del API REST: es
-- SECURITY DEFINER y escribe sin comprobar nada, así que expuesta a `anon`
-- permitiría inundar la tabla desde fuera. Mismo criterio que la limpieza del
-- 2026-09-26 sobre `increment_ai_usage`.
REVOKE ALL ON FUNCTION public.record_client_error(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_client_error(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) TO service_role;
