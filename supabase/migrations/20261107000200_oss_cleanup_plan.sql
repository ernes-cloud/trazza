-- OSS cleanup: remove billing plan column only.

ALTER TABLE IF EXISTS public.user_preferences
  DROP CONSTRAINT IF EXISTS user_preferences_plan_check;

ALTER TABLE IF EXISTS public.user_preferences
  DROP COLUMN IF EXISTS plan;

DROP TRIGGER IF EXISTS guard_plan_column ON public.user_preferences;
DROP FUNCTION IF EXISTS public.guard_user_preferences_plan();
