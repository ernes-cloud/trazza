import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import i18n, { languageForPath, changeLanguage, ensureAppTranslations } from '@/i18n';

/**
 * Vuelve a resolver el idioma al cambiar de ruta. Sin preferencia guardada, la
 * web pública va en español y la app sigue al navegador (ver
 * i18n/resolveLanguage.js): al pasar de una a otra dentro de la SPA, el idioma
 * tiene que cambiar igual que si se hubiera entrado por esa URL.
 *
 * Al entrar en `/app` también se carga el chunk i18n de la app (es.app /
 * en.app), que no viaja en el bundle público.
 */
export default function LanguageRouteSync() {
  const { pathname } = useLocation();
  useEffect(() => {
    const lang = languageForPath(pathname);
    const run = async () => {
      if (i18n.language !== lang) await changeLanguage(lang);
      if (pathname === '/app' || pathname.startsWith('/app/')) {
        await ensureAppTranslations(lang);
      }
    };
    run();
  }, [pathname]);
  return null;
}
