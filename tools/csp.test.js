import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHeadTags } from '../src/lib/seoHead.js';
import { PUBLIC_PAGES, structuredDataFor } from '../src/lib/siteMeta.js';

/**
 * CSP / superficie app exportable: index.html, generate-seo, vite.config, pdf.js.
 * La CSP de nginx/deploy vive en tools/csp.nginx.test.js (fuera del export OSS).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** <script> con código ejecutable (sin src y que no sea un bloque de datos JSON). */
function inlineExecutableScripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attrs, body]) => !/\bsrc\s*=/.test(attrs) && body.trim() !== '')
    .filter(([, attrs]) => !/type\s*=\s*"application\/(ld\+)?json"/i.test(attrs))
    .map(([tag]) => tag.slice(0, 120));
}

describe('CSP / seguridad — código de la app (exportable)', () => {
  it('el index.html de la app no lleva style="…" ni <style> (style-src sin unsafe-inline)', () => {
    const html = read('index.html');
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toMatch(/<style[\s>]/i);
  });

  it('el index.html de la app no lleva <script> inline ejecutables', () => {
    expect(inlineExecutableScripts(read('index.html'))).toEqual([]);
  });

  it('el <head> que escribe generate-seo solo lleva JSON-LD inline (no lo bloquea script-src)', () => {
    for (const page of PUBLIC_PAGES) {
      const tags = buildHeadTags({
        title: 'T', description: 'D', url: 'https://example.com' + page.path, siteName: 'Trazza',
        ld: structuredDataFor(page.schema, { title: 'T', description: 'D', url: 'U' }),
      });
      expect(inlineExecutableScripts(tags.join('\n')), page.path).toEqual([]);
    }
  });

  it('D7: no queda rastro de  ni del plugin de editor inline en vite.config', () => {
    const cfg = read('vite.config.js');
    const lower = cfg.toLowerCase();
    expect(lower).not.toMatch(/horizon/);
    expect(cfg).not.toMatch(/add-transform-index-html/);
    expect(cfg).not.toMatch(/visual-editor|selection-mode|iframe-route-restoration|edit-mode-script/);
    expect(fs.existsSync(path.join(ROOT, 'plugins/visual-editor'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'plugins/selection-mode'))).toBe(false);
  });

  it('pdf.js se abre con isEvalSupported: false (sin unsafe-eval no puede compilar con new Function)', () => {
    expect(read('src/lib/fileToImages.js')).toMatch(/getDocument\(\{[^}]*isEvalSupported:\s*false/);
  });

  it('Express monta helmet (cabeceras de seguridad) sin reabrir CSP en la app (la CSP HTML la pone el proxy)', () => {
    const src = read('server/app.js');
    expect(src).toMatch(/import helmet from ['"]helmet['"]/);
    expect(src).toMatch(/app\.use\(\s*helmet\(/);
    expect(src).toMatch(/contentSecurityPolicy:\s*false/);
  });
});
