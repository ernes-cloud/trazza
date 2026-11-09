/**
 * Piezas PURAS del prerender de la web pública (sin I/O, Node-compatible: las
 * usan `tools/prerender.mjs` al compilar, `main.jsx` al arrancar y el server).
 *
 * Qué resuelve: las páginas públicas se servían con `<div id="root"></div>`
 * vacío. Google ejecuta el JS, tarde y no siempre; los generadores de vistas
 * previas, otros buscadores y los lectores de IA no lo ejecutan nunca. Desde
 * 2026-10-17 el postbuild abre cada página en Chromium y guarda el contenido de
 * #root en su HTML. El <head> sigue saliendo SOLO de generate-seo (siteMeta).
 *
 * En el navegador NO se hidrata (createRoot, no hydrateRoot): React sustituye
 * ese HTML en su primer render, así que una diferencia entre lo prerenderizado
 * y lo que pinta el cliente (idioma guardado en EN, tamaños de Recharts,
 * animaciones) no rompe nada. Ver docs/claude/public-site.md → Prerender.
 */

export const PRERENDER_START = '<!--prerender:start-->';
export const PRERENDER_END = '<!--prerender:end-->';
/** Atributo para lo que nunca debe quedar en el HTML estático (banner de cookies…). */
export const NO_PRERENDER_ATTR = 'data-no-prerender';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const MARKED_RE = /<([a-zA-Z][\w-]*)\b[^>]*?\sdata-no-prerender(?=[\s=>/])[^>]*>/;

const escAttr = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Quita del HTML (el innerHTML de #root, que escribe React: bien formado) cada
 * elemento con `data-no-prerender` y todo lo que lleva dentro.
 */
export function stripNoPrerender(html) {
  let out = html;
  for (let m = out.match(MARKED_RE); m; m = out.match(MARKED_RE)) {
    const start = m.index;
    const tag = m[1].toLowerCase();
    const openEnd = start + m[0].length;
    if (VOID.has(tag) || m[0].endsWith('/>')) { out = out.slice(0, start) + out.slice(openEnd); continue; }
    const tagRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
    tagRe.lastIndex = openEnd;
    let depth = 1;
    let end = -1;
    for (let t = tagRe.exec(out); t; t = tagRe.exec(out)) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) { end = t.index + t[0].length; break; }
    }
    if (end < 0) throw new Error(`stripNoPrerender: <${tag} ${NO_PRERENDER_ATTR}> sin cerrar`);
    out = out.slice(0, start) + out.slice(end);
  }
  return out;
}

const ROOT_FILLED_RE = /<div id="root"[^>]*>[\s\S]*?<!--prerender:end--><\/div>/;

/** Deja #root vacío: el shell de la SPA para /app, /auth y /share. */
export function emptyRoot(html) {
  return html.replace(ROOT_FILLED_RE, '<div id="root"></div>');
}

/** Mete `rootHtml` en #root, con la ruta de la que sale y las marcas de inicio y fin. */
export function injectRoot(html, rootHtml, routePath) {
  const base = emptyRoot(html);
  if (!base.includes('<div id="root"></div>')) throw new Error('injectRoot: el HTML no tiene un <div id="root"></div>');
  const filled = `<div id="root" data-prerender-path="${escAttr(routePath)}">${PRERENDER_START}${rootHtml}${PRERENDER_END}</div>`;
  return base.replace('<div id="root"></div>', () => filled);
}

const normPath = (p) => (String(p).replace(/\/+$/, '') || '/');

export function samePrerenderPath(prerenderPath, pathname) {
  if (!prerenderPath) return false;
  return normPath(prerenderPath) === normPath(pathname);
}

/**
 * ¿El HTML que trae la página es el de ESTA URL? Si lo es, main.jsx precarga
 * el chunk de la ruta antes del primer render y React lo sustituye sin pasar
 * por el spinner de Suspense.
 *
 * La 404 prerenderizada vale para CUALQUIER URL: nginx solo sirve 404.html
 * cuando la URL no tiene fichero, y una ruta válida de la web pública siempre lo
 * tiene (o cae en app.html: /app, /auth, /blog/<slug>). Incluye las que el router
 * casa por parámetro pero acaban en NotFoundPage (/guias/<inexistente>:
 * BrokerGuidePage la pinta); antes se descartaba y se veía en blanco hasta montar.
 */
export function bootsFromPrerender({ prerenderPath, pathname }) {
  if (!prerenderPath) return false;
  if (normPath(prerenderPath) === '/404') return true;
  return samePrerenderPath(prerenderPath, pathname);
}

/**
 * Qué hace main.jsx con lo que trae #root:
 *   - 'reuse'   → es el HTML de esta URL: precarga la ruta y React lo sustituye.
 *               La 404 (404.html) siempre es 'reuse' (ver bootsFromPrerender).
 *   - 'discard' → es de OTRA ruta (el index.html de la portada como fallback
 *                 de /app en vite preview, o con la config vieja de nginx): se
 *                 vacía antes de montar, o se vería la otra página.
 *   - 'none'    → #root llega vacío (app.html, build sin prerender).
 */
export function prerenderBootMode({ prerenderPath, pathname }) {
  if (!prerenderPath) return 'none';
  return bootsFromPrerender({ prerenderPath, pathname }) ? 'reuse' : 'discard';
}

