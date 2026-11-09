import { useTranslation } from 'react-i18next';
import { setLanguagePreference } from '@/i18n';

/**
 * Selector ES | EN de las páginas públicas. La elección se guarda y manda en
 * toda la web, app incluida. Colores fijos (sin `dark:`): estas páginas son de
 * tema claro fijo (ver CLAUDE.md, "Páginas públicas: papel claro").
 */
export default function LanguageToggle({ className = '' }) {
  const { t, i18n } = useTranslation();
  const current = i18n.language?.startsWith('en') ? 'en' : 'es';
  const btn = (lang, label) => (
    <button
      type="button"
      onClick={() => setLanguagePreference(lang)}
      aria-pressed={current === lang}
      lang={lang}
      className={`px-1.5 py-1 rounded font-semibold transition-colors ${current === lang ? 'text-slate-900' : 'text-slate-400 hover:text-slate-700'}`}
    >
      {label}
    </button>
  );
  return (
    <div role="group" aria-label={t('common.language')} className={`flex items-center text-xs ${className}`}>
      {btn('es', 'ES')}
      <span className="text-slate-300" aria-hidden="true">|</span>
      {btn('en', 'EN')}
    </div>
  );
}
