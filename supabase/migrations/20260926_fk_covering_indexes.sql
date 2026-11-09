-- Índices que faltan sobre claves foráneas (linter de Supabase, 2026-09-26).
--
-- Una FK sin índice de cobertura obliga a un seq scan en cada JOIN por esa
-- columna y en cada DELETE del padre (Postgres tiene que comprobar que no
-- quedan hijos). Con los volúmenes de hoy no se nota; con años de histórico y
-- más usuarios, sí — y justo las dos tablas que más crecen, `notifications`
-- (872 filas) y `expense_entries` (1.449), están en la lista.
--
-- Es una migración PURAMENTE ADITIVA: no cambia semántica, no toca RLS y se
-- revierte con un DROP INDEX. `IF NOT EXISTS` la hace idempotente.
--
-- NOTA sobre CONCURRENTLY: no se usa porque no puede ir dentro de una
-- transacción (y el runner de migraciones envuelve todo en una). Con estas
-- cardinalidades el lock de un CREATE INDEX normal dura milisegundos. Si
-- algún día estas tablas tienen millones de filas, hay que lanzarlos a mano
-- con CONCURRENTLY y fuera de transacción.

CREATE INDEX IF NOT EXISTS idx_notifications_user_id
  ON public.notifications (user_id);

CREATE INDEX IF NOT EXISTS idx_watchlists_user_id
  ON public.watchlists (user_id);

CREATE INDEX IF NOT EXISTS idx_watchlist_items_watchlist_id
  ON public.watchlist_items (watchlist_id);

CREATE INDEX IF NOT EXISTS idx_watchlist_alerts_watchlist_item_id
  ON public.watchlist_alerts (watchlist_item_id);

CREATE INDEX IF NOT EXISTS idx_imported_data_broker_id
  ON public.imported_data (broker_id);

CREATE INDEX IF NOT EXISTS idx_expense_projects_goal_id
  ON public.expense_projects (goal_id);

-- ⚠️ `expense_entries.project_id` NECESITA su propio índice, aunque a primera
-- vista parezca cubierto. El que ya existía es:
--     idx_expense_entries_project ON (user_id, project_id) WHERE project_id IS NOT NULL
-- y NO sirve para la clave foránea por dos motivos: `project_id` va en segunda
-- posición (una FK se resuelve por la columna PRINCIPAL del índice) y además es
-- PARCIAL, así que Postgres no lo usa para la comprobación de integridad al
-- borrar un `expense_project`. Comprobado contra `pg_constraint`/`pg_index`:
-- era la única FK del esquema que seguía descubierta.
-- El parcial se conserva — sigue siendo el índice bueno para listar los
-- movimientos de un proyecto de un usuario.
CREATE INDEX IF NOT EXISTS idx_expense_entries_project_id
  ON public.expense_entries (project_id);
