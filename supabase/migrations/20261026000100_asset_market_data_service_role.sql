-- SIN APLICAR (2026-10-26). Auditoría 7f2c915d, A1.
--
-- update_asset_market_data era SECURITY DEFINER y ejecutable por
-- `authenticated`, con una sola comprobación de precio (`> 0`): cualquier
-- cuenta gratis podía ejecutar
--   supabase.rpc('update_asset_market_data', { p_asset_id: '<AAPL>', p_current_price: 0.01 })
-- y ese precio pasaba a valorar las carteras compartidas en vivo
-- (server/routes/sharePortfolio.js), a ser la reserva del snapshot diario y el
-- punto de partida de todos los clientes. `assets` es una tabla COMPARTIDA y
-- `assets_select_authenticated USING (true)` deja leer el id de cualquier fila.
--
-- Qué cambia:
--
-- 1) update_asset_market_data → solo service role (server/jobs/portfolioSnapshots.js
--    vía server/lib/assetPrices.js, que trae sus propias cotizaciones). Pasa a
--    SECURITY INVOKER: el service role ya salta RLS, y si algún día alguien
--    vuelve a darle EXECUTE a `authenticated` por error, RLS bloquea el UPDATE
--    (no hay policy de UPDATE en assets desde 20260610) en vez de abrirlo.
--    Devuelve si el precio se aplicó. Validación de cordura DENTRO de la
--    función, que no depende del código que la llame:
--      - el precio tiene que ser finito y > 0 (`'NaN'::numeric > 0` es TRUE en
--        Postgres: sin la comprobación explícita un NaN se escribía);
--      - tope de 1e9 por unidad (nada cotiza ahí; un exponente mal parseado sí);
--      - desplome: si el precio nuevo es < 15 % del guardado no se aplica. Es el
--        mismo umbral que src/services/priceGuard.js (PRICE_COLLAPSE_RATIO); la
--        subida no se limita a propósito, para que un precio corrompido a la
--        baja se pueda curar.
--    Como cambia el tipo de retorno (void → boolean) hay que DROP + CREATE.
--    DROP sin IF EXISTS: si la firma no está, el deploy falla a propósito
--    (mejor que aplicar a medias). SET search_path = '' (cadena vacía) +
--    nombres calificados (public./auth.) para que un search_path hostil no
--    desvíe la función.
--
-- 2) update_asset_metadata (NUEVA) → lo que el cliente sí puede seguir
--    escribiendo: nombre (solo filas CASH_* o con el ISIN de placeholder),
--    isin/sector/industry/country/asset_class (solo si van a NULL). Sin
--    precio. Y solo sobre activos que el usuario TIENE en una posición suya
--    (por broker o por portfolio, mismo criterio que adjust_position_quantity):
--    antes cualquiera podía rellenar el sector o renombrar el CASH_ de una
--    fila que no era suya.
--
-- Orden de despliegue en DOS FASES (r17; ver history.md):
--   FASE 1: 20261026000100/000200/20261027000100 (+ force/email) + server +
--   cliente se publican JUNTOS. Luego POST /api/admin/run-snapshots y
--   comprobar assetPricesWritten > 0.
--   - Cliente nuevo + BD vieja: update_asset_metadata / INSERT assets fallan
--     (404 / 42501); import y alta manual rotos hasta aplicar la migración.
--   - Server nuevo + BD vieja: la función vieja exige auth.uid() y el service
--     role no lo tiene → el cron no escribe precios hasta aplicar esto
--     (aviso en log, el snapshot sigue).
-- Escape del guard del 15 % ante un split real: POST /api/admin/force-asset-price
-- (limpia current_price a NULL y reaplica la RPC; ver adminForceAssetPrice.js).
--
-- Verificar tras aplicar:
--   select has_function_privilege('authenticated', 'public.update_asset_market_data(uuid, numeric, text, text, text, text, text, text)', 'execute'); -- false
--   select has_function_privilege('service_role',  'public.update_asset_market_data(uuid, numeric, text, text, text, text, text, text)', 'execute'); -- true
--   select has_function_privilege('authenticated', 'public.update_asset_metadata(uuid, text, text, text, text, text, text)', 'execute');            -- true

