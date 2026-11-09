#!/usr/bin/env node
/**
 * T2 (OSS): comprueba que un árbol (el repo, o un dist/ de build) está
 * "sanitizado" para publicarse como OSS — sin ficheros de la infraestructura
 * interna de desarrollo (.claude/, .mcp.json, capturas de Playwright MCP,
 * scripts de scratch, notas internas…), sin cadenas que delaten el hosting
 * interno (hori-zons/host-inger) y sin ningún token cuyo sha256 coincida con
 * uno de la lista negra de OSS_FORBIDDEN_HASHES_FILE (API keys, JWT, etc. —
 * nunca se imprime el valor, solo fichero:línea).
 *
 * Uso como librería:
 *   import { checkSanitized } from './check-sanitized.mjs';
 *   const { ok, violations } = checkSanitized({ root, distDir, hashesFile });
 *
 * Uso como CLI:
 *   OSS_FORBIDDEN_HASHES_FILE=/ruta/hashes.txt node tools/oss/check-sanitized.mjs [--dist dist]
 *   Sale con 1 si hay violaciones, o si falta OSS_FORBIDDEN_HASHES_FILE.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_DEFAULT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ── Rutas/patrones prohibidos en cualquier parte del árbol ────────────────────
// Cada entrada: { test(relPath) → bool, reason }. relPath usa '/' siempre.
const FORBIDDEN_PATH_RULES = [
  { test: (p) => p === '.claude' || p.startsWith('.claude/'), reason: 'ruta prohibida: .claude/' },
  { test: (p) => p === '.mcp.json', reason: 'ruta prohibida: .mcp.json' },
  { test: (p) => p === '.playwright-mcp' || p.startsWith('.playwright-mcp/'), reason: 'ruta prohibida: .playwright-mcp/' },
  { test: (p) => /^scratch/i.test(path.basename(p)), reason: 'ruta prohibida: scratch*' },
  { test: (p) => !p.includes('/') && /^test\d*\.js$/.test(p), reason: 'ruta prohibida: test*.js en la raíz' },
  { test: (p) => /^debug_/i.test(path.basename(p)), reason: 'ruta prohibida: debug_*' },
  { test: (p) => p === 'SERVIDOR.md', reason: 'ruta prohibida: SERVIDOR.md' },
  { test: (p) => p === 'Plans.md', reason: 'ruta prohibida: Plans.md' },
  { test: (p) => p === 'deploy' || p.startsWith('deploy/'), reason: 'ruta prohibida: deploy/' },
  { test: (p) => p === '.gitlab-ci.yml', reason: 'ruta prohibida: .gitlab-ci.yml' },
  {
    test: (p) => ['docs/claude/production.md', 'docs/claude/growth.md', 'docs/claude/history.md'].includes(p),
    reason: 'ruta prohibida: docs/claude/{production,growth,history}.md',
  },
  { test: (p) => p === 'informes' || p.startsWith('informes/'), reason: 'ruta prohibida: informes/' },
  { test: (p) => p === 'node_modules' || p.startsWith('node_modules/') || p.includes('/node_modules/') || p.includes('/node_modules'), reason: 'ruta prohibida: node_modules' },
  { test: (p) => p.endsWith('.map'), reason: 'ruta prohibida: *.map' },
  { test: (p) => p === 'plugins/visual-editor' || p.startsWith('plugins/visual-editor/'), reason: 'ruta prohibida: plugins/visual-editor/' },
  { test: (p) => p === 'plugins/selection-mode' || p.startsWith('plugins/selection-mode/'), reason: 'ruta prohibida: plugins/selection-mode/' },
  { test: (p) => p === 'plugins/utils' || p.startsWith('plugins/utils/'), reason: 'ruta prohibida: plugins/utils/' },
  { test: (p) => p.endsWith('vite-plugin-iframe-route-restoration.js'), reason: 'ruta prohibida: vite-plugin-iframe-route-restoration.js' },
];

// Directorios que NUNCA se recorren (ni se listan como ficheros individuales,
// para no reventar el runtime con miles de ficheros de node_modules). `.git`
// no es una violación (es parte normal de un repo); `node_modules` SÍ lo es
// si aparece (no debería existir en el árbol publicable), pero no se
// desciende dentro de él.
const SKIP_DESCEND_DIRS = new Set(['.git', 'node_modules']);

// Cadenas que delatan el hosting/infra interna — nunca deben aparecer en el
// contenido de ningún fichero (case-insensitive). "hori-zons-*" cubre los
// mensajes postMessage del error handler de vite.config.js.
const NEEDLE_CREAMI = 'creami' + 'sitio';
const NEEDLE_TRAZZA_CLOUD = 'trazza' + '.cloud';
const NEEDLE_DEMO_PERSONA = 'gil' + 'berto';
const FORBIDDEN_STRINGS = ['hori' + 'zons', 'host' + 'inger', NEEDLE_CREAMI, NEEDLE_DEMO_PERSONA];

// Extensiones binarias: no merece la pena ni es seguro leerlas como utf8.
const BINARY_EXT_RE = /\.(png|jpe?g|gif|webp|ico|bmp|woff2?|ttf|eot|otf|pdf|zip|gz|mp4|mp3|wasm)$/i;

/** Emails permitidos: example.com, example.org, y cualquier dominio *.test / *.invalid. */
const ALLOWED_EMAIL_EXACT = new Set(['example.com', 'example.org']);
function isAllowedEmailDomain(domain) {
  const d = String(domain || '').toLowerCase();
  if (ALLOWED_EMAIL_EXACT.has(d)) return true;
  if (d.endsWith('.test') || d.endsWith('.invalid')) return true;
  return false;
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

/** password / passwd / pwd asignados a literales (no imprime el valor). */
const HARDCODED_PASSWORD_RE = /\b(?:password|passwd|pwd|pass)\b\s*[:=]\s*['"`][^'"`]{4,}['"`]/i;


/** Host de producto solo en .env.example o ficheros de configuración. */
function allowsProductHost(relPath) {
  const base = path.basename(relPath);
  const norm = relPath.replace(/\\/g, '/');
  if (/^\.env\.example$/i.test(base)) return true;
  if (/(^|\/)config\//i.test(norm)) return true;
  if (/\.config\.(js|mjs|cjs|ts|json)$/i.test(base)) return true;
  return false;
}

/** Rutas de hosting interno en contenido (construir para no auto-flaggear este fichero). */
const HOST_OPT = '/' + 'opt' + '/';
const HOST_VAR_WWW = '/' + 'var' + '/' + 'www';

/** Enlaces markdown relativos [txt](rel.md) — no http(s)/mailto/#/abs. */
const MD_REL_LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;
function isRelativeMdHref(href) {
  const h = String(href || '').trim().replace(/^<|>$/g, '');
  if (!h) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return false; // http:, mailto:, …
  if (h.startsWith('#') || h.startsWith('/')) return false;
  const pathOnly = h.split('#')[0].split('?')[0];
  return pathOnly.length > 0;
}
function checkBrokenMdLinks(relPath, abs, content, violations, displayPath) {
  if (!/\.md$/i.test(relPath)) return;
  const dir = path.dirname(abs);
  MD_REL_LINK_RE.lastIndex = 0;
  const lines = content.split(/\r?\n/);
  // Scan per-line for line numbers without printing href values.
  lines.forEach((line, idx) => {
    MD_REL_LINK_RE.lastIndex = 0;
    let m;
    while ((m = MD_REL_LINK_RE.exec(line)) !== null) {
      const href = m[1].trim();
      if (!isRelativeMdHref(href)) continue;
      const pathOnly = href.split('#')[0].split('?')[0];
      const target = path.resolve(dir, pathOnly);
      if (!fs.existsSync(target)) {
        violations.push({
          file: displayPath,
          line: idx + 1,
          reason: 'enlace .md relativo roto',
        });
      }
    }
  });
}

/** Tokeniza una línea en candidatos "token": conserva caracteres típicos de
 * API keys / JWT / base64 (letras, dígitos, _, -, ., /, +, =) y corta por el
 * resto (espacios, comillas, llaves, comas…). */
function extractTokens(line) {
  return line.split(/[^A-Za-z0-9_\-./+=]+/).filter((t) => t.length >= 8); // <8: ruido (palabras sueltas)
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Recorrido manual del árbol (no depende de git): devuelve rutas relativas con '/'. */
function walk(root) {
  const out = [];
  const rec = (abs, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = path.join(abs, e.name);
      if (e.isDirectory()) {
        out.push({ relPath: childRel, isDir: true });
        if (SKIP_DESCEND_DIRS.has(e.name)) continue;
        rec(childAbs, childRel);
      } else if (e.isFile() || e.isSymbolicLink()) {
        out.push({ relPath: childRel, isDir: false });
      }
    }
  };
  rec(root, '');
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.root        raíz a recorrer (p. ej. el repo)
 * @param {string} [opts.distDir]   build opcional a recorrer también (dist/)
 * @param {string} [opts.hashesFile] fichero con un sha256 hex por línea (líneas
 *   vacías o que empiezan por # se ignoran). Si falta o no existe → violación
 *   única y clara, sin recorrer nada más.
 * @returns {{ ok: boolean, violations: Array<{file: string, line: number|null, reason: string}> }}
 */
export function checkSanitized({ root = ROOT_DEFAULT, distDir = null, hashesFile } = {}) {
  const violations = [];

  if (!hashesFile || !fs.existsSync(hashesFile)) {
    return {
      ok: false,
      violations: [{
        file: '(config)',
        line: null,
        reason: `OSS_FORBIDDEN_HASHES_FILE no definido o no existe: ${hashesFile ?? '(sin definir)'}`,
      }],
    };
  }

  const forbiddenHashes = new Set(
    fs.readFileSync(hashesFile, 'utf8')
      .split('\n')
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l && !l.startsWith('#')),
  );
  const checkHashes = forbiddenHashes.size > 0;

  const trees = [{ base: root, label: '' }];
  if (distDir) trees.push({ base: distDir, label: 'dist/' });

  for (const { base, label } of trees) {
    if (!fs.existsSync(base)) continue;
    const entries = walk(base);

    for (const { relPath, isDir } of entries) {
      const displayPath = label ? `${label}${relPath}` : relPath;

      for (const rule of FORBIDDEN_PATH_RULES) {
        if (rule.test(relPath)) {
          violations.push({ file: displayPath, line: null, reason: rule.reason });
        }
      }

      if (isDir) continue;
      if (BINARY_EXT_RE.test(relPath)) continue;

      const abs = path.join(base, relPath);
      let content;
      try {
        content = fs.readFileSync(abs, 'utf8');
      } catch {
        continue; // ilegible/binario real pese a la extensión: se ignora el contenido
      }
      if (content.includes('\u0000')) continue; // binario

      const lines = content.split(/\r?\n/);
      const lowerContent = content.toLowerCase();
      const hasForbiddenString = FORBIDDEN_STRINGS.some((s) => lowerContent.includes(s));
      const mayHaveEmail = content.includes('@');
      const mayHavePassword = /\b(?:password|passwd|pwd|pass)\b\s*[:=]/i.test(content);
      const mayHaveTrazza = lowerContent.includes(NEEDLE_TRAZZA_CLOUD);
      const mayHaveHosting = lowerContent.includes(HOST_OPT) || lowerContent.includes(HOST_VAR_WWW);
      const mayHaveMdLinks = /\.md$/i.test(relPath) && content.includes('](');
      const scanContent = hasForbiddenString || checkHashes || mayHaveEmail || mayHavePassword
        || mayHaveTrazza || mayHaveHosting || mayHaveMdLinks;
      if (!scanContent) continue;

      const allowCloud = allowsProductHost(relPath);

      checkBrokenMdLinks(relPath, abs, content, violations, displayPath);

      lines.forEach((line, idx) => {
        const lower = line.toLowerCase();
        for (const needle of FORBIDDEN_STRINGS) {
          if (lower.includes(needle)) {
            violations.push({ file: displayPath, line: idx + 1, reason: `cadena prohibida: ${needle}` });
          }
        }
        if (checkHashes) {
          for (const token of extractTokens(line)) {
            if (forbiddenHashes.has(sha256Hex(token))) {
              violations.push({ file: displayPath, line: idx + 1, reason: 'token coincide con un hash de OSS_FORBIDDEN_HASHES_FILE' });
            }
          }
        }
        // Emails personales: no imprimir el valor, solo file:line.
        EMAIL_RE.lastIndex = 0;
        let em;
        while ((em = EMAIL_RE.exec(line)) !== null) {
          const domain = em[1].toLowerCase();
          if (!isAllowedEmailDomain(domain)) {
            violations.push({ file: displayPath, line: idx + 1, reason: 'email personal (dominio no allowlisted)' });
          }
        }
        if (HARDCODED_PASSWORD_RE.test(line)) {
          violations.push({ file: displayPath, line: idx + 1, reason: 'contraseña hardcodeada' });
        }
        if (!allowCloud && lower.includes(NEEDLE_TRAZZA_CLOUD)) {
          violations.push({ file: displayPath, line: idx + 1, reason: `${NEEDLE_TRAZZA_CLOUD} fuera de .env.example/config` });
        }
        if (lower.includes(HOST_OPT)) {
          violations.push({ file: displayPath, line: idx + 1, reason: `ruta de hosting interna: ${HOST_OPT}` });
        }
        if (lower.includes(HOST_VAR_WWW)) {
          violations.push({ file: displayPath, line: idx + 1, reason: `ruta de hosting interna: ${HOST_VAR_WWW}` });
        }
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

// ── CLI ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { root: ROOT_DEFAULT, distDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root' && argv[i + 1]) { out.root = path.resolve(argv[i + 1]); i += 1; }
    else if (argv[i] === '--dist' && argv[i + 1]) { out.distDir = path.resolve(argv[i + 1]); i += 1; }
  }
  return out;
}

function runCli() {
  const { root, distDir } = parseArgs(process.argv.slice(2));
  const hashesFile = process.env.OSS_FORBIDDEN_HASHES_FILE
    ? path.resolve(process.env.OSS_FORBIDDEN_HASHES_FILE)
    : undefined;

  if (!hashesFile) {
    console.error('OSS_FORBIDDEN_HASHES_FILE no está definida. Define la ruta a un fichero con un sha256 por línea (puede estar vacío) antes de ejecutar este check.');
    process.exit(1);
  }

  const { ok, violations } = checkSanitized({ root, distDir, hashesFile });
  if (!ok) {
    for (const v of violations) {
      console.error(`${v.file}${v.line ? `:${v.line}` : ''}  ${v.reason}`);
    }
    console.error(`\n${violations.length} violación(es) — árbol NO sanitizado para publicar como OSS.`);
    process.exit(1);
  }
  console.log('OSS sanitize check: OK');
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
