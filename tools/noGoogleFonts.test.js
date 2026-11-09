import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fuentes autoalojadas: nada de fonts.googleapis / fonts.gstatic en src/ ni
 * index.html, y cada @font-face apunta a /fonts/*.woff2.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const INDEX_HTML = path.join(ROOT, 'index.html');

function walkFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walkFiles(full, acc);
    } else {
      acc.push(full);
    }
  }
  return acc;
}

describe('fuentes propias (sin Google Fonts)', () => {
  it('ni src/ ni index.html contienen fonts.googleapis', () => {
    const files = [INDEX_HTML, ...walkFiles(SRC)];
    const hits = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      if (/fonts\.googleapis/i.test(text) || /fonts\.gstatic/i.test(text)) {
        hits.push(path.relative(ROOT, file));
      }
    }
    expect(hits, `referencias a Google Fonts:\n${hits.join('\n')}`).toEqual([]);
  });

  it('cada @font-face apunta a /fonts/*.woff2', () => {
    const cssFiles = walkFiles(SRC).filter((f) => f.endsWith('.css'));
    const faces = [];
    for (const file of cssFiles) {
      const text = fs.readFileSync(file, 'utf8');
      for (const block of text.matchAll(/@font-face\s*\{([\s\S]*?)\}/g)) {
        faces.push({ file: path.relative(ROOT, file), body: block[1] });
      }
    }
    expect(faces.length, 'hace falta al menos un @font-face local').toBeGreaterThan(0);
    for (const { file, body } of faces) {
      const urls = [...body.matchAll(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/g)].map((m) => m[1]);
      expect(urls.length, `@font-face sin url() en ${file}`).toBeGreaterThan(0);
      for (const url of urls) {
        expect(url, `${file}: ${url}`).toMatch(/^\/fonts\/.+\.woff2$/);
      }
    }
  });
});
