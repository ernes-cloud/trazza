-- Cierre explícito de una meta de ahorro.
--
-- Hasta ahora "conseguida" era DERIVADO (allocated_amount >= target_amount) y no
-- se persistía nada. Faltaba lo otro: dar una meta por TERMINADA aunque no se
-- alcanzara — la fecha pasó, cambiaste de plan, o ya compraste aquello para lo
-- que ahorrabas. Sin ese estado, la única forma de recuperar el dinero apartado
-- era BORRAR la meta, perdiendo el registro de lo que se hizo.
--
-- NULL = abierta; con fecha = cerrada por el usuario. Una timestamptz (y no un
-- booleano) porque la fecha en que se cerró es justo lo que se quiere enseñar
-- después ("Completada el 22 ago"), y reabrir es volver a ponerla a NULL.
--
-- Regla asociada (client-side, ver services/expenseService.js `isGoalClosed`):
-- una meta cerrada — por esta columna o por vencimiento sin alcanzar — deja de
-- retener dinero y su saldo vuelve a "Disponible para asignar".
ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS completed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_savings_goals_open
  ON savings_goals (user_id)
  WHERE completed_at IS NULL;
