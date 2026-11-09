/**
 * Comprobaciones de un build de despliegue (las usa tools/buildDeploy.mjs; tests en
 * tools/checkBuild.test.js). Función pura salvo la lectura de dist/blog.
 *
 * Hasta la 5.ª revisión (2026-10-18) estas comprobaciones eran líneas de SERVIDOR.md
 * que se limitaban a imprimir (`grep AVISO`, `echo artículos…`, `&& echo "BUILD OK"`):
 * un build con el blog sin prerenderizar (15/18) o sin artículos (16/16) salía con
 * «BUILD OK», y el rsync --delete de c2 habría borrado los artículos del VPS.
 *
 * Falla si:
 *   - el build salió con código ≠ 0;
 *   - hay alguna línea con AVISO;
 *   - hay un `:is()` vacío en la salida (aviso del minificado de CSS: un `dark:` dentro
 *     de un pseudo-elemento, ver tools/indexCss.test.js);
 *   - falta la línea «[prerender] X/Y páginas», o en alguna X ≠ Y;
 *   - dist/blog tiene menos artículos (blog/<slug>/index.html) que `minPosts`;
 *   - algún HTML de dist/ lleva `style="…"` o `<style>`: la CSP no tiene
 *     'unsafe-inline' en style-src (2026-10-26) y el navegador no los aplicaría
 *     (el prerender los saca a /assets/prerender-<hash>.css).
 */
import fs from 'node:fs';
import path from 'node:path';

const PRERENDER_RE = /^\[prerender\] (\d+)\/(\d+) páginas/gm;

/** Artículos en dist: directorios blog/<slug>/ con su index.html. */
export function countBlogPosts(distDir) {
  const blog = path.join(distDir, 'blog');
  if (!fs.existsSync(blog)) return 0;
  return fs.readdirSync(blog, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(blog, d.name, 'index.html')))
    .length;
}

const INLINE_STYLE_RE = /<[a-zA-Z][^<>]*\sstyle=["']|<style[\s>]/i;

/** HTML de dist/ (relativos) que llevan estilos inline. */
export function htmlWithInlineStyles(distDir) {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.html') && INLINE_STYLE_RE.test(fs.readFileSync(p, 'utf8'))) out.push(path.relative(distDir, p));
    }
  };
  walk(distDir);
  return out.sort();
}

export function checkBuild({ exitCode, output, distDir, minPosts }) {
  const problems = [];
  const text = String(output ?? '');
  const lines = text.split(/\r?\n/);

  if (exitCode !== 0) problems.push(`el build salió con ${exitCode}`);

  const avisos = lines.filter((l) => l.includes('AVISO'));
  if (avisos.length) problems.push(`${avisos.length} línea(s) con AVISO: ${avisos.slice(0, 5).map((l) => l.trim()).join(' | ')}`);

  const emptyIs = lines.filter((l) => /:is\(\s*\)/.test(l));
  if (emptyIs.length) problems.push(`${emptyIs.length} línea(s) con un \`:is()\` vacío (CSS roto al minificar): ${emptyIs.slice(0, 3).map((l) => l.trim()).join(' | ')}`);

  const counts = [...text.matchAll(PRERENDER_RE)].map((m) => ({ done: Number(m[1]), total: Number(m[2]) }));
  if (!counts.length) problems.push('falta la línea «[prerender] X/Y páginas»: el prerender no corrió o no terminó');
  for (const c of counts) {
    if (c.done !== c.total) problems.push(`[prerender] ${c.done}/${c.total}: hay páginas sin prerenderizar`);
  }

  const styled = htmlWithInlineStyles(distDir);
  if (styled.length) problems.push(`${styled.length} HTML con estilos inline (la CSP no los aplica): ${styled.slice(0, 5).join(', ')}`);

  const posts = countBlogPosts(distDir);
  if (posts < minPosts) problems.push(`dist/blog tiene ${posts} artículos y BLOG_MIN_POSTS=${minPosts}`);

  return { ok: problems.length === 0, problems, pages: counts[counts.length - 1] ?? null, posts };
}
