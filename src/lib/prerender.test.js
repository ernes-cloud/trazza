import { describe, it, expect } from 'vitest';
import {
  stripNoPrerender, injectRoot, emptyRoot, samePrerenderPath, bootsFromPrerender, prerenderBootMode,
  isDataRoute, routesFromSitemap, PRERENDER_START, PRERENDER_END,
  hoistInlineStyles, linkPrerenderStylesheet, shortHash,
} from './prerender.js';

const SHELL = '<!doctype html><html lang="es"><head><title>T</title></head><body><div id="root"></div></body></html>';

describe('stripNoPrerender', () => {
  it('quita el elemento marcado con todo lo que lleva dentro, aunque anide su misma etiqueta', () => {
    const html = '<main><h1>Hola</h1></main><div data-no-prerender="true" class="fixed"><div><p>Cookies</p></div><div>x</div></div><footer>pie</footer>';
    expect(stripNoPrerender(html)).toBe('<main><h1>Hola</h1></main><footer>pie</footer>');
  });

  it('acepta el atributo sin valor, con comillas simples y varios elementos marcados', () => {
    const html = "<p>a</p><section data-no-prerender>b<section>c</section></section><p>d</p><aside data-no-prerender='1'>e</aside>";
    expect(stripNoPrerender(html)).toBe('<p>a</p><p>d</p>');
  });

  it('un elemento vacío (void) marcado sale solo él', () => {
    expect(stripNoPrerender('<p>a<img data-no-prerender src="x.png">b</p>')).toBe('<p>ab</p>');
  });

  it('no confunde un atributo que solo se le parece', () => {
    const html = '<div data-no-prerender-x="1">se queda</div>';
    expect(stripNoPrerender(html)).toBe(html);
  });

  it('sin nada marcado, el HTML no cambia', () => {
    expect(stripNoPrerender('<h1>x</h1>')).toBe('<h1>x</h1>');
  });
});

describe('injectRoot / emptyRoot', () => {
  it('mete el HTML dentro de #root, con la ruta y las marcas de inicio y fin', () => {
    const out = injectRoot(SHELL, '<h1>Calculadora</h1>', '/calculadora-fire');
    expect(out).toContain(`<div id="root" data-prerender-path="/calculadora-fire">${PRERENDER_START}<h1>Calculadora</h1>${PRERENDER_END}</div>`);
    expect(out).toContain('<title>T</title>');
  });

  it('un "$&" del contenido no se interpreta como patrón de reemplazo', () => {
    expect(injectRoot(SHELL, '<p>cuesta $& y $1</p>', '/x')).toContain('<p>cuesta $& y $1</p>');
  });

  it('volver a prerenderizar sustituye lo anterior, no lo anida', () => {
    const once = injectRoot(SHELL, '<h1>v1</h1>', '/x');
    const twice = injectRoot(once, '<h1>v2</h1>', '/x');
    expect(twice).toContain('<h1>v2</h1>');
    expect(twice).not.toContain('v1');
  });

  it('emptyRoot deja #root vacío (el shell que usan /app, /auth y /share)', () => {
    const html = injectRoot(SHELL, '<div><div>landing</div></div>', '/');
    expect(emptyRoot(html)).toBe(SHELL);
    expect(emptyRoot(SHELL)).toBe(SHELL);
  });

  it('falla si el HTML no tiene #root: mejor romper la build que publicar una página vacía', () => {
    expect(() => injectRoot('<html><body></body></html>', '<h1>x</h1>', '/x')).toThrow(/root/);
  });
});

describe('bootsFromPrerender (main.jsx)', () => {
  it('misma ruta, con o sin barra final', () => {
    expect(samePrerenderPath('/guias/degiro', '/guias/degiro/')).toBe(true);
    expect(samePrerenderPath('/', '/')).toBe(true);
    expect(samePrerenderPath('/blog', '/blog/x')).toBe(false);
    expect(samePrerenderPath(undefined, '/')).toBe(false);
  });

  it('la 404 prerenderizada vale para CUALQUIER URL: nginx solo sirve 404.html si no hay fichero', () => {
    expect(bootsFromPrerender({ prerenderPath: '/404', pathname: '/xyz' })).toBe(true);
    // /guias/<inexistente>: el router casa /guias/:slug (no es "notFound" para
    // matchPublicRoute), pero BrokerGuidePage pinta NotFoundPage: la 404 es SU HTML.
    expect(bootsFromPrerender({ prerenderPath: '/404', pathname: '/guias/no-existe' })).toBe(true);
    expect(bootsFromPrerender({ prerenderPath: '/404/', pathname: '/blog/x' })).toBe(true);
    expect(bootsFromPrerender({ prerenderPath: '/calculadora-fire', pathname: '/calculadora-fire' })).toBe(true);
    expect(bootsFromPrerender({ prerenderPath: undefined, pathname: '/app' })).toBe(false);
  });
});

