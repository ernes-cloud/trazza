import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Cabeceras de seguridad exportables: plantilla Docker (en el árbol OSS) + helmet en Express.
 * La copia de producción en deploy/nginx/ se comprueba en tools/cspHeaders.nginx.test.js.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCKER_SNIPPET = path.join(
  ROOT,
  'docker/nginx/templates/snippets/html-headers.conf.template',
);

const stripComments = (text) => text.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');
const CSP_RE = /add_header Content-Security-Policy "([^"]+)" always;/g;

function scriptSrc(csp) {
  const part = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('script-src '));
  return part ? part.slice('script-src '.length).split(/\s+/) : [];
}

describe('CSP headers exportables (Docker + Express)', () => {
  it('la plantilla Docker declara CSP sin unsafe-inline ni unsafe-eval en script-src', () => {
    expect(fs.existsSync(DOCKER_SNIPPET), 'falta docker/nginx/.../html-headers.conf.template').toBe(true);
    const text = stripComments(fs.readFileSync(DOCKER_SNIPPET, 'utf8'));
    const values = [...text.matchAll(CSP_RE)].map((m) => m[1]);
    expect(values.length).toBeGreaterThanOrEqual(1);
    for (const csp of values) {
      const valuesSrc = scriptSrc(csp);
      expect(valuesSrc, csp).not.toContain("'unsafe-inline'");
      expect(valuesSrc, csp).not.toContain("'unsafe-eval'");
      expect(valuesSrc).toContain("'self'");
    }
  });

  it('Express usa helmet (cabeceras); CSP HTML la delega al proxy', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/app.js'), 'utf8');
    expect(src).toMatch(/app\.use\(\s*helmet\(/);
    expect(src).toMatch(/contentSecurityPolicy:\s*false/);
  });
});
