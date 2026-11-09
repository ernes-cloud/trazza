import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRight, AlertTriangle, Info } from 'lucide-react';
import SeoHead from '@/components/SeoHead';
import NotFoundPage from '@/pages/NotFoundPage';
import { TOOL_COLORS, PAPER_GRID, usePaperTheme, PublicHeader, PublicFooter } from '@/components/public/publicFrame';
import { BROKER_GUIDES, GUIDES_INDEX_PATH, GUIDES_UPDATED, findGuide, guidePath } from '@/lib/brokerGuides';

const { PANEL, TEXT, MUTED, FAINT, RULE, ACCENT } = TOOL_COLORS;

const FACTS = ['entity', 'withholding', 'draft', 'model'];

/** Lista de textos de i18n (arrays): nunca revienta si falta la clave. */
const useList = (t) => (key) => {
  const v = t(key, { returnObjects: true });
  return Array.isArray(v) ? v : [];
};

const SectionTitle = ({ children }) => (
  <h2 className="font-display text-2xl md:text-3xl font-black tracking-tight mb-5" style={{ color: TEXT }}>{children}</h2>
);

/**
 * Guía pública de un broker: cómo exportar sus operaciones y cómo declararlas
 * en la Renta. Textos en `guides.<key>.*` y `guides.common.*`; catálogo en
 * lib/brokerGuides. Tema FIJO (papel claro): nada de `dark:`.
 */
