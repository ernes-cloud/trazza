import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tras el build: ningún HTML en dist/ lleva <script> ejecutable inline
 * (sin src y distinto de application/ld+json). El JSON-LD es un bloque de
 * datos; script-src no lo ejecuta.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const hasDist =
  fs.existsSync(DIST) && fs.statSync(DIST).isDirectory();

if (!hasDist && !process.env.CI) {
  console.warn('dist/ no existe: ejecuta npm run build; test saltado en local');
}

function listHtmlFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listHtmlFiles(full));
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

/** <script> con código ejecutable (sin src y que no sea JSON-LD). */
function inlineExecutableScripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attrs, body]) => !/\bsrc\s*=/.test(attrs) && body.trim() !== '')
    .filter(([, attrs]) => !/type\s*=\s*["']application\/(ld\+)?json["']/i.test(attrs))
    .map(([tag]) => tag.slice(0, 160));
}

describe.skipIf(!hasDist && !process.env.CI)('dist: sin scripts inline ejecutables', () => {
  it('ningún dist/*.html tiene <script> sin src distinto de application/ld+json', () => {
    if (!hasDist) {
      throw new Error(
        'dist/ no existe en CI: el build (npm run build) debe correr antes de este test',
      );
    }
    const htmlFiles = listHtmlFiles(DIST);
    if (htmlFiles.length === 0) {
      throw new Error('dist/ no contiene ningún .html: ejecuta el build antes de este test');
    }
    for (const file of htmlFiles) {
      const bad = inlineExecutableScripts(fs.readFileSync(file, 'utf8'));
      expect(bad, path.relative(ROOT, file)).toEqual([]);
    }
  });
});
