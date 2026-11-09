import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n, { ensureAppTranslations } from '@/i18n';

/**
 * No monta la app privada hasta que el chunk de traducciones de la app
 * (es.app / en.app) del idioma actual esté mezclado en i18n. Evita pintar
 * claves crudas (nav.*, demo_mode.*) si el chunk llega después del primer
 * render (LanguageRouteSync solo lo pide en un useEffect).
 *
 * Si el chunk falla: estado de error visible (no montar a ciegas con claves crudas).
 */
export default function AppTranslationsGate({ children }) {
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    ensureAppTranslations(i18n.language || 'es')
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch((e) => {
        console.warn('[i18n] AppTranslationsGate:', e?.message || e);
        if (!cancelled) setFailed(true);
      });
    return () => { cancelled = true; };
  }, []);

  if (failed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900 px-4">
        <div role="alert" className="max-w-sm text-center space-y-3">
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            {t('common.app_translations_error_title')}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('common.app_translations_error_body')}
          </p>
          <button
            type="button"
            className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700"
            onClick={() => window.location.reload()}
          >
            {t('common.retry')}
          </button>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900">
        <div
          role="status"
          aria-label={t('common.loading')}
          className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"
        />
      </div>
    );
  }

  return children;
}
