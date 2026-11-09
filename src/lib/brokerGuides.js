/**
 * Guías públicas por broker (/guias/<slug>): cómo exportar las operaciones y
 * cómo declararlas en la Renta. Los textos viven en i18n (`guides.<key>.*`,
 * con `guides.common` para lo compartido); aquí solo el catálogo, que también
 * leen siteMeta (sitemap + HTML estático) y el índice /guias.
 *
 * Es contenido fiscal: cada dato se contrastó al escribirlo (ver la fecha). Al
 * cambiar la normativa o un broker (Binance dejó España el 1-jul-2026), se
 * revisan los textos y `GUIDES_UPDATED`.
 */
export const GUIDES_UPDATED = '2026-10-17';

export const BROKER_GUIDES = [
  { slug: 'degiro', key: 'degiro', name: 'DEGIRO' },
  { slug: 'interactive-brokers', key: 'ibkr', name: 'Interactive Brokers' },
  { slug: 'trading-212', key: 't212', name: 'Trading 212' },
  { slug: 'myinvestor', key: 'myinvestor', name: 'MyInvestor' },
  { slug: 'binance', key: 'binance', name: 'Binance' },
];

export const GUIDES_INDEX_PATH = '/guias';
export const guidePath = (slug) => `${GUIDES_INDEX_PATH}/${slug}`;
export const findGuide = (slug) => BROKER_GUIDES.find((g) => g.slug === slug) || null;
