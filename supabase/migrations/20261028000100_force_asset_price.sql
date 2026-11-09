-- SIN APLICAR (2026-10-28, r15b / r16). Escape atómico del guard del 15 %.
--
-- Antes (r14/r15): POST /api/admin/force-asset-price hacía UPDATE current_price
-- = NULL y luego llamaba a update_asset_market_data. Dos round-trips: si el
-- segundo fallaba, el activo quedaba sin precio. Además la "auditoría" era solo
-- addLog (anillo en memoria).
--
-- Ahora: UNA RPC service_role escribe el precio nuevo (salta el ratio 15 %)
-- e inserta la fila de auditoría en la misma transacción. reason obligatorio.
--
-- FK asset_id → assets(id) ON DELETE SET NULL (r16): es un log de auditoría;
-- CASCADE borraría la evidencia al borrar el activo, y RESTRICT (default)
-- impediría borrar un asset con historial de force. SET NULL conserva la fila
-- (precio forzado, reason, admin, timestamps) y deja asset_id NULL. Por eso
-- asset_id es NULLABLE. Índice en asset_id para listar por activo.
--
-- Orden de despliegue: con 20261026000100 A1 + server que llama a force_asset_price.

CREATE TABLE IF NOT EXISTS public.asset_price_force_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id        uuid REFERENCES public.assets(id) ON DELETE SET NULL,
  previous_price  numeric,
  new_price       numeric NOT NULL,
  reason          text NOT NULL,
  admin_user_id   uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Si la tabla ya existía sin ON DELETE / con NOT NULL (entornos de prueba
-- reaplicando), alinear definición sin tumbar datos.
DO $$
BEGIN
  ALTER TABLE public.asset_price_force_log
    ALTER COLUMN asset_id DROP NOT NULL;
EXCEPTION WHEN undefined_table OR undefined_column THEN
  NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE public.asset_price_force_log
    DROP CONSTRAINT IF EXISTS asset_price_force_log_asset_id_fkey;
  ALTER TABLE public.asset_price_force_log
    ADD CONSTRAINT asset_price_force_log_asset_id_fkey
    FOREIGN KEY (asset_id) REFERENCES public.assets(id) ON DELETE SET NULL;
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;

CREATE INDEX IF NOT EXISTS asset_price_force_log_asset_id_idx
  ON public.asset_price_force_log (asset_id);

ALTER TABLE public.asset_price_force_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.asset_price_force_log FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.asset_price_force_log TO service_role;

-- grant-exempt: service_role
CREATE OR REPLACE FUNCTION public.force_asset_price(
  p_asset_id uuid,
  p_new_price numeric,
  p_reason text,
  p_admin_user_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  prev numeric;
  reason_trim text;
BEGIN
  reason_trim := btrim(coalesce(p_reason, ''));
  IF reason_trim = '' THEN
    RAISE EXCEPTION 'reason required';
  END IF;
  IF p_admin_user_id IS NULL THEN
    RAISE EXCEPTION 'admin_user_id required';
  END IF;
  IF p_asset_id IS NULL THEN
    RETURN false;
  END IF;
  IF p_new_price IS NULL OR p_new_price <= 0 OR p_new_price >= 1e9 THEN
    RETURN false;
  END IF;

  SELECT a.current_price INTO prev
  FROM public.assets a
  WHERE a.id = p_asset_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Una sola escritura del precio nuevo (sin pasar por NULL).
  UPDATE public.assets
  SET current_price = p_new_price
  WHERE id = p_asset_id;

  INSERT INTO public.asset_price_force_log (
    asset_id, previous_price, new_price, reason, admin_user_id
  ) VALUES (
    p_asset_id, prev, p_new_price, reason_trim, p_admin_user_id
  );

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.force_asset_price(uuid, numeric, text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.force_asset_price(uuid, numeric, text, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.force_asset_price(uuid, numeric, text, uuid) TO service_role;
