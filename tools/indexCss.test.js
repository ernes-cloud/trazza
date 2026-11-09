import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { transform } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_CSS = path.join(ROOT, 'src/index.css');

/*
 * `dark:` dentro de un pseudo-elemento. Con `@custom-variant dark (&:is(.dark *))`,
 * `&::-webkit-scrollbar-thumb { @apply dark:bg-x }` genera
 * `::-webkit-scrollbar-thumb:is(.dark *)`: un pseudo-elemento no admite una
 * pseudo-clase detrás, el optimizador de Tailwind (lightningcss, activo en `vite build`
 * porque NODE_ENV=production) lo deja en `:is()` vacío, esbuild avisa al minificar y el
 * color oscuro no se aplica nunca (7 avisos en el build del 2026-10-18). El oscuro va en
 * un bloque `.dark &::…` aparte.
 *
 * El oráculo de verdad es el CSS COMPILADO (primer describe): cualquier forma de llegar
 * ahí (`@variant dark`, `&:hover { @apply dark:… }`, `hover:dark:`, `:before`…) se ve
 * en la salida. El análisis de la fuente (segundo describe) es la segunda barrera, más
 * barata y con mejor mensaje.
 */

/** Pseudo-elemento: `::algo` o los cuatro de CSS2 con un solo `:`. */
const PSEUDO_ELEMENT = String.raw`(?:::[A-Za-z-]+|:(?:before|after|first-line|first-letter)(?![A-Za-z-]))`;
/** Un pseudo-elemento seguido (en el mismo selector compuesto) de `:is(`. */
const PSEUDO_THEN_IS = new RegExp(`${PSEUDO_ELEMENT}[^\\s,{}>+~]*?:is\\(`, 'g');
const EMPTY_IS = /:is\(\s*\)/g;

/**
 * Lo mismo que hace `vite build` (4.5) con src/index.css: PostCSS con
 * @tailwindcss/postcss (postcss.config.js) con `optimize` (en producción) y después
 * el minificado de CSS de Vite 4, que es esbuild con `build.cssTarget` = el target por
 * defecto de `build.target: 'modules'`.
 */
async function compileLikeViteBuild(css) {
  const out = await postcss([tailwind({ base: ROOT, optimize: true })]).process(css, { from: INDEX_CSS });
  const min = await transform(out.css, {
    loader: 'css', minify: true, target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'],
  });
  return { css: out.css, min: min.code, warnings: min.warnings.map((w) => `${w.text} @ ${w.location?.lineText?.slice(0, 120) ?? ''}`) };
}

function brokenSelectors({ css, min }) {
  return {
    emptyIs: [...(css.match(EMPTY_IS) || []), ...(min.match(EMPTY_IS) || [])].length,
    pseudoThenIs: [...new Set([...css.matchAll(PSEUDO_THEN_IS), ...min.matchAll(PSEUDO_THEN_IS)].map((m) => m[0]))],
  };
}

describe('src/index.css compilado como en vite build', () => {
  it('detecta el patrón roto en el CSS compilado (control)', async () => {
    const base = fs.readFileSync(INDEX_CSS, 'utf8');
    const bad = `${base}\n.ctl-x { &::placeholder { @apply dark:text-slate-500; } }\n`;
    const r = brokenSelectors(await compileLikeViteBuild(bad));
    expect(r.emptyIs).toBeGreaterThan(0);
    expect(r.pseudoThenIs.length).toBeGreaterThan(0);
  }, 30_000);

  it('0 `:is()` vacíos, 0 pseudo-elementos seguidos de `:is(` y 0 avisos del minificado', async () => {
    const out = await compileLikeViteBuild(fs.readFileSync(INDEX_CSS, 'utf8'));
    expect(brokenSelectors(out)).toEqual({ emptyIs: 0, pseudoThenIs: [] });
    expect(out.warnings).toEqual([]);
  }, 30_000);
});

/** Quita comentarios y el contenido de cadenas y `[...]` (un `::` ahí no es un selector). */
function neutralize(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
    .replace(/\[[^\]{};]*\]/g, '[]');
}

/** Una variante `dark` en un @apply (también apilada: `hover:dark:`, `md:dark:`). */
const APPLY_DARK = /@apply\b[^;{}]*(?:^|[\s:])dark:/;
/** Un bloque `@variant dark { … }`. */
const VARIANT_DARK = /^@variant\s+dark\b/;
const HAS_PSEUDO_ELEMENT = new RegExp(PSEUDO_ELEMENT);

