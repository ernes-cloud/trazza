import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esPublic from './locales/es.public.json';
import { resolveLanguage, STORAGE_KEY, SUPPORTED } from './resolveLanguage';

// La preferencia guardada puede no estar disponible (modo privado, almacenamiento
// bloqueado): en ese caso se decide como si no hubiera elegido nada.
export function readSavedLanguage() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

/** Idioma que corresponde AHORA a esta ruta (ver resolveLanguage). */
export function languageForPath(pathname) {
  return resolveLanguage({
    saved: readSavedLanguage(),
    pathname,
    navigatorLang: typeof navigator !== 'undefined' ? (navigator.language || navigator.languages?.[0]) : 'en',
  });
}

// Público en el bundle inicial (es); el resto son chunks aparte:
// - en.public: inglés de la web pública
// - *.app: namespaces de /app (cartera, dashboard, gastos…)
const LAZY_PUBLIC = {
  en: () => import('./locales/en.public.json'),
};
const LAZY_APP = {
  es: () => import('./locales/es.app.json'),
  en: () => import('./locales/en.app.json'),
};

const appLoaded = new Set();

/** Descarga (una vez) las traducciones PÚBLICAS de `lang` si aún no están. */
export async function ensureLanguage(lang) {
  if (!SUPPORTED.includes(lang)) return;
  if (!i18n.hasResourceBundle(lang, 'translation') && LAZY_PUBLIC[lang]) {
    const mod = await LAZY_PUBLIC[lang]();
    i18n.addResourceBundle(lang, 'translation', mod.default || mod, true, true);
  }
}

/** Descarga los namespaces de la app privada y los mezcla en el idioma. */
export async function ensureAppTranslations(lang = i18n.language || 'es') {
  if (!SUPPORTED.includes(lang)) return;
  await ensureLanguage(lang);
  if (appLoaded.has(lang) || !LAZY_APP[lang]) return;
  const mod = await LAZY_APP[lang]();
  i18n.addResourceBundle(lang, 'translation', mod.default || mod, true, true);
  appLoaded.add(lang);
}

/** Cambia de idioma asegurando antes sus traducciones (nunca muestra claves). */
export async function changeLanguage(lang) {
  if (!SUPPORTED.includes(lang)) return;
  await ensureLanguage(lang);
  // Si ya habíamos cargado el bundle de app en el idioma anterior, cargar el nuevo.
  if (appLoaded.size > 0) await ensureAppTranslations(lang);
  if (i18n.language !== lang) await i18n.changeLanguage(lang);
}

/** El visitante elige idioma: se aplica y se recuerda (manda en toda la web). */
export function setLanguagePreference(lang) {
  if (!SUPPORTED.includes(lang)) return;
  try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* sin almacenamiento: vale para esta visita */ }
  changeLanguage(lang);
}

const initialLanguage = languageForPath(typeof window !== 'undefined' ? window.location.pathname : '/');
const initialPath = typeof window !== 'undefined' ? window.location.pathname : '/';
const needsAppUpfront = initialPath === '/app' || initialPath.startsWith('/app/');

i18n
  .use(initReactI18next)
  .init({
    resources: { es: { translation: esPublic } },
    // Se arranca en español y, si toca otro idioma, se cambia en cuanto llega su
    // chunk: main.jsx espera a `i18nReady` antes de pintar, así que no hay destello.
    lng: 'es',
    fallbackLng: 'es',
    supportedLngs: SUPPORTED,
    partialBundledLanguages: true,
    interpolation: { escapeValue: false },
    // Sin esto, addResourceBundle (chunk *.app) no vuelve a pintar lo ya montado
    // y la barra queda con nav.* / demo_mode.* hasta recargar.
    react: { bindI18nStore: 'added' },
  });

/** Se resuelve cuando el idioma inicial está listo (nunca rechaza: en el peor caso, español). */
export const i18nReady = (async () => {
  try {
    await changeLanguage(initialLanguage);
    if (needsAppUpfront) await ensureAppTranslations(initialLanguage);
  } catch (e) {
    console.warn('[i18n] no se pudo cargar el idioma inicial:', e?.message || e);
  }
})();

export default i18n;