describe('prerenderBootMode (qué hace main.jsx con #root)', () => {
  it('reuse: el HTML es el de esta URL → precargar la ruta y que React lo sustituya sin spinner', () => {
    expect(prerenderBootMode({ prerenderPath: '/calculadora-fire', pathname: '/calculadora-fire/' })).toBe('reuse');
    expect(prerenderBootMode({ prerenderPath: '/404', pathname: '/xyz' })).toBe('reuse');
  });

  it('reuse con 404.html en /guias/<inexistente>: la 404 se queda hasta que React pinta (antes, blanco)', () => {
    expect(prerenderBootMode({ prerenderPath: '/404', pathname: '/guias/no-existe' })).toBe('reuse');
    expect(prerenderBootMode({ prerenderPath: '/404', pathname: '/blog/no-existe' })).toBe('reuse');
  });

  it('discard: el HTML es de OTRA ruta (la portada como fallback de /app en vite preview) → vaciar #root antes de montar', () => {
    expect(prerenderBootMode({ prerenderPath: '/', pathname: '/app/brokers' })).toBe('discard');
    expect(prerenderBootMode({ prerenderPath: '/', pathname: '/blog/nuevo' })).toBe('discard');
    expect(prerenderBootMode({ prerenderPath: '/calculadora-fire', pathname: '/guias/degiro' })).toBe('discard');
  });

  it('none: #root llega vacío (app.html, build sin prerender)', () => {
    expect(prerenderBootMode({ prerenderPath: undefined, pathname: '/app' })).toBe('none');
    expect(prerenderBootMode({ prerenderPath: '', pathname: '/' })).toBe('none');
  });
});

describe('rutas a prerenderizar', () => {
  it('salen del sitemap (rutas relativas, en orden) y la portada va la última', () => {
    const xml = '<urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/blog</loc></url><url><loc>https://example.com/blog/twr</loc></url></urlset>';
    expect(routesFromSitemap(xml, 'https://example.com')).toEqual(['/blog', '/blog/twr', '/']);
  });

  it('el blog depende de Supabase al compilar; el resto, no', () => {
    expect(isDataRoute('/blog')).toBe(true);
    expect(isDataRoute('/blog/twr')).toBe(true);
    expect(isDataRoute('/blogger')).toBe(false);
    expect(isDataRoute('/calculadora-fire')).toBe(false);
  });
});

describe('hoistInlineStyles — el HTML prerenderizado sin un solo style="…" (CSP sin unsafe-inline)', () => {
  it('cambia cada style por una clase y deja la regla con !important en la hoja', () => {
    const { html, css, count } = hoistInlineStyles('<div class="p-4" style="color: rgb(1, 2, 3); opacity: 0.5;">x</div>');
    expect(html).not.toMatch(/style=/);
    const cls = html.match(/class="p-4 (ps-[a-z0-9-]+)"/)[1];
    expect(css).toBe(`.${cls}{color: rgb(1, 2, 3) !important;opacity: 0.5 !important}\n`);
    expect(count).toBe(1);
  });

  it('el mismo style en varios elementos comparte clase; uno distinto, clase distinta', () => {
    const { html, css } = hoistInlineStyles('<p style="color: red;">a</p><p style="color: red;">b</p><span style="color: blue;">c</span>');
    const classes = [...html.matchAll(/class="([^"]+)"/g)].map((m) => m[1]);
    expect(classes[0]).toBe(classes[1]);
    expect(classes[2]).not.toBe(classes[0]);
    expect(css.trim().split('\n')).toHaveLength(2);
  });

  it('elementos sin class, SVG, autocerrados y el style antes que el class', () => {
    const { html } = hoistInlineStyles('<svg style="width: 4px;"><path style="fill: red;" d="M0"/></svg><i style="x: 1" class="a"></i><br style="clear: both">');
    expect(html).not.toMatch(/style=/);
    expect(html).toMatch(/^<svg class="ps-[a-z0-9]+">/);
    expect(html).toMatch(/<path class="ps-[a-z0-9]+" d="M0"\/>/);
    expect(html).toMatch(/<i class="a ps-[a-z0-9]+"><\/i>/);
    expect(html).toMatch(/<br class="ps-[a-z0-9]+">$/);
  });

  it('decodifica las entidades del atributo y no parte por el ; de un data: URI ni de unas comillas', () => {
    const style = 'font-family: &quot;Inter&quot;, sans-serif; background-image: url(&quot;data:image/svg+xml;base64,AAA=&quot;); content: &quot;a;b&quot;';
    const { css } = hoistInlineStyles(`<div style="${style}"></div>`);
    expect(css).toContain('font-family: "Inter", sans-serif !important');
    expect(css).toContain('background-image: url("data:image/svg+xml;base64,AAA=") !important');
    expect(css).toContain('content: "a;b" !important');
  });

  it('no toca el texto ni el contenido de <script>/<style>', () => {
    const src = '<p>a &lt;b style="x"&gt;</p><script type="application/ld+json">{"a":"<i style=\\"x\\">"}</script>';
    expect(hoistInlineStyles(src).html).toBe(src);
  });

  it('style vacío: se quita sin añadir clase ni regla', () => {
    expect(hoistInlineStyles('<div style=""></div>')).toEqual({ html: '<div></div>', css: '', count: 0 });
  });

  it('shortHash es estable (las clases no cambian entre builds con el mismo HTML)', () => {
    expect(shortHash('color: red !important')).toBe(shortHash('color: red !important'));
    expect(shortHash('a')).not.toBe(shortHash('b'));
  });
});

describe('linkPrerenderStylesheet', () => {
  const page = '<html><head><title>T</title></head><body></body></html>';
  it('enlaza la hoja antes de </head> y sustituye la de un prerender anterior', () => {
    const once = linkPrerenderStylesheet(page, '/assets/prerender-abc.css');
    expect(once).toBe('<html><head><title>T</title><link rel="stylesheet" href="/assets/prerender-abc.css"></head><body></body></html>');
    const twice = linkPrerenderStylesheet(once, '/assets/prerender-def.css');
    expect(twice.match(/prerender-/g)).toHaveLength(1);
    expect(twice).toContain('/assets/prerender-def.css');
  });
  it('sin hoja (página sin estilos inline) solo quita la anterior', () => {
    expect(linkPrerenderStylesheet(linkPrerenderStylesheet(page, '/assets/prerender-abc.css'), null)).toBe(page);
  });
});
