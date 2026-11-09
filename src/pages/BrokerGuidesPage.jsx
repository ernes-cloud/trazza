import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRight } from 'lucide-react';
import SeoHead from '@/components/SeoHead';
import { TOOL_COLORS, PAPER_GRID, usePaperTheme, PublicHeader, PublicFooter } from '@/components/public/publicFrame';
import { BROKER_GUIDES, GUIDES_INDEX_PATH, guidePath } from '@/lib/brokerGuides';

const { TEXT, MUTED, FAINT, RULE, ACCENT } = TOOL_COLORS;

/** Índice de las guías por broker (/guias). Tema FIJO: nada de `dark:`. */
export default function BrokerGuidesPage() {
  const { t, i18n } = useTranslation();
  usePaperTheme();

  return (
    <div className="min-h-screen antialiased" style={{ ...PAPER_GRID, color: TEXT }}>
      <SeoHead path={GUIDES_INDEX_PATH} title={t('guides.index.title')} description={t('guides.index.meta')} lang={i18n.language} />
      <PublicHeader backLabel={t('guides.common.back_home')} />

      <section className="max-w-5xl mx-auto px-6 pt-14 md:pt-20 pb-10">
        <div className="flex items-center gap-3 mb-6">
          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: ACCENT }} />
          <span className="font-ledger text-[11px] uppercase tracking-[0.24em]" style={{ color: FAINT }}>{t('guides.common.eyebrow')}</span>
        </div>
        <h1 className="font-display font-black tracking-tight leading-[1.05] text-[2.4rem] md:text-6xl max-w-3xl" style={{ color: TEXT }}>
          {t('guides.index.h1')}
        </h1>
        <p className="mt-6 text-lg leading-relaxed max-w-2xl" style={{ color: MUTED }}>{t('guides.index.intro')}</p>
      </section>

      <section className="max-w-5xl mx-auto px-6 pb-16 grid sm:grid-cols-2 gap-4">
        {BROKER_GUIDES.map((g) => (
          <Link
            key={g.slug}
            to={guidePath(g.slug)}
            className="group rounded-2xl bg-white px-6 py-6 transition-transform hover:-translate-y-0.5"
            style={{ border: `1px solid ${RULE}`, boxShadow: '0 12px 30px rgba(15,23,42,0.06)' }}
          >
            <h2 className="font-display text-2xl font-black tracking-tight" style={{ color: TEXT }}>{g.name}</h2>
            <p className="mt-2 text-[15px] leading-relaxed" style={{ color: MUTED }}>{t(`guides.${g.key}.card`)}</p>
            <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-bold" style={{ color: ACCENT }}>
              {t('guides.index.read')}
              <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
            </span>
          </Link>
        ))}
      </section>

      <section className="max-w-5xl mx-auto px-6 pb-4">
        <p className="text-xs leading-relaxed max-w-3xl" style={{ color: FAINT }}>{t('guides.common.disclaimer')}</p>
      </section>

      <PublicFooter />
    </div>
  );
}
