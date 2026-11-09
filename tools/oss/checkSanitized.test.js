import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { checkSanitized } from './check-sanitized.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');

const tmpDirs = [];
function mkFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-sanitize-'));
  tmpDirs.push(dir);
  return dir;
}
function writeFile(root, relPath, content) {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}
function writeHashesFile(root, hashes) {
  return writeFile(root, 'hashes.txt', hashes.join('\n'));
}
function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('checkSanitized — sin OSS_FORBIDDEN_HASHES_FILE', () => {
  it('falla con mensaje claro si hashesFile no se pasa', () => {
    const root = mkFixture();
    const { ok, violations } = checkSanitized({ root, hashesFile: undefined });
    expect(ok).toBe(false);
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toMatch(/OSS_FORBIDDEN_HASHES_FILE/);
  });

  it('falla con mensaje claro si hashesFile apunta a un fichero que no existe', () => {
    const root = mkFixture();
    const { ok, violations } = checkSanitized({ root, hashesFile: path.join(root, 'no-existe.txt') });
    expect(ok).toBe(false);
    expect(violations[0].reason).toMatch(/OSS_FORBIDDEN_HASHES_FILE/);
  });
});

describe('checkSanitized — rutas prohibidas (fixture temporal, hashesFile vacío)', () => {
  const FORBIDDEN_FIXTURES = [
    ['.claude/agents/foo.md', '.claude/'],
    ['.mcp.json', '.mcp.json'],
    ['.playwright-mcp/page-1.yml', '.playwright-mcp/'],
    ['scratch_whatever.mjs', 'scratch'],
    ['test.js', 'test*.js'],
    ['test3.js', 'test*.js'],
    ['debug_foo.js', 'debug_'],
    ['SERVIDOR.md', 'SERVIDOR.md'],
    ['Plans.md', 'Plans.md'],
    ['deploy/deploy-vps.sh', 'deploy/'],
    ['.gitlab-ci.yml', '.gitlab-ci.yml'],
    ['docs/claude/production.md', 'docs/claude/{production,growth,history}.md'],
    ['docs/claude/growth.md', 'docs/claude/{production,growth,history}.md'],
    ['docs/claude/history.md', 'docs/claude/{production,growth,history}.md'],
    ['informes/report.pdf.txt', 'informes/'],
    ['node_modules/pkg/index.js', 'node_modules'],
    ['assets/app.abc123.js.map', '*.map'],
    ['plugins/visual-editor/edit-mode-script.js', 'plugins/visual-editor/'],
    ['plugins/selection-mode/foo.js', 'plugins/selection-mode/'],
    ['plugins/utils/ast-utils.js', 'plugins/utils/'],
    ['plugins/vite-plugin-iframe-route-restoration.js', 'vite-plugin-iframe-route-restoration.js'],
  ];

  for (const [relPath, label] of FORBIDDEN_FIXTURES) {
    it(`detecta ${label} (${relPath})`, () => {
      const root = mkFixture();
      writeFile(root, relPath, '// archivo de prueba inofensivo\n');
      const hashesFile = writeHashesFile(root, []);
      const { ok, violations } = checkSanitized({ root, hashesFile });
      expect(ok).toBe(false);
      expect(violations.some((v) => v.file.replace(/\\/g, '/').includes(relPath.split('/')[0]))).toBe(true);
    });
  }

  it('docs/claude/finance.md (NO prohibido) no genera violación de ruta', () => {
    const root = mkFixture();
    writeFile(root, 'docs/claude/finance.md', '# finance notes\n');
    const hashesFile = writeHashesFile(root, []);
    const { ok } = checkSanitized({ root, hashesFile });
    expect(ok).toBe(true);
  });

  it('un árbol limpio (sin nada prohibido) pasa', () => {
    const root = mkFixture();
    writeFile(root, 'src/App.jsx', 'export default function App() { return null; }\n');
    writeFile(root, 'README.md', '# Hello\n');
    const hashesFile = writeHashesFile(root, []);
    const { ok, violations } = checkSanitized({ root, hashesFile });
    expect(ok).toBe(true);
    expect(violations).toEqual([]);
  });
});

