/**
 * Bienvenida de una cuenta nueva (idioma, divisa, tema y avisos): cuándo se
 * enseña. PURO y testeado; el diálogo vive en components/onboarding.
 *
 * La marca de "hecha" va en los METADATOS de la cuenta de Supabase
 * (`user_metadata.welcome_completed_at`), no en `user_preferences`:
 *  - `onboarding_completed` ya la usa la lista "Primeros pasos" para ocultarse
 *    para siempre; reutilizarla la escondería antes de importar nada.
 *  - `preferred_currency` no sirve de marca: la columna tiene valor por defecto
 *    (EUR) y la fila nueva ya llega con él.
 * Los metadatos los escribe el propio usuario, sin migración, y valen en
 * cualquier dispositivo. localStorage cubre el instante hasta que se guardan.
 */

export const WELCOME_LS_KEY = 'trazza_welcome_done';
/** Solo cuentas recientes: quien ya usaba Trazza no ve una bienvenida. */
export const WELCOME_MAX_ACCOUNT_AGE_DAYS = 30;
/** Divisas con botón propio en la bienvenida; el resto, en su desplegable. */
export const WELCOME_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF'];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {{ user?: { created_at?: string, user_metadata?: object }|null, isDemoMode?: boolean,
 *           prefsLoading?: boolean, dismissedLocally?: boolean, now?: Date }} p
 */
export function shouldShowWelcome({ user, isDemoMode = false, prefsLoading = false, dismissedLocally = false, now = new Date() }) {
  if (!user || isDemoMode || prefsLoading || dismissedLocally) return false;
  if (user.user_metadata?.welcome_completed_at) return false;
  const created = new Date(user.created_at).getTime();
  if (!Number.isFinite(created)) return false;
  const age = now.getTime() - created;
  return age >= 0 && age <= WELCOME_MAX_ACCOUNT_AGE_DAYS * DAY_MS;
}
