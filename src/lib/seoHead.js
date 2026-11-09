/**
 * Piezas PURAS del SEO estático (sin I/O) — las usa tools/generate-seo.js tras
 * `vite build` y las fijan tests.
 *
 * Por qué hace falta: Trazza es una SPA y el HTML que se sirve llevaba un
 * <head> genérico (`lang="en"`, sin descripción, sin Open Graph, sin canonical)
 * y un <body> vacío. Google ejecuta el JS, pero tarde y no siempre; las vistas
 * previas de WhatsApp/Telegram/LinkedIn y otros buscadores no lo ejecutan nunca.
 * Escribir el <head> de cada página pública al compilar lo arregla sin SSR.
 */

import { emptyRoot, PRERENDER_START, PRERENDER_END } from './prerender.js';

// Atributos/texto HTML: escapar `&` ANTES que el resto (I3). El fallo M2 de
// `$&` / `$1` en String.replace se cubre pasando función a .replace (injectHead),
// no dejando `&` sin escapar — eso alteraba títulos con «A & B».
const escAttr = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escText = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// XML (sitemap).
const escXml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Dentro de <script type="application/ld+json"> lo único peligroso es cerrar
// la etiqueta: se escapa "<" para que ningún texto (p. ej. de un artículo del
// blog) pueda colar un "</script>".
const safeJson = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');

// react-helmet reconoce como SUYAS las etiquetas con este atributo y las
// sustituye al navegar; sin él, al pasar de una página a otra quedarían dos
// canonical distintos y Google ignoraría ambos.
const H = 'data-react-helmet="true"';

/** Etiquetas del <head> de una página (sin <title>, que va aparte). */
/**
 * `noindex` (404, shell de la app): robots noindex y SIN canonical, igual que
 * `SeoHead` en el navegador — una página que no debe indexarse no puede
 * declararse canónica de nada.
 */
export function buildHeadTags({ title, description, url, type = 'website', siteName, image = null, ld = [], noindex = false }) {
  const tags = [];
  if (description) tags.push(`<meta ${H} name="description" content="${escAttr(description)}">`);
  if (noindex) tags.push(`<meta ${H} name="robots" content="noindex, nofollow">`);
  else tags.push(`<link ${H} rel="canonical" href="${escAttr(url)}">`);
  tags.push(`<meta ${H} property="og:site_name" content="${escAttr(siteName)}">`);
  tags.push(`<meta ${H} property="og:type" content="${escAttr(type)}">`);
  tags.push(`<meta ${H} property="og:title" content="${escAttr(title)}">`);
  if (description) tags.push(`<meta ${H} property="og:description" content="${escAttr(description)}">`);
  tags.push(`<meta ${H} property="og:url" content="${escAttr(url)}">`);
  tags.push(`<meta ${H} property="og:locale" content="es_ES">`);
  if (image) {
    tags.push(`<meta ${H} property="og:image" content="${escAttr(image.url)}">`);
    tags.push(`<meta ${H} property="og:image:width" content="${escAttr(image.width)}">`);
    tags.push(`<meta ${H} property="og:image:height" content="${escAttr(image.height)}">`);
    tags.push(`<meta ${H} property="og:image:alt" content="${escAttr(image.alt)}">`);
    tags.push(`<meta ${H} name="twitter:image" content="${escAttr(image.url)}">`);
  }
  tags.push(`<meta ${H} name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`);
  tags.push(`<meta ${H} name="twitter:title" content="${escAttr(title)}">`);
  if (description) tags.push(`<meta ${H} name="twitter:description" content="${escAttr(description)}">`);
  for (const obj of ld) tags.push(`<script ${H} type="application/ld+json">${safeJson(obj)}</script>`);
  return tags;
}

/**
 * Inserta título y etiquetas en el HTML de la build. Sustituye el <title>
 * genérico y fija `lang`. Lanza si el HTML no tiene la forma esperada: mejor
 * que la build falle a que se publique una página sin <head>.
 */