/**
 * Recorre los bloques con una pila de selectores: un `@apply … dark:…` o un
 * `@variant dark` cuyo bloque, o CUALQUIER bloque que lo contenga, tiene un
 * pseudo-elemento en el selector. Así se ve `&::x { &:hover { @apply dark:… } }`.
 */
function darkInsidePseudoElement(source) {
  const css = neutralize(source);
  const out = [];
  const stack = [];
  let buf = '';
  const inPseudo = () => stack.some((s) => HAS_PSEUDO_ELEMENT.test(s) && !s.startsWith('@'));
  for (const ch of css) {
    if (ch === '{') {
      const head = buf.trim();
      if (VARIANT_DARK.test(head) && inPseudo()) out.push(`${stack.join(' › ')} › ${head}`);
      stack.push(head);
      buf = '';
    } else if (ch === ';' || ch === '}') {
      const stmt = buf.trim();
      if (APPLY_DARK.test(stmt) && inPseudo()) out.push(`${stack.join(' › ')} › ${stmt}`);
      if (ch === '}') stack.pop();
      buf = '';
    } else buf += ch;
  }
  return out;
}

describe('src/index.css (fuente, segunda barrera)', () => {
  it('detecta el patrón roto (control)', () => {
    for (const bad of [
      '&::-webkit-scrollbar-thumb {\n  @apply bg-slate-300 dark:bg-slate-600;\n}',
      '.x {\n  &::placeholder {\n    @apply text-slate-400 dark:text-slate-500;\n  }\n}',
      '::selection { @apply bg-blue-200 dark:bg-blue-800; }',
      '.custom::-webkit-scrollbar-thumb { @apply dark:bg-slate-600; }',
      'input::placeholder, textarea::placeholder { @apply dark:text-slate-500; }',
      // Justo después de otro bloque con pseudo-elemento (la llave de cierre es compartida):
      '.dark &::-webkit-scrollbar-thumb { @apply bg-slate-600; }\n&::placeholder { @apply dark:text-slate-500; }',
      // I3: @variant dark dentro del pseudo-elemento
      '.rv-y { &::-webkit-scrollbar-thumb { @variant dark { background: red; } } }',
      // I4: &:hover { @apply dark:… } dentro del pseudo-elemento
      '.rv-h { &::-webkit-scrollbar-thumb { &:hover { @apply dark:bg-slate-600; } } }',
      // I6: variantes apiladas
      '.rv-s::selection { @apply hover:dark:bg-blue-800; }',
      '::placeholder { @apply md:dark:text-slate-500; }',
      // Bloque con un hijo (el @apply ya no está en el bloque más interno)
      '&::placeholder { @apply dark:text-slate-500; .z { color: red; } }',
      // Pseudo-elemento con un solo `:` (sintaxis CSS2)
      '.x:before { @apply dark:bg-slate-600; }',
    ]) expect(darkInsidePseudoElement(bad), bad).toHaveLength(1);
    for (const ok of [
      '.dark &::-webkit-scrollbar-thumb {\n  @apply bg-slate-600;\n}',
      '.btn { @apply bg-white dark:bg-slate-800; }',
      '&:hover { @apply dark:bg-slate-700; }',
      '&::placeholder { @apply text-slate-400; }\n.dark &::placeholder { @apply text-slate-500; }',
      // I5: un comentario que nombra un pseudo-elemento no hace pseudo-elemento al bloque
      '/* ver ::placeholder */ .btn { @apply dark:bg-slate-800; }',
      '[data-x="a::b"] { @apply dark:bg-slate-800; }',
      '.x:before-ish { @apply dark:bg-slate-800; }',
      '.a { @apply dark:bg-x; } &::placeholder { color: red; }',
      '.x { @variant dark { color: red; } }',
    ]) expect(darkInsidePseudoElement(ok), ok).toHaveLength(0);
  });

  it('ningún `dark:` ni `@variant dark` dentro de un bloque con pseudo-elemento', () => {
    expect(darkInsidePseudoElement(fs.readFileSync(INDEX_CSS, 'utf8'))).toEqual([]);
  });
});
