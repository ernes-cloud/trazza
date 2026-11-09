import { useState, useEffect } from 'react';
import { Cookie, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const LS_KEY = 'trazza_cookie_consent';

const CookieConsent = () => {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!localStorage.getItem(LS_KEY)) {
      const timer = setTimeout(() => setVisible(true), 1200);
      return () => clearTimeout(timer);
    }
  }, []);

  const accept = (value) => {
    localStorage.setItem(LS_KEY, value);
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div
      // Nunca en el HTML estático (tools/prerender.mjs lo quita): cada visitante decide.
      data-no-prerender=""
      // Mobile: full-width bottom sheet. Desktop (sm+): centered card 448px wide.
      className="fixed bottom-0 inset-x-0 z-9999 sm:bottom-5 sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2 sm:w-md animate-in fade-in slide-in-from-bottom-4 duration-300"
    >
      {/* Papel claro FIJO, sin `dark:`. El banner se monta en App.jsx, así
          que sale por encima de las superficies públicas (landing, legales,
          calculadora), que son de tema fijo claro desde 2026-09-20 — ahí un
          `dark:` se aplicaría según el tema GUARDADO del visitante sobre un
          fondo que no cambia, o sea al revés la mitad de las veces: la clase
          `dark` del html la deja puesta DashboardLayout y no la limpia al
          cerrar sesión. Mismo criterio que el resto de páginas públicas.
          Sin framer-motion: no debe entrar en el grafo estático de `/` (M-C). */}
      <div
        className={[
          // Mobile: no rounding on top to feel like a native sheet
          'border-t sm:border sm:rounded-2xl',
          // Generous bottom padding on mobile covers the home-bar on iOS
          'px-4 pt-4 pb-8 sm:px-5 sm:pb-5 sm:py-4',
          'bg-white border-slate-200',
        ].join(' ')}
        style={{
          boxShadow: '0 -4px 40px rgba(15,23,42,0.12), 0 0 0 0.5px rgba(15,23,42,0.05)',
        }}
      >
        {/* Header row */}
        <div className="flex items-start gap-3 mb-3">
          <div className="p-1.5 rounded-lg bg-blue-50 shrink-0 mt-0.5">
            <Cookie className="w-4 h-4 text-blue-600" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-display text-sm font-black tracking-tight text-slate-900 leading-snug">{t('cookie.title')}</p>
            <p className="text-xs text-slate-600 leading-relaxed mt-0.5">{t('cookie.body')}</p>
          </div>
          <button
            onClick={() => accept('essential')}
            className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
            aria-label={t('common.close')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Un solo botón: no hay cookies analíticas ni de terceros, así que
            "Aceptar todo" frente a "Solo esenciales" no elegía nada — y
            prometer una analítica que no existe contradecía la sección 8
            de la política de privacidad. Si algún día se añade medición
            con cookies, vuelve la elección (y el consentimiento previo). */}
        <button
          onClick={() => accept('essential')}
          className="w-full text-xs font-bold text-white bg-blue-600 hover:bg-blue-500 rounded-xl px-4 py-2.5 transition-colors"
        >
          {t('cookie.ok')}
        </button>
      </div>
    </div>
  );
};

export default CookieConsent;
