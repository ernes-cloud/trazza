import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { TrendingUp } from 'lucide-react';
import SeoHead from '@/components/SeoHead';
import { NOT_FOUND_PAGE } from '@/lib/siteMeta';
import { GUIDES_INDEX_PATH } from '@/lib/brokerGuides';

/**
 * La 404 de la web: la ruta comodín del router y, prerenderizada, el
 * `dist/404.html`. nginx lo devolverá con estado 404 real cuando se aplique
 * `deploy/nginx/example.com.conf` (`error_page 404 /404.html`); hasta
 * entonces responde 200 y esta página la pinta la SPA. Hasta el 2026-10-17
 * cualquier URL desconocida redirigía a la portada con un 200 (falso 404: Google
 * las indexaba como copias de la home).
 *
 * Web pública: tema FIJO (papel claro, sin `dark:`), como el blog y las legales.
 * `noindex` y sin canonical.
 */
const NotFoundPage = () => {
  const { t, i18n } = useTranslation();
  return (
    <div className="min-h-screen" style={{ backgroundColor: '#faf9f7', color: '#0f172a' }}>
      <SeoHead
        path={NOT_FOUND_PAGE.path}
        title={t(NOT_FOUND_PAGE.titleKey)}
        description={t(NOT_FOUND_PAGE.descKey)}
        noindex
        lang={i18n.language}
      />
      <header className="border-b" style={{ borderColor: 'rgba(15,23,42,0.12)' }}>
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center">
          <Link to="/" className="flex items-center gap-2.5">
            <div className="bg-blue-600 p-1.5 rounded-lg">
              <TrendingUp className="w-4 h-4 text-white" />
            </div>
            <span className="text-lg font-bold text-slate-900 tracking-tight">Trazza</span>
          </Link>
        </div>
      </header>
      <main className="px-6 py-24 max-w-2xl mx-auto">
        <p className="text-[11px] uppercase tracking-[0.14em] text-slate-500 mb-3">{t('not_found.code')}</p>
        <h1 className="text-3xl sm:text-4xl font-black text-slate-900 leading-tight mb-4">{t('not_found.heading')}</h1>
        <p className="text-base leading-relaxed text-slate-600 mb-10">{t('not_found.body')}</p>
        <nav className="flex flex-wrap gap-3">
          <Link to="/auth" className="rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 transition-colors">
            {t('not_found.cta_home')}
          </Link>
          <Link to={GUIDES_INDEX_PATH} className="rounded-lg border px-4 py-2.5 text-sm font-semibold text-slate-900 hover:border-blue-600 transition-colors" style={{ borderColor: 'rgba(15,23,42,0.18)' }}>
            {t('not_found.cta_guides')}
          </Link>
          <Link to="/app" className="px-4 py-2.5 text-sm font-semibold text-blue-600 hover:underline">
            {t('not_found.cta_app')}
          </Link>
        </nav>
      </main>
    </div>
  );
};

export default NotFoundPage;
