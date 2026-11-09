/**
 * Qué idioma mostrar — PURO, sin tocar window ni localStorage.
 *
 * Hasta el 2026-10-04 el idioma salía SOLO de `navigator.language`, sin selector
 * ni memoria. El robot de Google navega en inglés, así que al ejecutar el JS
 * indexaba la versión INGLESA de páginas con URL en español
 * (`/calculadora-interes-compuesto`) para un producto cuyo público es España.
 *
 * Regla:
 *  1. Lo que el visitante eligió con el selector manda siempre.
 *  2. Páginas públicas (todo lo que no es la app): español por defecto.
 *  3. La app (`/app/...`): el idioma del navegador, como siempre — así no se le
 *     cambia el idioma a nadie que ya la usaba en inglés.
 */

export const SUPPORTED = ['es', 'en'];
export const STORAGE_KEY = 'i18n_lang';
export const PUBLIC_DEFAULT = 'es';

/** ¿Es una ruta de la app privada? */
export const isAppRoute = (pathname = '/') => /^\/app(\/|$)/.test(pathname || '/');

/** Idioma del navegador → 'es' | 'en' (cualquier es-* es español). */
export const fromNavigator = (navLang) => (String(navLang || 'en').toLowerCase().startsWith('es') ? 'es' : 'en');

/**
 * @param {{ saved?: string|null, pathname?: string, navigatorLang?: string }} input
 * @returns {'es'|'en'}
 */
export function resolveLanguage({ saved = null, pathname = '/', navigatorLang = 'en' } = {}) {
  if (SUPPORTED.includes(saved)) return saved;
  return isAppRoute(pathname) ? fromNavigator(navigatorLang) : PUBLIC_DEFAULT;
}
