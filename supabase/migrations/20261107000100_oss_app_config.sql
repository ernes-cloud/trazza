-- Server-only key/value config for OSS bootstrap state.
-- Used by requireAdmin fallback resolution when ADMIN_EMAILS is unset.

CREATE TABLE IF NOT EXISTS public.server_app_config (
  id text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.server_app_config ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.server_app_config FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.server_app_config TO service_role;

CREATE OR REPLACE FUNCTION public.set_server_app_config(
  p_id text,
  p_value jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_id IS NULL OR btrim(p_id) = '' THEN
    RAISE EXCEPTION 'id required';
  END IF;
  INSERT INTO public.server_app_config (id, value, created_at, updated_at)
  VALUES (p_id, coalesce(p_value, '{}'::jsonb), now(), now())
  ON CONFLICT (id)
  DO UPDATE SET value = EXCLUDED.value, updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.set_server_app_config(text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_server_app_config(text, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_server_app_config(text, jsonb) TO service_role;
