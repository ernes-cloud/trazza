/**
 * OSS: Gastos is a universal opt-in. Any authenticated user can enable the
 * module via user_preferences.expenses_enabled. There is no owner, admin or
 * beta allowlist, and this file contains no personal emails.
 */
export function isExpensesFeatureAllowed(email) {
  return typeof email === 'string' && email.trim().length > 0;
}
