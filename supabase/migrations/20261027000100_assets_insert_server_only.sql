-- SIN APLICAR (2026-10-27 / r17; ticker lookup r17b). FASE 1 ADITIVA —
-- ensure_asset + UNIQUE(ticker).
--
-- `assets` es tabla COMPARTIDA. Cualquier cuenta con INSERT podía meter filas
-- con ticker/ISIN/precio inventados (auditoría 7f2c915d / r15). El cierre del
-- INSERT (DROP POLICY + REVOKE) va en la FASE 2
-- (`20261029000300_assets_insert_revoke.sql`), DESPUÉS de desplegar server y
-- cliente que ya usan POST /api/assets → ensure_asset.
-- `20261029000100`/`000200` están reservadas para rebotes; no reutilizarlas.
--
-- Qué cambia (solo aditivo; la policy assets_insert_authenticated SIGUE):
--   - UNIQUE(ticker): CREATE UNIQUE INDEX IF NOT EXISTS assets_ticker_key
--     (en prod ya existe); se verifica UNIQUE en pg_index.indisunique, no
--     por nombre.
--   - UNIQUE(lower(btrim(ticker))) assets_ticker_norm_key (r18): la misma
--     clave con la que ensure_asset reencuentra. Si hay duplicados bajo esa
--     clave la migración RAISE con la lista ANTES de crear el índice.
--     Comprobar en prod antes de aplicar:
--       select lower(btrim(ticker)), count(*) from assets group by 1 having count(*) > 1;
--   - RPC public.ensure_asset (SECURITY DEFINER, search_path vacío, EXECUTE
--     solo service_role): INSERT … ON CONFLICT DO NOTHING y SELECT id.
--     Nunca sobrescribe precio/divisa/nombre de un existente.
--   - Alta nueva: current_price NULL salvo CASH_* / asset_class Cash → 1
--     (la liquidez vale 1 por unidad en su divisa; sin precio la vista general
--     de brokers pintaba 0 vía qty×current_price). LIKE usa 'CASH\_%' (\_
--     escapado: `_` es comodín de un carácter en LIKE).
--   - Ticker SIN upper() (r17b/r17c): lookup exacto O lower(btrim) case-
--     insensitive; ORDER BY (ticker = t) DESC prioriza exacto. Si existe,
--     RETURN id sin validar (109/223 assets en prod tienen espacios/()[]/&/;
--     8 no están en mayúsculas — upper() duplicaba ids). Solo altas nuevas:
--     ≤120 chars y sin caracteres de control (misma regla que
--     createAssets.sanitizeTicker).
--   - ISIN ISO 6166 O marcador CASH_* (3–5 letras de divisa), currency 3–5.
--   - company_name/currency coalesce a ticker/'USD' (NULL explícito no usa DEFAULT).
--
-- Orden de despliegue en DOS FASES (r17/r17b; ver history.md):
--   FASE 1: 20261026000100 A1 + 20261026000200 A2 + ESTA + 20261028000100
--           force + 20261028000200 email_sends (+ 20261004_email_sends_activation
--           en el mismo tren) → luego server + cliente.
--   FASE 2: 20261029000300 (DROP POLICY + REVOKE). Aplicar solo cuando el
--           endpoint /api/assets ya está en producción.
--
-- RIESGO DE DESPLIEGUE (r17b): NO usar `supabase db push` a ciegas. Las
-- migraciones remotas son de 14 dígitos (hasta 20261003212938) y en local hay
-- ficheros de 8 dígitos (20261002_*, 20261003_admin_funnel, 20261004, cuatro
-- 20261017_* con la MISMA versión, 20261022). `db push` reaplicaría admin_funnel
-- y chocaría con 20261017. Aplicar una a una (apply_migration) o hacer antes
-- `supabase migration repair`. Ver docs/claude/history.md.
--
-- Verificar tras FASE 1:
--   select has_function_privilege('service_role', 'public.ensure_asset(text, text, text, text, text)', 'execute'); -- true
--   select has_function_privilege('authenticated', 'public.ensure_asset(text, text, text, text, text)', 'execute'); -- false
--   select policyname from pg_policies where tablename = 'assets';
--     -- todavía assets_select_authenticated + assets_insert_authenticated

-- ON CONFLICT (ticker) exige UNIQUE. En producción el índice assets_ticker_key
-- YA existe: CREATE UNIQUE INDEX IF NOT EXISTS solo avisa (NOTICE), no falla.
CREATE UNIQUE INDEX IF NOT EXISTS assets_ticker_key ON public.assets (ticker);