/** Rutas que dependen de Supabase al compilar: si fallan, se quedan sin prerender (solo <head>). */
export function isDataRoute(routePath) {
  const p = normPath(routePath);
  return p === '/blog' || p.startsWith('/blog/');
}

/** Rutas del sitemap, relativas; la portada al final (el index.html lo usa de base la SPA). */
export function routesFromSitemap(xml, siteUrl) {
  const routes = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => {
    const url = m[1].trim();
    return normPath(url.startsWith(siteUrl) ? url.slice(siteUrl.length) || '/' : new URL(url).pathname);
  });
  return [...routes.filter((r) => r !== '/'), ...routes.filter((r) => r === '/')];
}

// ── Estilos inline → hoja propia (CSP sin 'unsafe-inline' en style-src) ──────
//
// El HTML prerenderizado es el DOM serializado por Chromium: React y
// framer-motion dejan cientos de `style="…"` (308 en la portada). Con
// `style-src` sin 'unsafe-inline' (2026-10-26, auditoría 7f2c915d M1) el
// navegador no aplica NINGUNO y escribe un error de CSP por cada uno. Lo que
// pinta React después no tiene el problema: asigna los estilos por CSSOM, que
// la CSP no restringe — por eso solo hay que arreglar el HTML estático.
//
// Cada `style` distinto pasa a una clase `ps-<hash>` en una hoja de /assets.
// `!important` en cada declaración: un `style` inline gana a cualquier clase
// normal, y la regla movida tiene que seguir ganándoles (Tailwind incluido).

const STYLE_CLASS_PREFIX = 'ps-';
export const PRERENDER_CSS_LINK_RE = /<link rel="stylesheet" href="\/assets\/prerender-[a-z0-9]+\.css">/g;

/** FNV-1a de 32 bits en base 36: estable y sin dependencias (el módulo también corre en el navegador). */
export function shortHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

const decodeAttr = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Declaraciones de un `style`, partiendo por `;` fuera de comillas y paréntesis (url("data:…;base64,…")). */
export function splitDeclarations(style) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const ch of style) {
    if (quote) { if (ch === quote) quote = null; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const importantRule = (decls) => decls
  .map((d) => (/!important\s*$/i.test(d) ? d : `${d} !important`))
  .join(';');

const START_TAG_RE = /<([a-zA-Z][\w:-]*)(\s[^<>]*?)?(\/?)>/g;
const STYLE_ATTR_RE = /\sstyle="([^"]*)"/;
const CLASS_ATTR_RE = /\sclass="([^"]*)"/;

/**
 * Saca cada `style="…"` del HTML (innerHTML de #root, que serializa el
 * navegador: atributos siempre entre comillas dobles y `<` del texto escapado)
 * a una clase. Devuelve el HTML sin un solo `style` y la hoja con sus reglas.
 * El contenido de <script>/<style> no se toca.
 * @returns {{ html: string, css: string, count: number }}
 */
export function hoistInlineStyles(html) {
  const classes = new Map(); // css de la regla → clase
  const used = new Set();
  let count = 0;
  let out = '';
  let last = 0;
  START_TAG_RE.lastIndex = 0;
  for (let m = START_TAG_RE.exec(html); m; m = START_TAG_RE.exec(html)) {
    const tag = m[1].toLowerCase();
    let attrs = m[2] || '';
    const styleMatch = attrs.match(STYLE_ATTR_RE);
    if (styleMatch) {
      const decls = splitDeclarations(decodeAttr(styleMatch[1]));
      attrs = attrs.replace(STYLE_ATTR_RE, '');
      if (decls.length) {
        const rule = importantRule(decls);
        let cls = classes.get(rule);
        if (!cls) {
          const base = `${STYLE_CLASS_PREFIX}${shortHash(rule)}`;
          cls = base;
          for (let n = 2; used.has(cls); n += 1) cls = `${base}-${n}`; // colisión de hash
          used.add(cls);
          classes.set(rule, cls);
        }
        attrs = CLASS_ATTR_RE.test(attrs)
          ? attrs.replace(CLASS_ATTR_RE, (_, c) => ` class="${c ? `${c} ` : ''}${cls}"`)
          : ` class="${cls}"${attrs}`;
        count += 1;
      }
    }
    out += html.slice(last, m.index) + `<${m[1]}${attrs}${m[3]}>`;
    last = START_TAG_RE.lastIndex;
    if (tag === 'script' || tag === 'style') {
      // Texto crudo: se copia tal cual hasta su cierre.
      const close = html.toLowerCase().indexOf(`</${tag}`, last);
      const end = close < 0 ? html.length : close;
      out += html.slice(last, end);
      last = end;
      START_TAG_RE.lastIndex = end;
    }
  }
  out += html.slice(last);
  const css = [...classes].map(([rule, cls]) => `.${cls}{${rule}}`).join('\n');
  return { html: out, css: css ? `${css}\n` : '', count };
}

/** Enlaza la hoja de estilos movidos en el <head> (sustituye la de un prerender anterior). */
export function linkPrerenderStylesheet(html, href) {
  const base = html.replace(PRERENDER_CSS_LINK_RE, '');
  if (!href) return base;
  if (!base.includes('</head>')) throw new Error('linkPrerenderStylesheet: el HTML no tiene </head>');
  return base.replace('</head>', () => `<link rel="stylesheet" href="${escAttr(href)}"></head>`);
}