export default function BrokerGuidePage() {
  const { slug } = useParams();
  const { t, i18n } = useTranslation();
  const list = useList(t);
  usePaperTheme();

  const guide = findGuide(slug);
  // Slug inventado → la 404 (noindex). Antes redirigía al índice: un 200 que
  // Google trataba como copia de /guias.
  if (!guide) return <NotFoundPage />;

  const k = (key) => `guides.${guide.key}.${key}`;
  const others = BROKER_GUIDES.filter((g) => g.slug !== guide.slug);
  const updated = new Date(`${GUIDES_UPDATED}T12:00:00Z`)
    .toLocaleDateString(i18n.language === 'en' ? 'en-GB' : 'es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  return (
    <div className="min-h-screen antialiased" style={{ ...PAPER_GRID, color: TEXT }}>
      <SeoHead path={guidePath(guide.slug)} schema="article" title={t(k('title'))} description={t(k('meta'))} lang={i18n.language} />
      <PublicHeader backTo={GUIDES_INDEX_PATH} backLabel={t('guides.common.all_guides')} />

      <article>
        <section className="max-w-3xl mx-auto px-6 pt-14 md:pt-20 pb-8">
          <div className="flex items-center gap-3 mb-6">
            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: ACCENT }} />
            <span className="font-ledger text-[11px] uppercase tracking-[0.24em]" style={{ color: FAINT }}>
              {t('guides.common.eyebrow')} · {t('guides.common.updated', { date: updated })}
            </span>
          </div>
          <h1 className="font-display font-black tracking-tight leading-[1.05] text-[2.3rem] md:text-5xl" style={{ color: TEXT }}>
            {t(k('h1'))}
          </h1>
          <p className="mt-6 text-lg leading-relaxed" style={{ color: MUTED }}>{t(k('intro'))}</p>
        </section>

        <section className="max-w-3xl mx-auto px-6 pb-12">
          <dl className="grid sm:grid-cols-2 gap-3">
            {FACTS.map((f) => (
              <div key={f} className="rounded-xl px-5 py-4 bg-white" style={{ border: `1px solid ${RULE}` }}>
                <dt className="font-ledger text-[10px] uppercase tracking-[0.2em] mb-1.5" style={{ color: FAINT }}>{t(`guides.common.fact_${f}`)}</dt>
                <dd className="text-[15px] leading-snug font-medium" style={{ color: TEXT }}>{t(k(`fact_${f}`))}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="max-w-3xl mx-auto px-6 py-10" style={{ borderTop: `1px solid ${RULE}` }}>
          <SectionTitle>{t('guides.common.export_title', { broker: guide.name })}</SectionTitle>
          <ol className="space-y-3">
            {list(k('export_steps')).map((step, i) => (
              <li key={i} className="flex gap-4">
                <span className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center font-ledger text-xs font-bold" style={{ backgroundColor: PANEL, color: ACCENT }}>{i + 1}</span>
                <span className="text-[15px] leading-relaxed pt-0.5" style={{ color: MUTED }}>{step}</span>
              </li>
            ))}
          </ol>
          <p className="mt-6 flex gap-3 rounded-xl px-5 py-4 text-[14px] leading-relaxed" style={{ backgroundColor: PANEL, color: MUTED }}>
            <Info className="w-4 h-4 shrink-0 mt-0.5" style={{ color: ACCENT }} />
            {t(k('export_note'))}
          </p>
        </section>

        <section className="max-w-3xl mx-auto px-6 py-10" style={{ borderTop: `1px solid ${RULE}` }}>
          <SectionTitle>{t('guides.common.declare_title')}</SectionTitle>
          <ul className="space-y-3">
            {list(k('declare')).map((item, i) => (
              <li key={i} className="flex gap-3 text-[15px] leading-relaxed" style={{ color: MUTED }}>
                <span className="shrink-0 mt-2.5 w-1.5 h-1.5 rounded-full" style={{ backgroundColor: ACCENT }} />
                {item}
              </li>
            ))}
          </ul>
        </section>

        <section className="max-w-3xl mx-auto px-6 py-10" style={{ borderTop: `1px solid ${RULE}` }}>
          <SectionTitle>{t('guides.common.pitfalls_title')}</SectionTitle>
          <ul className="space-y-3">
            {list(k('pitfalls')).map((item, i) => (
              <li key={i} className="flex gap-3 text-[15px] leading-relaxed" style={{ color: MUTED }}>
                <AlertTriangle className="w-4 h-4 shrink-0 mt-1" style={{ color: '#b45309' }} />
                {item}
              </li>
            ))}
          </ul>
        </section>

        <section className="max-w-3xl mx-auto px-6 py-10" style={{ borderTop: `1px solid ${RULE}` }}>
          <SectionTitle>{t('guides.common.basics_title')}</SectionTitle>
          <div className="space-y-5">
            {['fifo', 'rates', 'two_months'].map((b) => (
              <div key={b}>
                <h3 className="font-bold text-[16px] mb-1.5" style={{ color: TEXT }}>{t(`guides.common.${b}_title`)}</h3>
                <p className="text-[15px] leading-relaxed" style={{ color: MUTED }}>{t(`guides.common.${b}_body`)}</p>
              </div>
            ))}
          </div>
          <Link to="/calculadora-plusvalias" className="group mt-6 inline-flex items-center gap-1.5 text-[15px] font-bold" style={{ color: ACCENT }}>
            {t('guides.common.calc_link')}
            <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </section>
      </article>

      <section style={{ backgroundColor: PANEL, borderTop: `1px solid ${RULE}` }}>
        <div className="max-w-3xl mx-auto px-6 py-14 md:py-16">
          <h2 className="font-display text-3xl md:text-4xl font-black tracking-tight" style={{ color: TEXT }}>
            {t('guides.common.cta_title', { broker: guide.name })}
          </h2>
          <p className="mt-3 text-[15px] leading-relaxed" style={{ color: MUTED }}>{t(k('trazza'))}</p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link to="/auth?mode=signup" className="group inline-flex items-center gap-2 font-bold px-7 py-3.5 rounded-lg text-sm transition-transform hover:-translate-y-0.5" style={{ backgroundColor: ACCENT, color: '#fff' }}>
              {t('guides.common.cta_btn')}
              <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link to="/auth" className="inline-flex items-center font-semibold px-6 py-3.5 rounded-lg text-sm bg-white" style={{ border: `1px solid ${RULE}`, color: TEXT }}>
              {t('guides.common.cta_demo')}
            </Link>
          </div>
        </div>
      </section>

      <section className="max-w-3xl mx-auto px-6 pt-12">
        <p className="font-ledger text-[11px] uppercase tracking-[0.24em] mb-4" style={{ color: FAINT }}>{t('guides.common.more')}</p>
        <div className="grid sm:grid-cols-2 gap-3">
          {others.map((g) => (
            <Link key={g.slug} to={guidePath(g.slug)} className="group flex items-center justify-between rounded-xl px-5 py-4 transition-colors hover:bg-white" style={{ border: `1px solid ${RULE}` }}>
              <span className="font-semibold text-[15px]" style={{ color: TEXT }}>{g.name}</span>
              <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" style={{ color: ACCENT }} />
            </Link>
          ))}
        </div>
        <p className="mt-10 text-xs leading-relaxed" style={{ color: FAINT }}>{t('guides.common.disclaimer')}</p>
      </section>

      <PublicFooter />
    </div>
  );
}
