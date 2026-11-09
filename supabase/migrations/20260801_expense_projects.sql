-- Proyectos/eventos de gasto: "Viaje a los Pirineos", "Reforma del baño", "Boda".
--
-- Es una etiqueta ORTOGONAL a la categoría, no una categoría más. `category` es
-- una sola columna, así que un restaurante durante el viaje tendría que elegir
-- entre 'restaurants' y 'viaje-pirineos' y se perdería justo la pregunta que
-- motiva la tabla: cuánto nos dejamos EN RESTAURANTES DENTRO del viaje. Con dos
-- ejes (categoría × proyecto) el desglose existe; con uno solo, no.
--
-- Relación con savings_goals: opcional y en un solo sentido. Un proyecto puede
-- apuntar al sobre donde se ahorró para él, y así comparar "apartado" (el sobre,
-- futuro) con "gastado" (los movimientos, pasado). Son dos preguntas distintas
-- que solo aquí se juntan.
CREATE TABLE IF NOT EXISTS expense_projects (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  start_date date,
  end_date   date,
  -- Sobre/meta de ahorro asociado. SET NULL: borrar el sobre no borra el
  -- proyecto ni su historial de gastos, solo deja de haber con qué comparar.
  goal_id    uuid REFERENCES savings_goals(id) ON DELETE SET NULL,
  archived   boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expense_projects_user ON expense_projects (user_id, archived);

ALTER TABLE expense_projects ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'expense_projects' AND policyname = 'users manage own expense_projects') THEN
    CREATE POLICY "users manage own expense_projects"
      ON expense_projects FOR ALL
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

-- La etiqueta en el movimiento. ON DELETE SET NULL es deliberado: borrar un
-- proyecto NUNCA puede llevarse por delante gastos reales del usuario; los
-- movimientos sobreviven, simplemente dejan de estar agrupados.
ALTER TABLE expense_entries ADD COLUMN IF NOT EXISTS project_id uuid
  REFERENCES expense_projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_expense_entries_project
  ON expense_entries (user_id, project_id) WHERE project_id IS NOT NULL;
