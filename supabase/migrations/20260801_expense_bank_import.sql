-- Import de extractos bancarios en la feature de Gastos.
--
-- Tres columnas sobre expense_entries; ninguna toca la matemática existente.
--
-- `import_key` es la clave de re-import: un extracto se descarga solapado por
-- diseño ("últimos 3 meses" cada mes). NO es un digest, es una clave
-- determinista que INCLUYE UN ORDINAL DE OCURRENCIA — dos movimientos idénticos
-- del mismo día son dos gastos reales (medido: 16 grupos así en un extracto de
-- 1440 filas) y deben conservarse los dos. Por eso el índice es UNIQUE por
-- (user_id, import_key) y no por los datos del movimiento.
--
-- El UNIQUE es una red de seguridad frente a dos pestañas importando a la vez,
-- no el mecanismo de dedupe: el filtrado real ocurre en el cliente contra las
-- claves ya guardadas, para poder ENSEÑAR al usuario cuántas filas se omiten.

ALTER TABLE expense_entries ADD COLUMN IF NOT EXISTS import_key text;
ALTER TABLE expense_entries ADD COLUMN IF NOT EXISTS merchant text;
ALTER TABLE expense_entries ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

-- Parcial: las filas manuales (la inmensa mayoría) no ocupan índice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_expense_entries_import_key
  ON expense_entries (user_id, import_key)
  WHERE import_key IS NOT NULL;

-- La consulta del import: "¿qué claves de este usuario ya existen?"
CREATE INDEX IF NOT EXISTS idx_expense_entries_user_source
  ON expense_entries (user_id, source);

COMMENT ON COLUMN expense_entries.import_key IS
  'Clave determinista de re-import (banco|fecha|importe|comercio|detalle|ordinal). NULL en filas manuales.';
COMMENT ON COLUMN expense_entries.merchant IS
  'Comercio/contraparte tal cual lo resolvió el parser bancario. Separado de notes, que es del usuario.';
COMMENT ON COLUMN expense_entries.source IS
  'manual | bank_import';
