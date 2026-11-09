/**
 * Build-time feature flags for work that is merged but not finished.
 *
 * A flag here means "the code is complete enough to keep, incomplete enough to
 * hide". Deleting the branch instead would lose the tests and the measurements
 * that justify the design; leaving it visible would ship a half-feature.
 *
 * Flipping one to `true` is the ONLY step needed to expose the feature — no
 * other conditional should guard it, or the flag stops being the single switch
 * it is meant to be.
 */

/**
 * Bank-statement import in the expenses screen (BBVA .xlsx / Revolut .csv).
 *
 * INCOMPLETE — see the "Import de extractos bancarios" section in CLAUDE.md.
 * Blocking gaps before this can be turned on:
 *   1. Migration 20260801_expense_bank_import.sql is NOT applied in Supabase —
 *      the insert fails without `import_key` / `merchant` / `source`.
 *   2. No AI categorization: ~62% of a real statement lands in "Otros".
 *   3. No cross-account transfer matching (BBVA ↔ Revolut), so a transfer
 *      between the user's own banks is only caught when the counterparty name
 *      matches, not by amount+date.
 */
export const BANK_IMPORT_ENABLED = false;

/**
 * Puerta de la beta PRIVADA (`ProtectedRoute` → `BetaPending`).
 *
 *   false → acceso ABIERTO: quien se registre entra directo a /app.
 *   true  → vuelve la beta privada: hace falta una fila `beta_access` aprobada,
 *           estar en la allowlist, o ser admin.
 *
 * Toda la infraestructura sigue en pie a propósito —tabla `beta_access`, el
 * trigger que crea la fila en el alta, `beta_allowlist` y el panel de admin—,
 * así que volver a cerrar es poner esto en `true`: sin migración y sin perder
 * el histórico de quién pidió acceso y cuándo.
 *
 * ⚠️ Si algún día la CIERRAS otra vez: el trigger sigue dando de alta a los
 * nuevos como 'pending', así que todo el que entró durante la beta abierta se
 * quedaría fuera de golpe, sin haber hecho nada. Apruébalos antes:
 *
 *   UPDATE beta_access SET status = 'approved', decided_at = now()
 *    WHERE status = 'pending';
 *
 * El distintivo "BETA" de la interfaz NO depende de este flag: seguimos en beta
 * aunque el acceso sea libre, que es justo lo que hay que comunicar.
 */
export const BETA_GATE_ENABLED = false;