-- IF NOT EXISTS mira solo el NOMBRE: un assets_ticker_key no único pasaría
-- callado y ON CONFLICT (ticker) fallaría en runtime. Se comprueba en pg_index.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = 'public.assets'::regclass
      AND i.indisunique AND i.indisvalid
      AND i.indpred IS NULL AND i.indexprs IS NULL
      AND i.indnatts = 1
      AND i.indkey[0] = (
        SELECT attnum FROM pg_attribute
        WHERE attrelid = 'public.assets'::regclass AND attname = 'ticker'
      )
  ) THEN
    RAISE EXCEPTION 'assets: falta un índice UNIQUE válido sobre (ticker) (assets_ticker_key existe pero no es UNIQUE)';
  END IF;
END $$;

-- ensure_asset reencuentra por lower(btrim(ticker)); dos filas que solo
-- difieren en espacios/casing serían el MISMO activo con dos ids.
DO $$
DECLARE
  dups text;
BEGIN
  SELECT string_agg(k, ', ' ORDER BY k) INTO dups
  FROM (
    SELECT lower(btrim(ticker)) AS k FROM public.assets
    WHERE ticker IS NOT NULL
    GROUP BY 1 HAVING count(*) > 1
  ) d;
  IF dups IS NOT NULL THEN
    RAISE EXCEPTION 'assets: tickers duplicados bajo lower(btrim(ticker)): %. Fusiona esas filas (positions.asset_id) antes de aplicar esta migración', dups;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS assets_ticker_norm_key ON public.assets (lower(btrim(ticker)));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'public.assets'::regclass
      AND c.relname = 'assets_ticker_norm_key'
      AND i.indisunique AND i.indisvalid
  ) THEN
    RAISE EXCEPTION 'assets: assets_ticker_norm_key existe pero no es UNIQUE';
  END IF;
END $$;

-- grant-exempt: service_role
CREATE OR REPLACE FUNCTION public.ensure_asset(
  p_ticker text,
  p_company_name text DEFAULT NULL,
  p_asset_class text DEFAULT NULL,
  p_currency text DEFAULT NULL,
  p_isin text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  t text;
  v_name text;
  v_currency text;
  v_isin text;
  v_price numeric;
  v_class text;
  aid uuid;
BEGIN
  -- Sin upper(): preservar casing real (prod tiene tickers en minúsculas).
  t := btrim(coalesce(p_ticker, ''));
  IF t = '' THEN
    RAISE EXCEPTION 'ticker required';
  END IF;

  -- Existente: devolver id sin validar ni tocar (placeholders con espacios,
  -- paréntesis, barra, corchetes, ampersand, o casing mixto). Exacto gana;
  -- si no, lower(btrim) case-insensitive (ticker guardado con espacios / otro case).
  SELECT a.id INTO aid FROM public.assets a WHERE a.ticker = t OR lower(btrim(a.ticker)) = lower(t) ORDER BY (a.ticker = t) DESC LIMIT 1;
  IF FOUND THEN
    RETURN aid;
  END IF;

  -- Solo altas nuevas: misma regla que createAssets.sanitizeTicker.
  IF char_length(t) > 120 OR t ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid ticker';
  END IF;

  v_isin := nullif(upper(btrim(coalesce(p_isin, ''))), '');
  IF v_isin IS NOT NULL
     AND v_isin !~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$'
     AND v_isin !~ '^CASH_[A-Z0-9]{3,5}$' THEN
    RAISE EXCEPTION 'invalid isin';
  END IF;

  v_name := coalesce(nullif(btrim(p_company_name), ''), t);
  v_currency := coalesce(nullif(upper(btrim(p_currency)), ''), 'USD');
  IF v_currency !~ '^[A-Z]{3,5}$' THEN
    RAISE EXCEPTION 'invalid currency';
  END IF;

  v_class := nullif(btrim(coalesce(p_asset_class, '')), '');
  -- Liquidez: precio unitario 1 por definición (CHF/EUR/USDT…).
  -- LIKE: escapar `_` → 'CASH\_%' (sin eso CASHX… también matchearía).
  IF t LIKE 'CASH\_%' OR upper(coalesce(v_class, '')) = 'CASH' THEN
    v_price := 1;
    IF v_class IS NULL OR upper(v_class) <> 'CASH' THEN
      v_class := 'Cash';
    END IF;
  ELSE
    v_price := NULL;
  END IF;

  INSERT INTO public.assets (ticker, company_name, asset_class, currency, isin, current_price)
  VALUES (t, v_name, v_class, v_currency, v_isin, v_price)
  -- Sin árbitro: también absorbe la carrera contra assets_ticker_norm_key
  -- ('btc-usd' y 'BTC-USD' a la vez); el SELECT de abajo devuelve la fila ganadora.
  ON CONFLICT DO NOTHING;

  SELECT a.id INTO aid FROM public.assets a WHERE a.ticker = t OR lower(btrim(a.ticker)) = lower(t) ORDER BY (a.ticker = t) DESC LIMIT 1;
  RETURN aid;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_asset(text, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.ensure_asset(text, text, text, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_asset(text, text, text, text, text) TO service_role;
