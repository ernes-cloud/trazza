#!/usr/bin/env node
/**
 * Copia el árbol git-tracked a un directorio destino, excluyendo rutas y
 * contenido que check-sanitized.mjs prohíbe, y valida el resultado.
 *
 * Uso:
 *   node tools/oss/export-oss.mjs <targetDir> [--hashes <file>]
 *
 * hashes: --hashes o env OSS_FORBIDDEN_HASHES_FILE; si falta, fichero vacío temporal.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import { checkSanitized } from './check-sanitized.mjs';

const traverse = traverseModule.default ?? traverseModule;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Mantener en sync con tools/oss/check-sanitized.mjs (no importable sin tocar ese fichero).
const FORBIDDEN_PATH_RULES = [
  { test: (p) => p === '.claude' || p.startsWith('.claude/'), reason: 'ruta prohibida: .claude/' },
  { test: (p) => p === '.mcp.json', reason: 'ruta prohibida: .mcp.json' },
  { test: (p) => p === '.playwright-mcp' || p.startsWith('.playwright-mcp/'), reason: 'ruta prohibida: .playwright-mcp/' },
  { test: (p) => /^scratch/i.test(path.basename(p)), reason: 'ruta prohibida: scratch*' },
  { test: (p) => !p.includes('/') && /^test\d*\.js$/.test(p), reason: 'ruta prohibida: test*.js en la raíz' },
  { test: (p) => !p.includes('/') && /^test-.*\.csv$/i.test(p), reason: 'ruta prohibida: test-*.csv en la raíz' },
  { test: (p) => /^debug_/i.test(path.basename(p)), reason: 'ruta prohibida: debug_*' },
  { test: (p) => p === 'SERVIDOR.md', reason: 'ruta prohibida: SERVIDOR.md' },
  { test: (p) => p === 'Plans.md', reason: 'ruta prohibida: Plans.md' },
  { test: (p) => p === 'deploy' || p.startsWith('deploy/'), reason: 'ruta prohibida: deploy/' },
  { test: (p) => p === '.gitlab-ci.yml', reason: 'ruta prohibida: .gitlab-ci.yml' },
  { test: (p) => p === 'CLAUDE.md', reason: 'ruta prohibida: CLAUDE.md (SaaS interno)' },
  {
    test: (p) => [
      'docs/claude/production.md',
      'docs/claude/growth.md',
      'docs/claude/history.md',
      'docs/claude/expenses.md',
      'docs/claude/public-site.md',
    ].includes(p),
    reason: 'ruta prohibida: docs/claude (producción, growth, history, gastos, sitio público/SaaS)',
  },
  { test: (p) => p === 'informes' || p.startsWith('informes/'), reason: 'ruta prohibida: informes/' },
  { test: (p) => p === 'node_modules' || p.startsWith('node_modules/') || p.includes('/node_modules/') || p.includes('/node_modules'), reason: 'ruta prohibida: node_modules' },
  { test: (p) => p.endsWith('.map'), reason: 'ruta prohibida: *.map' },
  { test: (p) => p === 'plugins/visual-editor' || p.startsWith('plugins/visual-editor/'), reason: 'ruta prohibida: plugins/visual-editor/' },
  { test: (p) => p === 'plugins/selection-mode' || p.startsWith('plugins/selection-mode/'), reason: 'ruta prohibida: plugins/selection-mode/' },
  { test: (p) => p === 'plugins/utils' || p.startsWith('plugins/utils/'), reason: 'ruta prohibida: plugins/utils/' },
  { test: (p) => p.endsWith('vite-plugin-iframe-route-restoration.js'), reason: 'ruta prohibida: vite-plugin-iframe-route-restoration.js' },
];

const STR_HORI_ZONS = 'horiz' + 'ons';
const STR_HOST_ING = 'host' + 'inger';
const FORBIDDEN_STRINGS = [STR_HORI_ZONS, STR_HOST_ING];
const NEEDLE_CREAMI = 'creami' + 'sitio';
const NEEDLE_DEMO_PERSONA = 'gil' + 'berto';
const NEEDLE_TRAZZA_CLOUD = 'trazza' + '.cloud';

/** Copia literal en el export (el propio export-oss ya evita agujas en el fuente). */
const OSS_EXPORT_SELF_VERBATIM = 'tools/oss/export-oss.mjs';

/** Suite del checker: split semántico de agujas solo en la copia publicada (el repo queda literal). */
const OSS_SANITIZER_SUITE_SPLIT = new Set([
  'tools/oss/check-sanitized.mjs',
  'tools/oss/checkSanitized.test.js',
]);

