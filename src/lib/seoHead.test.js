import { describe, it, expect } from 'vitest';
import { buildHeadTags, injectHead, buildSitemap, buildRobots, outputPathFor, stripHelmetTags, buildAppShell, prepareBaseHtml } from './seoHead.js';
import { injectRoot } from './prerender.js';
import { absoluteUrl, PUBLIC_PAGES, NOINDEX_PREFIXES, ROBOTS_DISALLOW, structuredDataFor, NOT_FOUND_PAGE } from './siteMeta.js';
import { loadMergedLocale } from '../i18n/loadMergedLocale.js';

const es = loadMergedLocale('es');
const en = loadMergedLocale('en');

const BUILD_HTML = '<!doctype html>\n<html lang="en">\n<head>\n<title>Trazza - Seguimiento de Cartera Profesional</title>\n</head><body><div id="root"></div></body></html>';

describe('siteMeta', () => {
  it('las URLs canónicas son del dominio REAL, nunca de trazza.app', () => {
    // Caso real 2026-10-03: la calculadora declaraba https://trazza.app/… (otra web).
    expect(absoluteUrl('/calculadora-interes-compuesto')).toBe('https://example.com/calculadora-interes-compuesto');
    expect(absoluteUrl('/')).toBe('https://example.com/');
    expect(absoluteUrl('/blog/')).toBe('https://example.com/blog');
  });

  it('ninguna página pública cae en una ruta que no debe indexarse', () => {
    for (const p of PUBLIC_PAGES) {
      expect(NOINDEX_PREFIXES.some((pre) => p.path.startsWith(pre))).toBe(false);
    }
  });

  it('la calculadora y la portada llevan datos estructurados válidos', () => {
    const ld = structuredDataFor('calculator', { title: 'T', description: 'D', url: 'U' });
    expect(ld[0]['@type']).toBe('WebApplication');
    expect(ld[0].offers.price).toBe('0');
    expect(structuredDataFor('app', { title: 'T', description: 'D', url: 'U' }).map((o) => o['@type'])).toEqual(['WebApplication', 'Organization']);
  });
});

describe('injectHead', () => {
  const tags = buildHeadTags({ title: 'Calculadora', description: 'Simula "tu" inversión <gratis>', url: 'https://example.com/x', siteName: 'Trazza' });

  it('sustituye el título genérico, fija lang="es" y añade las etiquetas', () => {
    const html = injectHead(BUILD_HTML, { title: 'Calculadora — Trazza', tags });
    expect(html).toContain('<html lang="es">');
    expect(html).toContain('<title>Calculadora — Trazza</title>');
    expect(html).not.toContain('Seguimiento de Cartera Profesional');
    expect(html).toContain('<link data-react-helmet="true" rel="canonical" href="https://example.com/x">');
  });

  it('escapa comillas y < > en los atributos', () => {
    const html = injectHead(BUILD_HTML, { title: 'X', tags });
    expect(html).toContain('content="Simula &quot;tu&quot; inversión &lt;gratis&gt;"');
  });

  it('marca todo como de react-helmet, para que al navegar se sustituya y no se duplique', () => {
    expect(tags.every((t) => t.includes('data-react-helmet="true"'))).toBe(true);
  });

  it('un texto con </script> no puede cerrar el JSON-LD', () => {
    const [ld] = buildHeadTags({ title: 'X', url: 'u', siteName: 'S', ld: [{ name: '</script><script>alert(1)</script>' }] })
      .filter((t) => t.includes('ld+json'));
    expect(ld.match(/<\/script>/g)).toHaveLength(1); // solo el cierre propio
  });

  it('falla en voz alta si el HTML de la build no tiene la forma esperada', () => {
    expect(() => injectHead('<html><body></body></html>', { title: 'X', tags: [] })).toThrow();
  });

  // String.replace interpreta $', $`, $& y $n en la cadena de reemplazo si se
  // pasa como string (no como función). Un título de cartera compartida con
  // esos caracteres corrompía <title> y og:title (M2).
  // I3: escAttr/escText vuelven a escapar `&` → en HTML el literal `$&` se ve
  // como `$&amp;`. El test TDD pedía `$&` sin escapar para forzar el bug; la
  // expectativa correcta (y segura) es `$&amp;`. El replace por función ya
  // evita la corrupción de $' / $` / $1.
  it('injectHead no interpreta patrones $ en el título', () => {
    const title = "Mi cartera $' fin $` mid $& all $1 grp";
    const html = injectHead(BUILD_HTML, { title, tags: [] });
    expect(html).toContain(`<title>${title.replace(/&/g, '&amp;')}</title>`);
    // El resto del documento (body / #root) sigue intacto.
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('<!doctype html>');
  });

  it('injectHead no interpreta $ en tags/og:title', () => {
    const title = "Cartera $' $` $& $1";
    const escaped = title.replace(/&/g, '&amp;');
    const tags = buildHeadTags({
      title,
      description: 'desc',
      url: 'https://example.com/share/x',
      siteName: 'Trazza',
    });
    const html = injectHead(BUILD_HTML, { title, tags });
    expect(html).toContain(`property="og:title" content="${escaped}"`);
    expect(html).toContain(`name="twitter:title" content="${escaped}"`);
    expect(html).toContain('<div id="root"></div>');
  });
});

