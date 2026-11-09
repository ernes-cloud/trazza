import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { TrendingUp, ArrowLeft } from 'lucide-react';
import LanguageToggle from '@/components/LanguageToggle';

/* Paleta clara compartida con la landing (ver el bloque de tokens de
   LandingPage.jsx): calculadoras y guías son su continuación, así que van con
   el mismo papel y la misma tinta. Tema FIJO: nada de `dark:` aquí (ver
   docs/claude/public-site.md, "Páginas públicas: papel claro, tema FIJO"). */
export const TOOL_COLORS = {
  BG: '#faf9f7',
  PANEL: '#eef2fb',
  TEXT: '#0f172a',
  MUTED: '#475569',
  FAINT: '#64748b',
  RULE: 'rgba(15,23,42,0.12)',
  ACCENT: '#2563eb',
};
const { TEXT, MUTED, FAINT, RULE, ACCENT } = TOOL_COLORS;

export const PAPER_GRID = {
  backgroundColor: TOOL_COLORS.BG,
  backgroundImage:
    'repeating-linear-gradient(to bottom, transparent, transparent 31px, rgba(15,23,42,0.05) 31px, rgba(15,23,42,0.05) 32px)',
};

/**
 * La clase `dark` del html la deja puesta DashboardLayout y no la limpia al
 * salir de la app: se quita mientras la página pública está montada y se
 * repone al salir, para que nada temático salga en oscuro sobre el papel.
 */
export function usePaperTheme() {
  useEffect(() => {
    const root = document.documentElement;
    const hadDark = root.classList.contains('dark');
    if (hadDark) root.classList.remove('dark');
    return () => { if (hadDark) root.classList.add('dark'); };
  }, []);
}

/** Cabecera de las páginas públicas: logo, selector de idioma y "volver". */
export function PublicHeader({ backTo = '/', backLabel }) {
  return (
    <header className="sticky top-0 z-50" style={{ backgroundColor: 'rgba(250,249,247,0.85)', backdropFilter: 'blur(8px)', borderBottom: `1px solid ${RULE}` }}>
      <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-3 group">
          <div className="w-7 h-7 rounded-md flex items-center justify-center" style={{ backgroundColor: ACCENT }}>
            <TrendingUp className="w-4 h-4" style={{ color: '#fff' }} />
          </div>
          <span className="font-display text-xl font-black tracking-tight" style={{ color: TEXT }}>Trazza</span>
        </Link>
        <div className="flex items-center gap-4">
          <LanguageToggle />
          <Link to={backTo} className="flex items-center gap-2 font-ledger text-[11px] uppercase tracking-[0.18em] transition-colors hover:opacity-70" style={{ color: MUTED }}>
            <ArrowLeft className="w-3.5 h-3.5" />
            {backLabel}
          </Link>
        </div>
      </div>
    </header>
  );
}

/** Pie de las páginas públicas. */
export function PublicFooter() {
  const { t } = useTranslation();
  return (
    <footer className="max-w-5xl mx-auto px-6 py-10 flex items-center justify-between">
      <Link to="/" className="flex items-center gap-2.5">
        <div className="w-6 h-6 rounded-md flex items-center justify-center" style={{ backgroundColor: ACCENT }}>
          <TrendingUp className="w-3.5 h-3.5" style={{ color: '#fff' }} />
        </div>
        <span className="font-display font-black text-sm" style={{ color: TEXT }}>Trazza</span>
      </Link>
      <p className="font-ledger text-[11px] uppercase tracking-[0.14em]" style={{ color: FAINT }}>{t('landing.footer_copy', { year: new Date().getFullYear() })}</p>
    </footer>
  );
}
