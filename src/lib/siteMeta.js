/**
 * Metadatos de las páginas PÚBLICAS — una sola definición para dos consumidores:
 *   - `components/SeoHead.jsx` (Helmet, en el navegador), y
 *   - `tools/generate-seo.js` (al compilar: un HTML por página con su <head>
 *     ya escrito, sitemap.xml y robots.txt).
 * Si divergieran, Google leería un título en el HTML y otro tras ejecutar el JS.
 *
 * Node-compatible a propósito (sin alias `@/`): lo importa el script de build.
 *
 * Auditoría SEO 2026-10-03: la calculadora declaraba como canónica
 * https://trazza.app/… — OTRO dominio, de otra web —, robots.txt y sitemap.xml
 * devolvían el HTML de la app, y el HTML que recibe un buscador no llevaba ni
 * descripción, ni Open Graph, ni `lang` correcto.
 */

import { BROKER_GUIDES, GUIDES_INDEX_PATH, GUIDES_UPDATED, guidePath } from './brokerGuides.js';
import { getAppUrl, SITE_URL, absoluteUrl as absoluteUrlFromApp } from './appUrl.js';

export { SITE_URL };
export const SITE_NAME = 'Trazza';

/**
 * Imagen de las vistas previas (WhatsApp, Telegram, LinkedIn, X): 1200×630.
 * La versión va en la URL porque nginx cachea los .png un año (immutable): si
 * cambia la imagen, sube el número o seguirá saliendo la vieja.
 */
export const OG_IMAGE = {
  get url() {
    return `${getAppUrl()}/og-image.png?v=1`;
  },
  width: 1200,
  height: 630,
  alt: 'Trazza — seguimiento de cartera de inversión multi-broker',
};

/** URL absoluta y canónica de una ruta ('/' → site origin + path). */
export function absoluteUrl(path = '/') {
  return absoluteUrlFromApp(path);
}

/**
 * Páginas públicas indexables. `titleKey`/`descKey` son claves de los JSON de
 * i18n; el HTML estático usa la versión en español (el público de Trazza).
 */
export const PUBLIC_PAGES = [
  { path: '/calculadora-interes-compuesto', titleKey: 'calc_page.title', descKey: 'calc_page.meta', priority: '0.9', changefreq: 'monthly', schema: 'calculator' },
  { path: '/calculadora-dividendos', titleKey: 'div_calc.title', descKey: 'div_calc.meta', priority: '0.9', changefreq: 'monthly', schema: 'calculator' },
  { path: '/calculadora-fire', titleKey: 'fire_calc.title', descKey: 'fire_calc.meta', priority: '0.9', changefreq: 'monthly', schema: 'calculator' },
  { path: '/calculadora-plusvalias', titleKey: 'cg_calc.title', descKey: 'cg_calc.meta', priority: '0.9', changefreq: 'monthly', schema: 'calculator' },
  { path: '/calculadora-renta-broker', titleKey: 'renta_calc.title', descKey: 'renta_calc.meta', priority: '0.9', changefreq: 'monthly', schema: 'calculator' },
  { path: '/contact', titleKey: 'contact.page_title', descKey: 'contact.meta_description', priority: '0.3', changefreq: 'yearly' },
  // Guías por broker (lib/brokerGuides.js; en src/lib porque el server importa siteMeta y en el VPS solo se copian src/lib y src/services): exportar y declarar.
  { path: GUIDES_INDEX_PATH, titleKey: 'guides.index.title', descKey: 'guides.index.meta', priority: '0.8', changefreq: 'monthly' },
  ...BROKER_GUIDES.map((g) => ({
    path: guidePath(g.slug), titleKey: `guides.${g.key}.title`, descKey: `guides.${g.key}.meta`,
    priority: '0.8', changefreq: 'monthly', schema: 'article',
  })),
];

/**
 * La página 404 (`NotFoundPage`, ruta comodín del router). NO va en
 * PUBLIC_PAGES a propósito: no entra en el sitemap y se sirve con `noindex`.
 * `tools/generate-seo.js` escribe con estos textos `dist/404.html`. El estado
 * 404 real para cualquier URL que no exista llegará con
 * `deploy/nginx/example.com.conf` (`error_page 404 /404.html`) cuando se
 * aplique en el VPS; hasta entonces nginx responde 200 con la portada (un
 * "falso 404" para Google) y la SPA pinta la 404 al montar.
 */
export const NOT_FOUND_PAGE = { path: '/404', titleKey: 'not_found.title', descKey: 'not_found.meta' };

/**
 * Herramientas públicas gratuitas: se enlazan entre sí al pie de cada una
 * (PublicToolShell) y desde el pie de la landing. Cada una necesita además su
 * entrada en PUBLIC_PAGES.
 */
export const PUBLIC_TOOLS = [
  { path: '/calculadora-interes-compuesto', labelKey: 'tools.compound' },
  { path: '/calculadora-dividendos', labelKey: 'tools.dividends' },
  { path: '/calculadora-fire', labelKey: 'tools.fire' },
  { path: '/calculadora-plusvalias', labelKey: 'tools.capital_gains' },
  { path: '/calculadora-renta-broker', labelKey: 'tools.broker_csv' },
];

/** Rutas que NUNCA deben indexarse (la app privada y las carteras compartidas por enlace). */
export const NOINDEX_PREFIXES = ['/app', '/share', '/auth'];

/**
 * Lo que robots.txt prohíbe RASTREAR. No incluye `/share`: las carteras
 * compartidas siguen sin indexarse (el server las sirve con `noindex` en la
 * etiqueta y en la cabecera X-Robots-Tag), pero un `Disallow` impedía que X y
 * otros generadores de vistas previas, que sí respetan robots.txt, leyeran su
 * título y su imagen al pegar el enlace.
 */
export const ROBOTS_DISALLOW = ['/app', '/auth'];

/** Datos estructurados (JSON-LD) por tipo de página. */
export function structuredDataFor(schema, { title, description, url }) {
  const site = getAppUrl();
  if (schema === 'app') {
    return [
      {
        '@context': 'https://schema.org',
        '@type': 'WebApplication',
        name: SITE_NAME,
        url,
        description,
        applicationCategory: 'FinanceApplication',
        operatingSystem: 'Web',
        inLanguage: 'es',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
      },
      {
        '@context': 'https://schema.org',
        '@type': 'Organization',
        name: SITE_NAME,
        url: site,
        logo: `${site}/favicon.svg`,
      },
    ];
  }
  if (schema === 'article') {
    return [{
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: title,
      description,
      url,
      inLanguage: 'es',
      dateModified: GUIDES_UPDATED,
      author: { '@type': 'Organization', name: SITE_NAME, url: site },
      publisher: { '@type': 'Organization', name: SITE_NAME, logo: { '@type': 'ImageObject', url: `${site}/favicon.svg` } },
    }];
  }
  if (schema === 'calculator') {
    return [{
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      name: title,
      url,
      description,
      applicationCategory: 'FinanceApplication',
      operatingSystem: 'Web',
      inLanguage: 'es',
      isAccessibleForFree: true,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
    }];
  }
  return [];
}