describe('imagen de vista previa', () => {
  it('con imagen: og:image con medidas y tarjeta grande de Twitter', () => {
    const tags = buildHeadTags({ title: 'X', url: 'u', siteName: 'S', image: { url: 'https://example.com/og-image.png?v=1', width: 1200, height: 630, alt: 'A' } }).join(' ');
    expect(tags).toContain('property="og:image" content="https://example.com/og-image.png?v=1"');
    expect(tags).toContain('property="og:image:width" content="1200"');
    expect(tags).toContain('name="twitter:card" content="summary_large_image"');
  });

  it('sin imagen: tarjeta pequeña y sin og:image', () => {
    const tags = buildHeadTags({ title: 'X', url: 'u', siteName: 'S' }).join(' ');
    expect(tags).not.toContain('og:image');
    expect(tags).toContain('name="twitter:card" content="summary"');
  });
});

describe('sitemap y robots', () => {
  it('genera un sitemap con loc, lastmod y prioridad', () => {
    const xml = buildSitemap([{ url: 'https://example.com/', priority: '1.0' }, { url: 'https://example.com/blog/a&b', lastmod: '2026-07-11' }]);
    expect(xml).toContain('<loc>https://example.com/</loc>');
    expect(xml).toContain('<loc>https://example.com/blog/a&amp;b</loc>');
    expect(xml).toContain('<lastmod>2026-07-11</lastmod>');
    expect(xml.startsWith('<?xml')).toBe(true);
  });

  it('robots.txt permite todo menos la app privada y apunta al sitemap', () => {
    const txt = buildRobots({ siteUrl: 'https://example.com', disallow: ['/app', '/share/'] });
    expect(txt).toContain('User-agent: *');
    expect(txt).toContain('Disallow: /app');
    expect(txt).toContain('Sitemap: https://example.com/sitemap.xml');
  });

  it('cada ruta pública se escribe en su carpeta', () => {
    expect(outputPathFor('/')).toBe('index.html');
    expect(outputPathFor('/calculadora-interes-compuesto')).toBe('calculadora-interes-compuesto/index.html');
    expect(outputPathFor('/blog/mi-post')).toBe('blog/mi-post/index.html');
  });
});

describe('stripHelmetTags (vista previa de carteras compartidas)', () => {
  it('quita el <head> de la portada para que no quede duplicado', () => {
    const tags = buildHeadTags({ title: 'Portada', description: 'Desc', url: absoluteUrl('/'), siteName: 'Trazza', ld: [{ a: 1 }] });
    const landing = injectHead(BUILD_HTML, { title: 'Portada', tags });
    const stripped = stripHelmetTags(landing);
    expect(stripped).not.toMatch(/data-react-helmet/);
    const share = injectHead(stripped, { title: 'Cartera', tags: buildHeadTags({ title: 'Cartera', description: 'D2', url: absoluteUrl('/share/x'), siteName: 'Trazza' }) });
    expect(share.match(/name="description"/g)).toHaveLength(1);
    expect(share.match(/rel="canonical"/g)).toHaveLength(1);
    expect(share).toMatch(/<div id="root"><\/div>/);
  });

  it('robots.txt deja leer /share (para las vistas previas) pero no la app', () => {
    expect(ROBOTS_DISALLOW).not.toContain('/share');
    expect(ROBOTS_DISALLOW).toContain('/app');
    expect(NOINDEX_PREFIXES).toContain('/share');
  });
});

