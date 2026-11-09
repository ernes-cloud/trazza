-- Dos columnas que el CLIENTE YA ESCRIBE pero que nunca llegaron a la BD.
--
-- Sin ellas, en cada carga salían dos fallos que no eran del usuario:
--   * `privacy_mode`        -> 42703 al leerlo (PrivacyModeContext)
--   * `onboarding_completed` -> PGRST204 al escribirlo (OnboardingChecklist)
--
-- El cliente ya degrada con elegancia desde el 2026-09-12 (lee con select('*'),
-- y el marcado de onboarding se intenta UNA vez por sesión y se apoya en
-- localStorage), así que esto no arregla ninguna pantalla rota: lo que arregla
-- es que las dos preferencias PERSISTAN de verdad. Hasta ahora el modo
-- privacidad se perdía al cambiar de dispositivo y el onboarding solo se
-- recordaba en el navegador donde se completó.
--
-- Idempotente a propósito (`IF NOT EXISTS`): si ya se aplicaron a mano desde el
-- editor SQL, esto no hace nada. Que exista como migración versionada es lo que
-- hace el esquema REPRODUCIBLE — un cambio aplicado solo a mano no se puede
-- recrear en otro entorno ni se sabe cuándo entró.

ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS privacy_mode boolean NOT NULL DEFAULT false;

ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS onboarding_completed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.user_preferences.privacy_mode IS
  'Modo privacidad: oculta importes y porcentajes en la interfaz.';
COMMENT ON COLUMN public.user_preferences.onboarding_completed IS
  'La lista de primeros pasos ya se completó; no volver a mostrarla.';

-- No hace falta tocar RLS: la policy `user_preferences_own_user`
-- (20260716_core_tables_rls.sql) es FOR ALL sobre la fila entera, así que las
-- columnas nuevas quedan cubiertas. Y NO son columnas de autorización —
-- `plan` sigue siendo la única, protegida por el trigger de
-- 20260911_user_preferences_plan_guard.sql.

-- Comprobación:
--   SELECT column_name, data_type, column_default
--     FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'user_preferences'
--      AND column_name IN ('privacy_mode', 'onboarding_completed');
