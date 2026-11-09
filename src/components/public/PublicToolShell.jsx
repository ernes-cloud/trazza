import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import SeoHead from '@/components/SeoHead';
import { PUBLIC_TOOLS } from '@/lib/siteMeta';
import { motionInitial } from '@/lib/prerenderBoot';
import { TOOL_COLORS, PAPER_GRID, usePaperTheme, PublicHeader, PublicFooter } from '@/components/public/publicFrame';

// Re-exportado: las calculadoras lo importan de aquí.
export { TOOL_COLORS };

const { PANEL, TEXT, MUTED, FAINT, RULE, ACCENT } = TOOL_COLORS;

/**
 * Esqueleto de una herramienta pública (calculadoras): cabecera, titular,
 * la herramienta, explicación para SEO, llamada al registro, enlaces a las otras
 * herramientas y pie. Los textos salen del namespace i18n `ns`:
 * title, meta, back, eyebrow, h1, intro, explainer_title, explainer_1,
 * explainer_2, cta_title, cta_body, cta_btn.
 *
 * Una herramienta nueva = entrada en PUBLIC_PAGES y PUBLIC_TOOLS (siteMeta) +
 * una página que pinte su calculadora dentro de este esqueleto.
 */
export default function PublicToolShell({ ns, path, children }) {
  const { t, i18n } = useTranslation();

  usePaperTheme();

  const others = PUBLIC_TOOLS.filter((tool) => tool.path !== path);

  return (
    <div className="min-h-screen antialiased" style={{ ...PAPER_GRID, color: TEXT }}>
      <SeoHead path={path} schema="calculator" title={t(`${ns}.title`)} description={t(`${ns}.meta`)} lang={i18n.language} />

      <PublicHeader backLabel={t(`${ns}.back`)} />

      <section className="max-w-5xl mx-auto px-6 pt-16 md:pt-20 pb-10">
        <motion.div initial={motionInitial({ opacity: 0, y: 16 })} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}>
          <div className="flex items-center gap-3 mb-6">
            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: ACCENT }} />
            <span className="font-ledger text-[11px] uppercase tracking-[0.24em]" style={{ color: FAINT }}>{t(`${ns}.eyebrow`)}</span>
          </div>
          <h1 className="font-display font-black tracking-tight leading-[1.02] text-[2.6rem] md:text-6xl md:leading-none max-w-3xl" style={{ color: TEXT }}>
            {t(`${ns}.h1`)}
          </h1>
          <p className="mt-6 text-lg leading-relaxed max-w-2xl" style={{ color: MUTED }}>
            {t(`${ns}.intro`)}
          </p>
        </motion.div>
      </section>

      <section className="max-w-5xl mx-auto px-6 pb-16">
        <motion.div
          initial={motionInitial({ opacity: 0, y: 24 })} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, delay: 0.12 }}
          className="rounded-2xl overflow-hidden" style={{ boxShadow: '0 24px 60px rgba(15,23,42,0.10)' }}
        >
          {children}
        </motion.div>
      </section>

      <section className="max-w-5xl mx-auto px-6 py-16" style={{ borderTop: `1px solid ${RULE}` }}>
        <div className="grid lg:grid-cols-12 gap-6 lg:gap-10">
          <div className="lg:col-span-4">
            <h2 className="font-display text-2xl md:text-3xl font-black tracking-tight" style={{ color: TEXT }}>
              {t(`${ns}.explainer_title`)}
            </h2>
          </div>
          <div className="lg:col-span-8 space-y-5 max-w-2xl">
            <p className="text-[15px] leading-relaxed" style={{ color: MUTED }}>{t(`${ns}.explainer_1`)}</p>
            <p className="text-[15px] leading-relaxed" style={{ color: MUTED }}>{t(`${ns}.explainer_2`)}</p>
          </div>
        </div>
      </section>

      <section style={{ backgroundColor: PANEL, borderTop: `1px solid ${RULE}` }}>
        <div className="max-w-5xl mx-auto px-6 py-16 md:py-20 grid lg:grid-cols-12 gap-8 items-center">
          <div className="lg:col-span-8">
            <h2 className="font-display text-3xl md:text-4xl font-black tracking-tight" style={{ color: TEXT }}>{t(`${ns}.cta_title`)}</h2>
            <p className="mt-3 text-[15px] leading-relaxed max-w-xl" style={{ color: MUTED }}>{t(`${ns}.cta_body`)}</p>
          </div>
          <div className="lg:col-span-4 lg:text-right">
            <Link to="/auth?mode=signup">
              <button className="group inline-flex items-center gap-2 font-bold px-8 py-4 rounded-lg text-sm transition-transform hover:-translate-y-0.5" style={{ backgroundColor: ACCENT, color: '#fff' }}>
                {t(`${ns}.cta_btn`)}
                <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
              </button>
            </Link>
          </div>
        </div>
      </section>

      {others.length > 0 && (
        <section className="max-w-5xl mx-auto px-6 pt-12">
          <p className="font-ledger text-[11px] uppercase tracking-[0.24em] mb-4" style={{ color: FAINT }}>{t('tools.more')}</p>
          <div className="grid sm:grid-cols-2 gap-3">
            {others.map((tool) => (
              <Link key={tool.path} to={tool.path} className="group flex items-center justify-between rounded-xl px-5 py-4 transition-colors hover:bg-white" style={{ border: `1px solid ${RULE}` }}>
                <span className="font-semibold text-[15px]" style={{ color: TEXT }}>{t(tool.labelKey)}</span>
                <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" style={{ color: ACCENT }} />
              </Link>
            ))}
          </div>
        </section>
      )}

      <PublicFooter />
    </div>
  );
}
