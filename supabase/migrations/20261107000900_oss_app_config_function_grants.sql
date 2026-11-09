-- C1: published 20261107000100 omits grant-exempt marker; re-apply grants idempotently.

-- grant-exempt: service_role
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

REVOKE ALL ON FUNCTION public.set_server_app_config(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_server_app_config(text, jsonb) TO service_role;