describe('checkSanitized — cadenas ' + 'hori' + 'zons' + '/' + 'host' + 'inger' + ' (case-insensitive)', () => {
  it('detecta "' + 'hori' + 'zons' + '" en cualquier fichero, con fichero:línea', () => {
    const root = mkFixture();
    writeFile(root, 'vite.config.js', 'line one\nconst x = "' + 'hori' + 'zons' + '-vite-error";\nline three\n');
    const hashesFile = writeHashesFile(root, []);
    const { ok, violations } = checkSanitized({ root, hashesFile });
    expect(ok).toBe(false);
    const hit = violations.find((v) => v.reason.includes('hori' + 'zons'));
    expect(hit).toBeTruthy();
    expect(hit.line).toBe(2);
  });

  it('detecta "' + 'Host' + 'inger' + '" en mayúsculas mezcladas', () => {
    const root = mkFixture();
    writeFile(root, 'README.md', 'Deployed on ' + 'Host' + 'inger' + ' VPS\n');
    const hashesFile = writeHashesFile(root, []);
    const { ok, violations } = checkSanitized({ root, hashesFile });
    expect(ok).toBe(false);
    expect(violations.some((v) => v.reason.includes('host' + 'inger'))).toBe(true);
  });
});

describe('checkSanitized — tokens prohibidos por hash (NUNCA se imprime el valor)', () => {
  it('detecta un token cuyo sha256 está en OSS_FORBIDDEN_HASHES_FILE, sin filtrar el valor', () => {
    const root = mkFixture();
    // Construida por concatenación en ejecución (nunca literal en el fuente)
    // para que gitleaks/trufflehog no la marquen como un secreto real.
    const FAKE_SECRET = ['s', 'k_'].join('') + 'fake_totally_not_real_oss_t2_0123456789abcdef';
    writeFile(root, 'src/lib/leaked.js', `export const KEY = '${FAKE_SECRET}';\n`);
    const hashesFile = writeHashesFile(root, [sha256(FAKE_SECRET)]);

    const { ok, violations } = checkSanitized({ root, hashesFile });
    expect(ok).toBe(false);
    const hit = violations.find((v) => v.reason.includes('hash'));
    expect(hit).toBeTruthy();
    expect(hit.file).toMatch(/leaked\.js$/);
    expect(hit.line).toBe(1);

    // El valor del secreto NUNCA debe aparecer en ninguna violación reportada.
    const serialized = JSON.stringify(violations);
    expect(serialized).not.toContain(FAKE_SECRET);
  });

  it('un hashesFile con hashes que NO coinciden con nada no genera violaciones de token', () => {
    const root = mkFixture();
    writeFile(root, 'src/lib/clean.js', `export const KEY = 'totally-unrelated-value-123456789';\n`);
    const hashesFile = writeHashesFile(root, [sha256('something-else-entirely-0987654321')]);
    const { ok } = checkSanitized({ root, hashesFile });
    expect(ok).toBe(true);
  });

  it('líneas en blanco y comentarios (#) del hashesFile se ignoran', () => {
    const root = mkFixture();
    // Construida por concatenación en ejecución (nunca literal en el fuente)
    // para que gitleaks/trufflehog no la marquen como un secreto real.
    const FAKE_SECRET = ['g', 'hp_'].join('') + 'fake0123456789abcdefFAKEFAKEFAKE';
    writeFile(root, 'notes.txt', FAKE_SECRET);
    const hashesFile = writeHashesFile(root, ['', '# comentario', sha256(FAKE_SECRET), '']);
    const { ok, violations } = checkSanitized({ root, hashesFile });
    expect(ok).toBe(false);
    expect(violations.some((v) => v.reason.includes('hash'))).toBe(true);
  });
});

describe('checkSanitized — distDir opcional', () => {
  it('también recorre distDir si se pasa, con las mismas reglas', () => {
    const root = mkFixture();
    const dist = mkFixture();
    writeFile(root, 'src/App.jsx', 'export default function App() {}\n');
    writeFile(dist, 'assets/index-abc.js.map', '{}');
    const hashesFile = writeHashesFile(root, []);
    const { ok, violations } = checkSanitized({ root, distDir: dist, hashesFile });
    expect(ok).toBe(false);
    expect(violations.some((v) => v.file.startsWith('dist/') && v.file.endsWith('.map'))).toBe(true);
  });
});