export function injectHead(html, { title, tags, lang = 'es' }) {
  if (!/<title>[\s\S]*?<\/title>/.test(html)) throw new Error('injectHead: el HTML no tiene <title>');
  if (!/<html[^>]*>/.test(html)) throw new Error('injectHead: el HTML no tiene <html>');
  // Reemplazo con función: si se pasa un string, String.replace interpreta
  // $', $`, $& y $n y corrompe títulos de carteras compartidas (M2).
  return html
    .replace(/<html[^>]*>/, () => `<html lang="${escAttr(lang)}">`)
    .replace(/<title>[\s\S]*?<\/title>/, () => `<title>${escText(title)}</title>\n\t\t${tags.join('\n\t\t')}`);
}

/**
 * Quita las etiquetas de Helmet que ya lleve el HTML. El server parte del
 * index.html publicado, que es el de la PORTADA con su <head> ya escrito:
 * inyectar encima otra descripción y otro og:title dejaría dos de cada, y los
 * generadores de vistas previas se quedan con el primero.
 */
export function stripHelmetTags(html) {
  return html
    .replace(/[ \t]*<script data-react-helmet="true"[^>]*>[\s\S]*?<\/script>\s*/g, '')
    .replace(/[ \t]*<(?:meta|link) data-react-helmet="true"[^>]*>\s*/g, '');
}

/**
 * El HTML del que generate-seo saca TODAS las páginas. Normalmente es el
 * index.html recién salido de vite, pero si el postbuild se ejecuta dos veces
 * (o sobre un dist/ ya publicado) dist/index.html es la PORTADA prerenderizada:
 * su <head> (Helmet) y su contenido dentro de #root se copiarían en cada página.
 * Se quitan los dos y, si aun así queda alguna marca de prerender (un #root que
 * emptyRoot no reconoce), se falla: mejor romper la build que publicar la
 * portada dentro de /blog.
 */
export function prepareBaseHtml(html) {
  const base = emptyRoot(stripHelmetTags(html));
  for (const mark of [PRERENDER_START, PRERENDER_END, 'data-prerender-path']) {
    if (base.includes(mark)) {
      throw new Error(`prepareBaseHtml: el index.html de partida sigue con prerender (${mark}) tras vaciar #root; vuelve a ejecutar vite build`);
    }
  }
  return base;
}

/**
 * dist/app.html: el shell NEUTRO de la SPA (lo servirá nginx para /app y /auth, y
 * como fallback de los /blog/<slug> publicados después del despliegue, cuando se
 * aplique deploy/nginx/example.com.conf; hoy solo lo usa el Express para
 * /share/:token). Sale del
 * index.html de la build ANTES de que generate-seo escriba la portada: `lang="es"`,
 * el título genérico de la app y #root vacío, SIN canonical ni robots — robots.txt
 * ya prohíbe /app y /auth, y un artículo nuevo no puede llevar noindex.
 */
export function buildAppShell(html, { title }) {
  if (!title) throw new Error('buildAppShell: falta el título de la app');
  return injectHead(prepareBaseHtml(html), { title, tags: [], lang: 'es' });
}

/** sitemap.xml a partir de [{ url, lastmod?, changefreq?, priority? }]. */
export function buildSitemap(entries) {
  const urls = entries.map((e) => [
    '  <url>',
    `    <loc>${escXml(e.url)}</loc>`,
    e.lastmod ? `    <lastmod>${escXml(e.lastmod)}</lastmod>` : null,
    e.changefreq ? `    <changefreq>${escXml(e.changefreq)}</changefreq>` : null,
    e.priority ? `    <priority>${escXml(e.priority)}</priority>` : null,
    '  </url>',
  ].filter(Boolean).join('\n'));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

/** robots.txt: todo indexable salvo la app privada y las carteras compartidas. */
export function buildRobots({ siteUrl, disallow = [] }) {
  return [
    'User-agent: *',
    'Allow: /',
    ...disallow.map((p) => `Disallow: ${p}`),
    '',
    `Sitemap: ${siteUrl}/sitemap.xml`,
    '',
  ].join('\n');
}

/** Ruta de salida dentro de dist/ para una ruta pública ('/' → index.html). */
export function outputPathFor(routePath) {
  const clean = routePath.replace(/^\/+|\/+$/g, '');
  return clean ? `${clean}/index.html` : 'index.html';
}