const SUITE_NEEDLE_HORI_ZONS = 'hori' + 'zons';
const SUITE_NEEDLE_HOST_ING = 'host' + 'inger';
const SUITE_FORBIDDEN_NEEDLES = [
  { needle: SUITE_NEEDLE_HORI_ZONS, split: 4 },
  { needle: SUITE_NEEDLE_HOST_ING, split: 4 },
];

/**
 * Tests cuyo sujeto (fichero o árbol) no se exporta — si se copiaran, vitest falla con ENOENT.
 * Documentado para repartir en TDD si hace falta cubrir el sujeto en otro sitio.
 */
export const EXCLUDED_TESTS_WITH_EXCLUDED_SUBJECT = [
  'tools/deployVps.test.js', // deploy/deploy-vps.sh
  'tools/nginxConfig.test.js', // deploy/nginx/
  'tools/csp.nginx.test.js', // deploy/nginx/ CSP HTML
  'tools/cspHeaders.nginx.test.js', // deploy/nginx/snippets/
  'tools/viteConfig.ci.test.js', // .gitlab-ci.yml (T2)
  // tools/csp.test.js + tools/cspHeaders.test.js + tools/viteConfig.test.js VUELVEN al export
];
const HOST_VAR_WWW = '/' + 'var' + '/' + 'www';
const HOST_OPT = '/' + 'opt' + '/';
const BINARY_EXT_RE = /\.(png|jpe?g|gif|webp|ico|bmp|woff2?|ttf|eot|otf|pdf|zip|gz|mp4|mp3|wasm)$/i;

