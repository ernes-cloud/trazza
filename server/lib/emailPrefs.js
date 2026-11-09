/**
 * ¿Quiere este usuario el CORREO de esta categoría de aviso?
 *
 * Ajustes ofrece un interruptor general (`email_notifications_enabled`) y
 * cuatro por categoría (dividendos, resultados, alertas, informe semanal).
 * Hasta el 2026-10-02 el server solo miraba el general: apagar "correos de
 * dividendos" no hacía nada. La decisión vive aquí, pura, para que el cron de
 * avisos y el del informe semanal no puedan discrepar.
 *
 * Solo afecta al CORREO: la notificación en la app se crea igual.
 * Un valor ausente (null/undefined, columna sin migrar, usuario sin fila) se
 * trata como "sí": es el comportamiento que tenía todo el mundo hasta ahora.
 */
export const EMAIL_CATEGORY_COLUMNS = {
  dividends: 'email_notify_dividends',
  earnings: 'email_notify_earnings',
  alerts: 'email_notify_alerts',
  weekly: 'email_notify_weekly_report',
};

/**
 * @param {object|null|undefined} prefs  fila de user_preferences
 * @param {'dividends'|'earnings'|'alerts'|'weekly'|null} category  null = sin categoría propia
 */
export function wantsEmail(prefs, category) {
  if (!prefs) return true;
  if (prefs.email_notifications_enabled === false) return false;
  const column = category ? EMAIL_CATEGORY_COLUMNS[category] : null;
  if (!column) return true;
  return prefs[column] !== false;
}