describe('checkSanitized — emails / passwords / legado CMS / host de producto (fixtures)', () => {
  const needleCreami = ['creami', 'sitio'].join('');
  const needleHost = ['trazza', '.', 'cloud'].join('');
  const needlePersona = ['gil', 'berto'].join('');
  const personalEmail = ['alice', '@', 'secret-corp', '.', 'io'].join('');
  const hardcodedPw = ['s3cret', 'Value', 'XYZ'].join('');

  it('detecta email personal (dominio no allowlisted) sin imprimir el valor', () => {
    const root = mkFixture();
    writeFile(root, 'src/notes.js', `const contact = "${personalEmail}";\n`);
    const hashesFile = writeHashesFile(root, []);
    const { ok, violations } = checkSanitized({ root, hashesFile });
    expect(ok).toBe(false);
    const v = violations.find((x) => x.reason.includes('email personal'));
    expect(v, 'debe haber violación de email personal').toBeTruthy();
    expect(v.file).toBe('src/notes.js');
    expect(v.line).toBe(1);
    expect(JSON.stringify(violations)).not.toContain(personalEmail);
  });

  it('permite example.com, example.org, *.test y *.invalid', () => {
    const root = mkFixture();
    writeFile(
      root,
      'src/ok.js',
      'const a = "demo@example.com"; const b = "x@example.org"; const c = "u@foo.test"; const d = "v@bar.invalid";\n',
    );
    const hashesFile = writeHashesFile(root, []);
    const { ok, violations } = checkSanitized({ root, hashesFile });
    expect(violations.filter((v) => v.reason.includes('email')), violations).toEqual([]);
    expect(ok).toBe(true);
  });

  it('no permite dominio .local (fuera del allowlist Planner)', () => {
    const root = mkFixture();
    const localEmail = ['user-a', '@', 'test', '.', 'local'].join('');
    writeFile(root, 'src/bad.js', `const a = "${localEmail}";\n`);
    const hashesFile = writeHashesFile(root, []);
    const { ok, violations } = checkSanitized({ root, hashesFile });
    expect(ok).toBe(false);
    expect(violations.some((v) => v.reason.includes('email personal') && v.file === 'src/bad.js')).toBe(true);
  });

  it('detecta contraseña hardcodeada sin imprimir el valor', () => {
    const root = mkFixture();
    writeFile(root, 'server/bad.js', ['const ', 'password', ' = "', hardcodedPw, '";\n'].join(''));
    const hashesFile = writeHashesFile(root, []);
    const { ok, violations } = checkSanitized({ root, hashesFile });
    expect(ok).toBe(false);
    const v = violations.find((x) => x.reason.includes('contraseña hardcodeada'));
    expect(v).toBeTruthy();
    expect(v.file).toBe('server/bad.js');
    expect(v.line).toBe(1);
    expect(JSON.stringify(violations)).not.toContain(hardcodedPw);
  });

  it('detecta el nombre legado CMS', () => {
    const root = mkFixture();
    writeFile(root, 'README.md', `Migrado desde ${needleCreami} legacy.\n`);
    const hashesFile = writeHashesFile(root, []);
    const { ok, violations } = checkSanitized({ root, hashesFile });
    expect(ok).toBe(false);
    expect(violations.some((v) => v.reason.includes(needleCreami) && v.file === 'README.md')).toBe(true);
  });

  it('detecta host de producto fuera de .env.example/config', () => {
    const root = mkFixture();
    writeFile(root, 'src/brand.js', `export const HOST = "https://app.${needleHost}";\n`);
    const hashesFile = writeHashesFile(root, []);
    const { ok, violations } = checkSanitized({ root, hashesFile });
    expect(ok).toBe(false);
    expect(violations.some((v) => v.reason.includes(needleHost) && v.file === 'src/brand.js')).toBe(true);
  });

  it('permite host de producto solo en .env.example y config/', () => {
    const root = mkFixture();
    writeFile(root, '.env.example', `PUBLIC_URL=https://app.${needleHost}\n`);
    writeFile(root, 'config/site.js', `export const HOST = "https://${needleHost}";\n`);
    const hashesFile = writeHashesFile(root, []);
    const { ok, violations } = checkSanitized({ root, hashesFile });
    const cloud = violations.filter((v) => v.reason.includes(needleHost));
    expect(cloud, cloud).toEqual([]);
    expect(ok).toBe(true);
  });

  it('niega host de producto en docs/ aunque la línea esté parametrizada', () => {
    const root = mkFixture();
    writeFile(root, 'docs/setup.md', `Set VITE_API_URL=https://\${YOUR_HOST} # was ${needleHost}\n`);
    const hashesFile = writeHashesFile(root, []);
    const { violations } = checkSanitized({ root, hashesFile });
    expect(violations.some((v) => v.reason.includes(needleHost) && v.file === 'docs/setup.md')).toBe(true);
  });

  it('detecta la persona demo (sin distinguir mayúsculas)', () => {
    const root = mkFixture();
    writeFile(root, 'src/demo.js', `export const id = "${needlePersona.toUpperCase()}-user-id";\n`);
    const hashesFile = writeHashesFile(root, []);
    const { ok, violations } = checkSanitized({ root, hashesFile });
    expect(ok).toBe(false);
    expect(violations.some((v) => v.reason.includes(needlePersona) && v.file === 'src/demo.js' && v.line === 1)).toBe(true);
  });

  it('detecta rutas de hosting internas', () => {
    const root = mkFixture();
    const opt = ['/', 'opt', '/'].join('');
    const vwww = ['/', 'var', '/', 'www'].join('');
    writeFile(root, 'docs/deploy.md', `Binario en ${opt}myapp/bin y web en ${vwww}/html.\n`);
    const hashesFile = writeHashesFile(root, []);
    const { ok, violations } = checkSanitized({ root, hashesFile });
    expect(ok).toBe(false);
    expect(violations.some((v) => v.reason.includes(opt) && v.file === 'docs/deploy.md')).toBe(true);
    expect(violations.some((v) => v.reason.includes(vwww) && v.file === 'docs/deploy.md')).toBe(true);
  });

  it('detecta enlace .md relativo roto', () => {
    const root = mkFixture();
    writeFile(root, 'docs/index.md', 'Ver [guia](./missing-guide.md) para más.\n');
    const hashesFile = writeHashesFile(root, []);
    const { ok, violations } = checkSanitized({ root, hashesFile });
    expect(ok).toBe(false);
    expect(violations.some((v) => v.reason.includes('enlace .md relativo roto') && v.file === 'docs/index.md' && v.line === 1)).toBe(true);
  });

  it('acepta enlace .md relativo existente', () => {
    const root = mkFixture();
    writeFile(root, 'docs/guide.md', '# Guide\n');
    writeFile(root, 'docs/index.md', 'Ver [guia](./guide.md).\n');
    const hashesFile = writeHashesFile(root, []);
    const { ok, violations } = checkSanitized({ root, hashesFile });
    expect(violations.filter((v) => v.reason.includes('enlace .md')), violations).toEqual([]);
    expect(ok).toBe(true);
  });
});

