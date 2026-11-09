import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkBuild } from './checkBuild.mjs';

/*
 * Lo que `npm run build:deploy` exige a un build antes de decir «BUILD OK»
 * (SERVIDOR.md → b). La salida del build es texto (stdout+stderr, como la deja
 * buildDeploy.mjs) y dist/ un directorio falso en tmpdir: nada de esto necesita
 * compilar.
 */

let dist;
beforeEach(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'check-build-'));
  fs.mkdirSync(path.join(dist, 'blog'));
  fs.writeFileSync(path.join(dist, 'blog', 'index.html'), '<h1>Blog</h1>');
});
afterEach(() => fs.rmSync(dist, { recursive: true, force: true }));

const addPost = (slug, file = 'index.html') => {
  fs.mkdirSync(path.join(dist, 'blog', slug), { recursive: true });
  fs.writeFileSync(path.join(dist, 'blog', slug, file), '<h1>x</h1>');
};

const GOOD = [
  '> trazza@1.0.0 build',
  '> vite build',
  '✓ 3496 modules transformed.',
  '✓ built in 15.39s',
  '[generate-seo] 15 páginas + 2 artículos + 404.html, app.html, sitemap.xml y robots.txt',
  '[prerender] 18/18 páginas prerenderizadas',
].join('\n');

const check = (over = {}) => checkBuild({ exitCode: 0, output: GOOD, distDir: dist, minPosts: 1, ...over });

describe('tools/checkBuild', () => {
  it('un build bueno pasa (control)', () => {
    addPost('uno'); addPost('dos');
    const r = check();
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.pages).toEqual({ done: 18, total: 18 });
    expect(r.posts).toBe(2);
  });

  it('exit ≠ 0 del build falla', () => {
    addPost('uno');
    const r = check({ exitCode: 1 });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/salió con 1/);
  });

  it('una línea AVISO falla y se cita (caso «fetch failed» sin REQUIRE_BLOG)', () => {
    addPost('uno');
    const out = `${GOOD}\n[generate-seo] AVISO: no se pudieron leer los artículos (fetch failed): sitemap sin artículos`;
    const r = check({ output: out });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/AVISO.*fetch failed/);
  });

  it('un `:is()` vacío en la salida (aviso del minificado de CSS) falla', () => {
    addPost('uno');
    const out = `${GOOD}\n▲ [WARNING] Unexpected ")" [css-syntax-error]\n    <stdin>:1:9: .x::placeholder:is(){color:red}`;
    const r = check({ output: out });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/:is\(\)/);
  });

  it('«[prerender] X/Y» con X ≠ Y falla (caso G4: el blog no se pintó)', () => {
    addPost('uno');
    const r = check({ output: GOOD.replace('18/18', '15/18') });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/15\/18/);
  });

  it('sin la línea «[prerender] X/Y» falla (SKIP_PRERENDER, o el postbuild no llegó)', () => {
    addPost('uno');
    const r = check({ output: GOOD.split('\n').filter((l) => !l.startsWith('[prerender]')).join('\n') });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/\[prerender\] X\/Y/);
  });

  it('varias líneas de prerender con la mala PRIMERO o EN MEDIO: también falla (no basta con mirar la última)', () => {
    addPost('uno');
    const good = '[prerender] 17/17 páginas prerenderizadas';
    const bad = '[prerender] 15/16 páginas prerenderizadas';
    const rest = GOOD.split('\n').filter((l) => !l.startsWith('[prerender]'));
    for (const lines of [[bad, good], [good, bad, good], [bad, good, good]]) {
      const r = check({ output: [...rest, ...lines].join('\n') });
      expect(r.ok, lines.join(' | ')).toBe(false);
      expect(r.problems.join('\n')).toMatch(/15\/16/);
    }
  });

  it('dos líneas de prerender: basta con que una no cuadre', () => {
    addPost('uno');
    const r = check({ output: `${GOOD}\n[prerender] 15/16 páginas prerenderizadas` });
    expect(r.ok).toBe(false);
  });

  it('menos artículos en dist/blog que BLOG_MIN_POSTS falla (caso G5: lista vacía)', () => {
    const r = check({ minPosts: 1 });
    expect(r.ok).toBe(false);
    expect(r.posts).toBe(0);
    expect(r.problems.join('\n')).toMatch(/0 artículos.*BLOG_MIN_POSTS=1/);
  });

  it('con BLOG_MIN_POSTS=0, un dist sin artículos pasa', () => {
    expect(check({ minPosts: 0 }).ok).toBe(true);
  });

  it('solo cuentan los directorios blog/<slug>/ con index.html (ni index.html suelto ni carpetas vacías)', () => {
    addPost('uno');
    fs.mkdirSync(path.join(dist, 'blog', 'vacia'));
    addPost('otra', 'otra.html');
    expect(check({ minPosts: 1 }).posts).toBe(1);
    expect(check({ minPosts: 2 }).ok).toBe(false);
  });

  it('sin dist/blog cuenta 0 artículos (no revienta)', () => {
    fs.rmSync(path.join(dist, 'blog'), { recursive: true });
    const r = check({ minPosts: 1 });
    expect(r.ok).toBe(false);
    expect(r.posts).toBe(0);
  });

  it('acumula todos los motivos, no solo el primero', () => {
    const r = check({ exitCode: 2, output: `${GOOD.replace('18/18', '15/18')}\n[prerender] AVISO: x` });
    expect(r.problems.length).toBeGreaterThanOrEqual(4);
  });

  it('un HTML de dist con style="…" o <style> falla y se cita (CSP sin unsafe-inline en style-src)', () => {
    addPost('uno');
    fs.writeFileSync(path.join(dist, 'index.html'), '<html><head></head><body><div class="ps-1">ok</div></body></html>');
    expect(check().ok).toBe(true);
    fs.mkdirSync(path.join(dist, 'guias'));
    fs.writeFileSync(path.join(dist, 'guias', 'index.html'), '<div><p style="color: red">x</p></div>');
    fs.writeFileSync(path.join(dist, '404.html'), '<head><style>p{}</style></head>');
    const r = check();
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/2 HTML con estilos inline.*404\.html, guias\/index\.html/);
  });

  it('el texto "style=" dentro del contenido no cuenta (solo atributos de una etiqueta)', () => {
    addPost('uno');
    fs.writeFileSync(path.join(dist, 'index.html'), '<p>usa style="x" en tu HTML</p>');
    expect(check().ok).toBe(true);
  });

  it("también detecta style='…' con comilla simple", () => {
    addPost('uno');
    fs.writeFileSync(path.join(dist, 'index.html'), "<div style='color:red'>x</div>");
    const r = check();
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/estilos inline/);
  });
});
