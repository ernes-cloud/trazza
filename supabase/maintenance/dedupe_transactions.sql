-- ============================================================================
-- LIMPIEZA DE TRANSACCIONES DUPLICADAS POR EL BUG DE DEDUPE DEL RE-IMPORT
-- ============================================================================
-- Contexto: hasta 2026-07-01 el SELECT de dedupe del cliente no incluía
-- total_amount, por lo que CADA re-sincronización de CSV volvía a insertar
-- todos los DIVIDEND/FEE/FEES/TAX/CASH/TRANSFER del archivo. El fix en
-- src/lib/importDedupe.js detiene las duplicaciones nuevas; este script
-- elimina las ya acumuladas.
--
-- Cómo usarlo (Supabase Dashboard → SQL Editor):
--   1. Ejecuta el PASO 0 y comprueba el tipo de transaction_date (informativo).
--   2. Ejecuta el PASO 1 (solo lectura) para ver cuántos duplicados hay.
--   3. Ejecuta el PASO 2 (solo lectura) para revisar las filas exactas.
--   4. Si todo cuadra, ejecuta el PASO 3 completo (BEGIN...COMMIT).
--      Dentro de la transacción se muestra el recuento; si algo no cuadra,
--      sustituye COMMIT por ROLLBACK.
--
-- Criterio de duplicado (idéntico a transCheckKey del cliente):
--   - No-BUY/SELL: mismo position_id + tipo + fecha + |importe| (2 dec) + notes(30)
--   - BUY/SELL:    mismo position_id + tipo + fecha + cantidad (4 dec) + precio (2 dec)
-- De cada grupo se CONSERVA la fila más completa (con eur_total/commission/
-- transaction_currency rellenos) y se borran las demás.
--
-- ⚠️ Haz un backup antes (Database → Backups, o pg_dump). El DELETE es global
--    (todos los usuarios): el bug afectaba a cualquiera que re-sincronizara.
-- ============================================================================

-- ── PASO 0 · Tipo de la columna de fecha (informativo) ──────────────────────
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'transactions'
  AND column_name IN ('transaction_date', 'total_amount', 'quantity', 'price');

-- ── PASO 1 · Recuento de duplicados por tipo (solo lectura) ─────────────────
WITH keyed AS (
  SELECT id, transaction_type,
         row_number() OVER (
           PARTITION BY
             position_id,
             transaction_type,
             date_trunc('second', transaction_date),
             CASE WHEN transaction_type IN ('BUY','SELL')
                  THEN round(coalesce(quantity, 0)::numeric, 4)
                  ELSE round(abs(coalesce(total_amount, 0))::numeric, 2) END,
             CASE WHEN transaction_type IN ('BUY','SELL')
                  THEN round(coalesce(price, 0)::numeric, 2) END,
             CASE WHEN transaction_type NOT IN ('BUY','SELL')
                  THEN left(coalesce(notes, ''), 30) END
           ORDER BY (eur_total IS NULL), (commission IS NULL),
                    (transaction_currency IS NULL), id
         ) AS rn
  FROM transactions
)
SELECT transaction_type,
       count(*) FILTER (WHERE rn > 1) AS filas_duplicadas_a_borrar,
       count(*)                       AS filas_totales
FROM keyed
GROUP BY transaction_type
ORDER BY filas_duplicadas_a_borrar DESC;

-- ── PASO 2 · Detalle de las filas que se borrarían (solo lectura) ───────────
WITH keyed AS (
  SELECT t.*,
         row_number() OVER (
           PARTITION BY
             position_id,
             transaction_type,
             date_trunc('second', transaction_date),
             CASE WHEN transaction_type IN ('BUY','SELL')
                  THEN round(coalesce(quantity, 0)::numeric, 4)
                  ELSE round(abs(coalesce(total_amount, 0))::numeric, 2) END,
             CASE WHEN transaction_type IN ('BUY','SELL')
                  THEN round(coalesce(price, 0)::numeric, 2) END,
             CASE WHEN transaction_type NOT IN ('BUY','SELL')
                  THEN left(coalesce(notes, ''), 30) END
           ORDER BY (eur_total IS NULL), (commission IS NULL),
                    (transaction_currency IS NULL), id
         ) AS rn
  FROM transactions t
)
SELECT id, position_id, transaction_type, transaction_date,
       quantity, price, total_amount, left(coalesce(notes,''), 40) AS notes_40, rn
FROM keyed
WHERE rn > 1
ORDER BY position_id, transaction_date, transaction_type
LIMIT 500;

-- ── PASO 3 · BORRADO (ejecutar el bloque completo; revisar antes de COMMIT) ─
BEGIN;

WITH keyed AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY
             position_id,
             transaction_type,
             date_trunc('second', transaction_date),
             CASE WHEN transaction_type IN ('BUY','SELL')
                  THEN round(coalesce(quantity, 0)::numeric, 4)
                  ELSE round(abs(coalesce(total_amount, 0))::numeric, 2) END,
             CASE WHEN transaction_type IN ('BUY','SELL')
                  THEN round(coalesce(price, 0)::numeric, 2) END,
             CASE WHEN transaction_type NOT IN ('BUY','SELL')
                  THEN left(coalesce(notes, ''), 30) END
           ORDER BY (eur_total IS NULL), (commission IS NULL),
                    (transaction_currency IS NULL), id
         ) AS rn
  FROM transactions
)
DELETE FROM transactions
WHERE id IN (SELECT id FROM keyed WHERE rn > 1);

-- Muestra cuántas filas se han borrado en esta transacción (aún reversible):
-- si el número no cuadra con el PASO 1, ejecuta ROLLBACK; en vez de COMMIT;
COMMIT;

-- ── PASO 4 · Después del borrado ────────────────────────────────────────────
-- El caché de métricas se invalida solo (usa el nº de transacciones como
-- versión), pero puedes forzarlo:
--   DELETE FROM portfolio_metrics_cache;
-- Después: abre la app, entra en el broker y pulsa Sincronizar una vez con el
-- CSV del histórico completo para reconciliar posiciones y saldos de caja.