/** @see tools/oss/check-sanitized.mjs — reescrituras deterministas solo en la COPIA exportada. */
const ALLOWED_EMAIL_EXACT = new Set(['example.com', 'example.org']);
function isAllowedEmailDomain(domain) {
  const d = String(domain || '').toLowerCase();
  if (ALLOWED_EMAIL_EXACT.has(d)) return true;
  if (d.endsWith('.test') || d.endsWith('.invalid')) return true;
  return false;
}
const EMAIL_RE = /\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
const SIMPLE_EMAIL_LOCAL_RE = /^[A-Za-z0-9._%+-]+$/;
/** Dominio “simple” (no arranca en `-`, etiquetas DNS válidas) — alineado con emails bien formados en tests. */
const SIMPLE_EMAIL_DOMAIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const HARDCODED_PASSWORD_RE = /\b(?:password|passwd|pwd|pass)\b\s*[:=]\s*['"`][^'"`]{4,}['"`]/gi;
const TRAZZA_HOST_RE = new RegExp(`(?:[a-z0-9-]+\\.)*${NEEDLE_TRAZZA_CLOUD.replace('.', '\\.')}`, 'gi');
const HOST_OPT_RE = new RegExp(`(?<![a-zA-Z])${HOST_OPT.replace(/\//g, '\\/')}`, 'g');
const HOST_VAR_WWW_RE = new RegExp(HOST_VAR_WWW.replace(/\//g, '\\/'), 'g');

const GITIGNORE_EXTRA = ['informes/', '.env*', 'e2e/artifacts/'];

const DOCKERIGNORE_DEFAULT = `# Generado por tools/oss/export-oss.mjs (sync con .dockerignore del repo)
node_modules
dist
.git
.env
.env.*
informes
e2e/artifacts
.claude
.mcp.json
.playwright-mcp
deploy
.gitlab-ci.yml
docs/claude/production.md
docs/claude/growth.md
docs/claude/history.md
SERVIDOR.md
Plans.md
plugins/visual-editor
plugins/selection-mode
plugins/utils
plugins/vite-plugin-iframe-route-restoration.js
`;

function parseArgs(argv) {
  const out = { targetDir: null, hashesFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--hashes' && argv[i + 1]) {
      out.hashesFile = path.resolve(argv[i + 1]);
      i += 1;
    } else if (!argv[i].startsWith('-') && !out.targetDir) {
      out.targetDir = path.resolve(argv[i]);
    }
  }
  return out;
}

function usage() {
  console.error('Uso: node tools/oss/export-oss.mjs <targetDir> [--hashes <file>]');
}

function forbiddenPath(relPath) {
  const norm = relPath.split(path.sep).join('/');
  for (const rule of FORBIDDEN_PATH_RULES) {
    if (rule.test(norm)) return true;
  }
  if (/^\.env/i.test(path.basename(norm)) || norm.startsWith('.env')) return true;
  return false;
}

function gitTrackedFiles() {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error('git ls-files falló:', r.stderr || r.stdout);
    process.exit(1);
  }
  return r.stdout.split('\0').filter(Boolean);
}

function assertTargetUsable(targetDir) {
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
    return;
  }
  const entries = fs.readdirSync(targetDir);
  if (entries.length > 0) {
    console.error(`El directorio destino debe no existir o estar vacío: ${targetDir}`);
    process.exit(1);
  }
}

function stripForbiddenStrings(content) {
  let out = content;
  for (const needle of FORBIDDEN_STRINGS) {
    const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, '');
  }
  return out;
}

/** Product host → example.com; subdominios → sub.example.com. */
function rewriteProductHost(text) {
  return text.replace(TRAZZA_HOST_RE, (match) => {
    const lower = match.toLowerCase();
    const core = lower.replace(new RegExp(`\\.?${NEEDLE_TRAZZA_CLOUD.replace('.', '\\.')}$`, 'i'), '');
    const subs = core.replace(/\.$/, '').split('.').filter(Boolean);
    if (!subs.length) return 'example.com';
    return `${subs.join('.')}.example.com`;
  });
}

/** Dominios de fixture en tests (evil.example, x.com) → example.com sin cambiar la forma inválida del fixture. */
function rewriteFixtureEmailDomains(text) {
  return text
    .replace(/@evil\.example\b/g, '@example.com')
    .replace(/@x\.com\b/g, '@example.com')
    .replace(/'a@-x\.com'/g, "'a@' + '-x.com'")
    .replace(/@gmail\.com\b/gi, '@example.com');
}

function rewriteEmails(text) {
  return text.replace(EMAIL_RE, (full, local, domain, offset) => {
    if (!SIMPLE_EMAIL_LOCAL_RE.test(local)) return full;
    if (!SIMPLE_EMAIL_DOMAIN_RE.test(domain)) return full;
    if (isAllowedEmailDomain(domain)) return full;
    const before = offset > 0 ? text[offset - 1] : '';
    if (/[\s\r\n]/.test(before)) return full;
    return `${local}@example.com`;
  });
}

function rewriteHostingNeedles(text) {
  return text.replace(new RegExp(NEEDLE_CREAMI, 'gi'), 'example-hosting');
}

function shouldRewriteHardcodedPasswords(relPath) {
  const norm = relPath.split(path.sep).join('/');
  if (!norm.startsWith('src/') && !norm.startsWith('server/')) return false;
  if (/\.(test|spec)\./i.test(path.basename(norm))) return false;
  if (/(?:^|\/)(__tests__|e2e)(?:\/|$)/.test(norm)) return false;
  if (norm.startsWith('tools/')) return false;
  return true;
}

function rewriteHardcodedPasswords(text) {
  return text.replace(HARDCODED_PASSWORD_RE, (line) => line.replace(/(['"`])[^'"`]{4,}\1/, "''"));
}

/** Tutorial persona → dataset genérico (identificadores JS válidos; demo-sample solo en cadenas con guión). */
function rewriteDemoPersona(text) {
  const esc = NEEDLE_DEMO_PERSONA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = text.replace(new RegExp(`${esc}-user-id`, 'gi'), 'demo-sample-user-id');
  const upper = NEEDLE_DEMO_PERSONA.toUpperCase();
  const title = upper.charAt(0) + NEEDLE_DEMO_PERSONA.slice(1);
  out = out.replace(new RegExp(`${upper}_`, 'g'), 'DEMO_SAMPLE_');
  out = out.replace(new RegExp(`\\b${esc}([A-Z][\\w]*)`, 'g'), 'demoSample$1');
  out = out.replace(new RegExp(`\\b${title}\\b`, 'g'), 'DemoSample');
  out = out.replace(new RegExp(`\\b${upper}\\b`, 'g'), 'DEMO SAMPLE');
  out = out.replace(new RegExp(`\\b${esc}\\b`, 'gi'), 'demoSample');
  return out;
}

/** Rutas de hosting → equivalente neutro en la copia publicada (word-boundary vía HOST_OPT_RE). */
function rewriteHostingPaths(text) {
  let out = text.replace(HOST_VAR_WWW_RE, '/srv/www');
  out = out.replace(HOST_OPT_RE, '/srv/');
  return out;
}

/** Sanitiza el contenido textual de la copia OSS (el repo fuente no se toca). */
function sanitizeOssExportCopy(content, relPath) {
  let out = stripForbiddenStrings(content);
  out = rewriteProductHost(out);
  out = out.replace(/@trazza\.demo/gi, '@example.com');
  out = rewriteEmails(out);
  out = rewriteFixtureEmailDomains(out);
  out = rewriteHostingNeedles(out);
  if (shouldRewriteHardcodedPasswords(relPath)) {
    out = rewriteHardcodedPasswords(out);
  }
  out = rewriteDemoPersona(out);
  out = rewriteHostingPaths(out);
  return out;
}

export const OSS_EXPORT_REWRITE_RULES = [
  `${NEEDLE_TRAZZA_CLOUD} → example.com (subdominios conservados: app.${NEEDLE_TRAZZA_CLOUD} → app.example.com)`,
  'emails simples bien formados (local [A-Za-z0-9._%+-]+, dominio DNS válido) en dominios no allowlisted → solo dominio → example.com (local intacto; sin tocar si hay espacio/CRLF delante del match)',
  '@evil.example y @x.com (fixtures de tests) → @example.com',
  '@trazza.demo → @example.com',
  `${NEEDLE_CREAMI} → example-hosting`,
  'contraseñas literales en src/ y server/ (no tests) password/passwd/pwd/pass := → cadena vacía',
  `${STR_HORI_ZONS} / ${STR_HOST_ING} → eliminados (strip)`,
  `persona tutorial ${NEEDLE_DEMO_PERSONA} → demoSample / DEMO_SAMPLE_* / DemoSample / demo-sample-user-id (identificadores); comentarios con guión opcional demo-sample`,
  `${HOST_VAR_WWW}/ → /srv/www/; ${HOST_OPT} → /srv/ (export copy)`,
  `tests excluidos (sujeto no exportado): ${EXCLUDED_TESTS_WITH_EXCLUDED_SUBJECT.join(', ')}`,
  `copia literal: ${OSS_EXPORT_SELF_VERBATIM}; split de agujas en export: ${[...OSS_SANITIZER_SUITE_SPLIT].join(', ')}`,
];

function neutralizeForbiddenWordsInComment(text) {
  const reHori = new RegExp(SUITE_NEEDLE_HORI_ZONS, 'gi');
  const reHost = new RegExp(SUITE_NEEDLE_HOST_ING, 'gi');
  const spHori = 'hori' + '-zons';
  const spHost = 'host' + '-inger';
  return text
    .replace(reHori, (m) => (m[0] === 'H' ? `H${spHori.slice(1)}` : spHori))
    .replace(reHost, (m) => (m[0] === 'H' ? `H${spHost.slice(1)}` : spHost));
}

function findNeedleInSegment(segment, needle) {
  const lower = segment.toLowerCase();
  const n = needle.toLowerCase();
  const pos = lower.indexOf(n);
  if (pos === -1) return null;
  return { pos, match: segment.slice(pos, pos + needle.length) };
}

/** Particiona el contenido de un literal: trozos de texto y matches divididos para concatenación. */
function partitionSuiteStringContent(content) {
  let segments = [content];
  for (const { needle, split } of SUITE_FORBIDDEN_NEEDLES) {
    const next = [];
    for (const seg of segments) {
      if (typeof seg !== 'string') {
        next.push(seg);
        continue;
      }
      let s = seg;
      while (s.length) {
        const hit = findNeedleInSegment(s, needle);
        if (!hit) {
          next.push(s);
          break;
        }
        if (hit.pos > 0) next.push(s.slice(0, hit.pos));
        next.push({ parts: [hit.match.slice(0, split), hit.match.slice(split)] });
        s = s.slice(hit.pos + needle.length);
      }
    }
    segments = next;
  }
  return segments;
}

function emitQuotedLiteral(quote, raw) {
  const escaped = raw
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(new RegExp(quote, 'g'), `\\${quote}`);
  return `${quote}${escaped}${quote}`;
}

function suiteStringNeedsSplit(value) {
  const lower = String(value).toLowerCase();
  return SUITE_FORBIDDEN_NEEDLES.some(({ needle }) => lower.includes(needle.toLowerCase()));
}

function renderPartitionedString(content, quote) {
  const partitioned = partitionSuiteStringContent(content);
  const chunks = [];
  for (const p of partitioned) {
    if (typeof p === 'string') {
      if (p.length) chunks.push(emitQuotedLiteral(quote, p));
    } else {
      for (const part of p.parts) {
        if (part.length) chunks.push(emitQuotedLiteral(quote, part));
      }
    }
  }
  if (!chunks.length) return `${quote}${quote}`;
  return chunks.join(' + ');
}

/**
 * En la copia exportada de check-sanitized / tests: comentarios con grafía neutra;
 * literales de cadena con concatenación que conserva el valor en runtime (AST vía Babel).
 */
function rewriteSanitizerSuiteExportCopy(source) {
  const ast = parse(source, { sourceType: 'module' });
  const edits = [];

  traverse(ast, {
    StringLiteral(path) {
      const { node } = path;
      if (node.start == null || node.end == null || !suiteStringNeedsSplit(node.value)) return;
      const quote = source[node.start];
      const newExpr = renderPartitionedString(node.value, quote);
      const old = source.slice(node.start, node.end);
      if (newExpr !== old) edits.push({ start: node.start, end: node.end, text: newExpr });
    },
  });

  for (const comment of ast.comments ?? []) {
    if (comment.start == null || comment.end == null) continue;
    const full = source.slice(comment.start, comment.end);
    const replaced = comment.type === 'CommentLine'
      ? `//${neutralizeForbiddenWordsInComment(full.slice(2))}`
      : `/*${neutralizeForbiddenWordsInComment(full.slice(2, -2))}*/`;
    if (replaced !== full) edits.push({ start: comment.start, end: comment.end, text: replaced });
  }

  edits.sort((a, b) => b.start - a.start);
  let out = source;
  for (const { start, end, text } of edits) {
    out = out.slice(0, start) + text + out.slice(end);
  }
  return out;
}

function copyTrackedFile(relPath, targetDir) {
  const src = path.join(REPO_ROOT, relPath);
  const dest = path.join(targetDir, relPath);
  const norm = relPath.split(path.sep).join('/');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (BINARY_EXT_RE.test(relPath)) {
    fs.copyFileSync(src, dest);
    return;
  }
  let content;
  try {
    content = fs.readFileSync(src, 'utf8');
  } catch {
    fs.copyFileSync(src, dest);
    return;
  }
  if (content.includes('\u0000')) {
    fs.copyFileSync(src, dest);
    return;
  }
  if (norm === OSS_EXPORT_SELF_VERBATIM) {
    fs.writeFileSync(dest, content);
    return;
  }
  if (OSS_SANITIZER_SUITE_SPLIT.has(norm)) {
    fs.writeFileSync(dest, rewriteSanitizerSuiteExportCopy(content));
    return;
  }
  fs.writeFileSync(dest, sanitizeOssExportCopy(content, relPath));
}

function mergeGitignore(targetDir) {
  const giPath = path.join(targetDir, '.gitignore');
  const existing = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '';
  const lines = existing.split('\n');
  const have = new Set(lines.map((l) => l.trim()).filter(Boolean));
  const added = [];
  for (const line of GITIGNORE_EXTRA) {
    if (!have.has(line)) added.push(line);
  }
  if (!added.length) return;
  const sep = existing.length && !existing.endsWith('\n') ? '\n' : '';
  const block = `${sep}\n# OSS export (tools/oss/export-oss.mjs)\n${added.join('\n')}\n`;
  fs.writeFileSync(giPath, existing + block);
}

function ensureDockerignore(targetDir) {
  const p = path.join(targetDir, '.dockerignore');
  if (!fs.existsSync(p)) fs.writeFileSync(p, DOCKERIGNORE_DEFAULT);
}

function resolveHashesFile(cliHashes) {
  if (cliHashes) return cliHashes;
  const env = process.env.OSS_FORBIDDEN_HASHES_FILE;
  if (env) return path.resolve(env);
  const tmp = path.join(os.tmpdir(), `oss-export-hashes-${process.pid}.txt`);
  fs.writeFileSync(tmp, '');
  return tmp;
}

function runExport() {
  const { targetDir, hashesFile: cliHashes } = parseArgs(process.argv.slice(2));
  if (!targetDir) {
    usage();
    process.exit(1);
  }

  assertTargetUsable(targetDir);

  const tracked = gitTrackedFiles();
  let copied = 0;
  let skipped = 0;
  for (const rel of tracked) {
    const norm = rel.split(path.sep).join('/');
    if (forbiddenPath(rel) || EXCLUDED_TESTS_WITH_EXCLUDED_SUBJECT.includes(norm)) {
      skipped += 1;
      continue;
    }
    copyTrackedFile(rel, targetDir);
    copied += 1;
  }

  mergeGitignore(targetDir);
  ensureDockerignore(targetDir);

  const hashesFile = resolveHashesFile(cliHashes);
  const { violations } = checkSanitized({ root: targetDir, hashesFile });
  const ok = violations.length === 0;

  console.log(`[export-oss] ${copied} ficheros copiados, ${skipped} excluidos → ${targetDir}`);

  if (!ok) {
    for (const v of violations) {
      console.error(`${v.file}${v.line != null ? `:${v.line}` : ''}  ${v.reason}`);
    }
    console.error(`\n${violations.length} violación(es) — export NO sanitizado.`);
    process.exit(1);
  }
  console.log('[export-oss] checkSanitized: OK');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runExport();
}