-- ── 1. update_asset_market_data: solo service role, con guard de precio ─────

DROP FUNCTION public.update_asset_market_data(uuid, numeric, text, text, text, text, text, text);

-- grant-exempt: service_role
CREATE FUNCTION public.update_asset_market_data(
  p_asset_id UUID,
  p_current_price NUMERIC DEFAULT NULL,
  p_company_name TEXT DEFAULT NULL,
  p_isin TEXT DEFAULT NULL,
  p_sector TEXT DEFAULT NULL,
  p_industry TEXT DEFAULT NULL,
  p_country TEXT DEFAULT NULL,
  p_asset_class TEXT DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_stored NUMERIC;
  v_apply_price BOOLEAN := false;
BEGIN
  SELECT a.current_price INTO v_stored FROM public.assets a WHERE a.id = p_asset_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF p_current_price IS NOT NULL
     AND p_current_price <> 'NaN'::numeric
     AND p_current_price > 0
     AND p_current_price < 1e9
     AND (v_stored IS NULL OR v_stored <= 0 OR v_stored = 'NaN'::numeric
          OR p_current_price >= v_stored * 0.15)
  THEN
    v_apply_price := true;
  END IF;

  UPDATE public.assets a SET
    current_price = CASE WHEN v_apply_price THEN p_current_price ELSE a.current_price END,
    company_name = CASE
        WHEN p_company_name IS NOT NULL
             AND (a.ticker LIKE 'CASH\_%' OR a.company_name = a.isin OR a.company_name IS NULL)
          THEN p_company_name
        ELSE a.company_name
      END,
    isin        = COALESCE(a.isin, p_isin),
    sector      = COALESCE(a.sector, p_sector),
    industry    = COALESCE(a.industry, p_industry),
    country     = COALESCE(a.country, p_country),
    asset_class = COALESCE(a.asset_class, p_asset_class)
  WHERE a.id = p_asset_id;

  RETURN v_apply_price;
END;
$$;

REVOKE ALL ON FUNCTION public.update_asset_market_data(uuid, numeric, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_asset_market_data(uuid, numeric, text, text, text, text, text, text) TO service_role;

-- ── 2. update_asset_metadata: el cliente, sin precio y solo lo suyo ─────────

CREATE OR REPLACE FUNCTION public.update_asset_metadata(
  p_asset_id UUID,
  p_company_name TEXT DEFAULT NULL,
  p_isin TEXT DEFAULT NULL,
  p_sector TEXT DEFAULT NULL,
  p_industry TEXT DEFAULT NULL,
  p_country TEXT DEFAULT NULL,
  p_asset_class TEXT DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  UPDATE public.assets a SET
    company_name = CASE
        WHEN p_company_name IS NOT NULL
             AND (a.ticker LIKE 'CASH\_%' OR a.company_name = a.isin OR a.company_name IS NULL)
          THEN p_company_name
        ELSE a.company_name
      END,
    isin        = COALESCE(a.isin, p_isin),
    sector      = COALESCE(a.sector, p_sector),
    industry    = COALESCE(a.industry, p_industry),
    country     = COALESCE(a.country, p_country),
    asset_class = COALESCE(a.asset_class, p_asset_class)
  WHERE a.id = p_asset_id
    AND EXISTS (
      SELECT 1 FROM public.positions p
      WHERE p.asset_id = a.id
        AND (
          EXISTS (SELECT 1 FROM public.brokers b WHERE b.id = p.broker_id AND b.user_id = auth.uid())
          OR EXISTS (SELECT 1 FROM public.portfolios pf WHERE pf.id = p.portfolio_id AND pf.user_id = auth.uid())
        )
    );

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.update_asset_metadata(uuid, text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_asset_metadata(uuid, text, text, text, text, text, text) TO authenticated;