describe('checkSanitized — sobre el export OSS (no el repo crudo)', () => {
  it('export-oss.mjs produce un árbol sin .claude ni Plans.md', () => {
    const hashesTmp = mkFixture();
    const hashesFile = writeHashesFile(hashesTmp, []);
    const outDir = path.join(os.tmpdir(), `oss-export-out-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    tmpDirs.push(outDir);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/oss/export-oss.mjs'), outDir, '--hashes', hashesFile], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, OSS_FORBIDDEN_HASHES_FILE: hashesFile },
    });
    expect(fs.existsSync(outDir), `export no creó ${outDir}: status=${r.status}\n${r.stderr}\n${r.stdout}`).toBe(true);
    expect(fs.existsSync(path.join(outDir, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(outDir, 'Plans.md'))).toBe(false);
    expect(fs.existsSync(path.join(outDir, 'SERVIDOR.md'))).toBe(false);

    const { ok, violations } = checkSanitized({ root: outDir, hashesFile });
    // Solo file:line + reason — nunca valores sensibles.
    const summary = violations.map((v) => `${v.file}${v.line != null ? `:${v.line}` : ''} ${v.reason}`).join('\n');
    expect(ok, `export NO sanitizado:\n${summary}`).toBe(true);
  }, 120_000);
});