describe('página 404', () => {
  const get = (obj, key) => key.split('.').reduce((o, k) => o?.[k], obj);

  it('NO está en PUBLIC_PAGES: no entra en el sitemap ni se declara indexable', () => {
    expect(PUBLIC_PAGES.some((p) => p.path === NOT_FOUND_PAGE.path)).toBe(false);
  });

  it('sus claves de título y descripción existen en es y en', () => {
    for (const key of [NOT_FOUND_PAGE.titleKey, NOT_FOUND_PAGE.descKey]) {
      expect(typeof get(es, key)).toBe('string');
      expect(typeof get(en, key)).toBe('string');
    }
  });

  it('buildHeadTags con noindex: robots noindex y sin canonical (igual que SeoHead)', () => {
    const tags = buildHeadTags({ title: 'No existe', description: 'D', url: 'https://example.com/404', siteName: 'Trazza', noindex: true }).join('\n');
    expect(tags).toContain('<meta data-react-helmet="true" name="robots" content="noindex, nofollow">');
    expect(tags).not.toContain('rel="canonical"');
  });
});

describe('prepareBaseHtml (generate-seo idempotente: dist/index.html puede venir ya prerenderizado)', () => {
  // Lo que deja una build completa en dist/index.html: <head> de la portada
  // (Helmet) y la portada dentro de #root. Un segundo postbuild parte de ahí.
  const homeTags = buildHeadTags({ title: 'Portada', description: 'desc portada', url: absoluteUrl('/'), siteName: 'Trazza' });
  const prerenderedHome = injectRoot(
    injectHead(BUILD_HTML, { title: 'Portada', tags: homeTags }),
    '<main><h1>Titular de la portada</h1></main>',
    '/',
  );

  it('la página de /blog que sale de la portada prerenderizada lleva #root vacío y nada de la portada', () => {
    const base = prepareBaseHtml(prerenderedHome);
    const blogTags = buildHeadTags({ title: 'Blog', description: 'desc blog', url: absoluteUrl('/blog'), siteName: 'Trazza' });
    const blog = injectHead(base, { title: 'Blog', tags: blogTags });
    expect(blog).toContain('<div id="root"></div>');
    expect(blog).not.toContain('Titular de la portada');
    expect(blog).not.toContain('data-prerender-path');
    expect(blog).not.toContain('prerender:start');
    expect(blog).not.toContain('desc portada');
    expect(blog.match(/rel="canonical"/g)).toHaveLength(1);
    expect(blog).toContain(`href="${absoluteUrl('/blog')}"`);
  });

  it('con el HTML original de vite no cambia nada', () => {
    expect(prepareBaseHtml(BUILD_HTML)).toBe(BUILD_HTML);
  });

  it('falla en voz alta si tras vaciar #root quedan marcas de prerender', () => {
    const broken = BUILD_HTML.replace('<div id="root"></div>', '<div id="root" data-prerender-path="/"><!--prerender:start--><h1>x</h1></div>');
    expect(() => prepareBaseHtml(broken)).toThrow(/prerender/);
    const stray = BUILD_HTML.replace('<div id="root"></div>', '<div id="root" data-prerender-path="/"></div>');
    expect(() => prepareBaseHtml(stray)).toThrow(/data-prerender-path/);
  });
});

describe('buildAppShell (dist/app.html: el shell neutro de la SPA)', () => {
  const out = buildAppShell(BUILD_HTML, { title: es.app.title });

  it('lang="es" y el título genérico de la app, no el de la portada', () => {
    expect(out).toContain('<html lang="es">');
    expect(out).toContain(`<title>${es.app.title}</title>`);
    expect(out).not.toContain('Seguimiento de Cartera Profesional');
  });

  it('SIN canonical, robots ni etiquetas de Helmet: también es el fallback de los /blog/<slug> publicados después del despliegue, que no pueden llevar noindex', () => {
    expect(out).not.toContain('data-react-helmet');
    expect(out).not.toContain('rel="canonical"');
    expect(out).not.toContain('name="robots"');
  });

  it('#root vacío aunque el HTML de partida trajera prerender', () => {
    expect(out).toContain('<div id="root"></div>');
    const prerendered = BUILD_HTML.replace('<div id="root"></div>', '<div id="root" data-prerender-path="/"><!--prerender:start--><h1>x</h1><!--prerender:end--></div>');
    expect(buildAppShell(prerendered, { title: 'T' })).toContain('<div id="root"></div>');
  });

  it('falla en voz alta si falta el título', () => {
    expect(() => buildAppShell(BUILD_HTML, { title: '' })).toThrow(/título/);
  });
});
