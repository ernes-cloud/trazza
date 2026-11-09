-- Nueva etapa de telemetría: 'abandon' = el usuario llegó a la tabla de revisión
-- de la importación por IA y cerró sin guardar (FreeformImportDialog). Es justo
-- donde se perdía gente sin dejar rastro. El panel de salud de imports solo
-- cuenta 'parse' y 'save', así que no altera sus porcentajes.
ALTER TABLE public.import_logs DROP CONSTRAINT IF EXISTS import_logs_stage_check;
ALTER TABLE public.import_logs
  ADD CONSTRAINT import_logs_stage_check CHECK (stage IN ('parse', 'save', 'abandon'));
