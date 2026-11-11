/**
 * P0-1: el export OSS reintegra Gastos de verdad (UI, rutas, tablas,
 * migraciones, docs de usuario, cron parametrizable) y no arrastra
 * allowlist del owner, emails reales ni el DROP de oss_remove_modules
 * sobre las tablas de Gastos.
 *
 * Los hallazgos se reportan solo como fichero:línea + reason.
 * Nunca se imprimen emails, secretos ni PII.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkSanitized } from './check-sanitized.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const EXPORT_SCRIPT = path.join(ROOT, 'tools/oss/export-oss.mjs');

const GASTOS_TABLES = ['expense_entries', 'expense_projects', 'savings_goals'];
const GASTOS_TABLES_WITH_PREFS = [...GASTOS_TABLES, 'user_preferences'];

const REQUIRED_EXPORT_PATHS = [
  'src/pages/ExpensesPage.jsx',
  'src/lib/expensesAccess.js',
  'src/services/expenseService.js',
];

const REQUIRED_GASTOS_TEST_PATHS = [
  'src/services/expenseService.test.js',
  'src/services/expenses/multicurrency.test.js',
  'src/lib/expensesAccess.test.js',
  'tools/gastos/gastosP0Security.pg.test.js',
];

const SKIP_SCAN_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.vite']);
const CODE_EXT = /\.(js|jsx|mjs|cjs|ts|tsx|md|sql)$/i;
const EMAIL_RE = /[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi;
const EXAMPLE_EMAIL_RE = /@(?:example\.com|example\.org|example\.net)$/i;

let exportDir = null;
let exportStatus = null;
let hashesFile = null;
const tmpDirs = [];

function mkTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function formatHits(hits) {
  return hits.map((h) => `${h.file}${h.line != null ? `:${h.line}` : ''} ${h.reason}`).join('\n');
}

function walkFiles(root) {
  const out = [];
  const rec = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_SCAN_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) rec(abs);
      else if (e.isFile()) out.push(abs);
    }
  };
  rec(root);
  return out;
}

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

/**
 * Detecta allowlist de Gastos o emails no-example en el bundle.
 * Devuelve {file, line, reason} — nunca el valor encontrado.
 */
function scanGastosAllowlistAndEmails(root) {
  const hits = [];
  if (!fs.existsSync(root)) return hits;
  for (const abs of walkFiles(root)) {
    if (!CODE_EXT.test(abs)) continue;
    const rel = path.relative(root, abs).replaceAll('\\', '/');
    if (rel.startsWith('tools/oss/')) continue;
    let content;
    try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      const n = i + 1;
      if (/\bEXPENSES_ALLOWED_EMAILS\b/.test(line)) {
        hits.push({ file: rel, line: n, reason: 'allowlist EXPENSES_ALLOWED_EMAILS en el bundle de Gastos' });
      }
      if (/\bALLOWED_EMAILS\b/.test(line) && /expense/i.test(rel)) {
        hits.push({ file: rel, line: n, reason: 'ALLOWED_EMAILS en módulo de Gastos' });
      }
      if (/\bexpensesAllowedEmails\b/.test(line) || /\bEXPENSES_ALLOWLIST\b/.test(line)) {
        hits.push({ file: rel, line: n, reason: 'identificador de allowlist de Gastos' });
      }
    });
    // Emails reales (no @example.*) en el bundle de Gastos o en expensesAccess.
    // Bundle de producto de Gastos, no la propia suite de contrato en tools/oss.
    const inGastosBundle = /^(src\/(pages\/Expenses|lib\/expensesAccess|services\/expense|services\/expenses|components\/expenses|hooks\/useExpense|hooks\/useSavingsGoals|contexts\/Expenses)|tools\/gastos|docs\/gastos\.md)/i.test(rel);
    if (!inGastosBundle) continue;
    EMAIL_RE.lastIndex = 0;
    let m;
    while ((m = EMAIL_RE.exec(content))) {
      const addr = m[0];
      if (EXAMPLE_EMAIL_RE.test(addr)) continue;
      hits.push({
        file: rel,
        line: lineOf(content, m.index),
        reason: 'email no-example en el bundle de Gastos',
      });
    }
  }
  return hits;
}

function isExpensesAccessUniversal(src) {
  if (!src) return false;
  if (/\bEXPENSES_ALLOWED_EMAILS\b/.test(src)) return false;
  if (/\bALLOWED_EMAILS\b/.test(src)) return false;
  // Una función de acceso que consulta una lista no es opt-in universal.
  if (/isExpensesFeatureAllowed[\s\S]{0,400}\.includes\(/.test(src)) return false;
  if (/isExpensesFeatureAllowed[\s\S]{0,400}\.has\(/.test(src)) return false;
  if (/isExpensesFeatureAllowed[\s\S]{0,400}Set\(/.test(src)) return false;
  return /export\s+function\s+isExpensesFeatureAllowed/.test(src)
    || /export\s+const\s+isExpensesFeatureAllowed/.test(src);
}

function listExportMigrations(dir) {
  const mig = path.join(dir, 'supabase/migrations');
  if (!fs.existsSync(mig)) return [];
  return fs.readdirSync(mig).filter((f) => f.endsWith('.sql')).sort();
}

function exportMigrationContents(dir) {
  const mig = path.join(dir, 'supabase/migrations');
  return listExportMigrations(dir).map((f) => ({
    file: `supabase/migrations/${f}`,
    text: fs.readFileSync(path.join(mig, f), 'utf8'),
  }));
}

function findDropHits(dir) {
  const hits = [];
  const dropRe = /drop\s+table\s+(if\s+exists\s+)?(public\.)?(expense_entries|expense_projects|savings_goals)\b/gi;
  for (const { file, text } of exportMigrationContents(dir)) {
    dropRe.lastIndex = 0;
    let m;
    while ((m = dropRe.exec(text))) {
      hits.push({
        file,
        line: lineOf(text, m.index),
        reason: `DROP de tabla de Gastos (${m[3]}) en el export`,
      });
    }
  }
  return hits;
}

function findCreateTableHits(dir, table) {
  const re = new RegExp(`create\\s+table\\s+(if\\s+not\\s+exists\\s+)?(public\\.)?${table}\\b`, 'i');
  return exportMigrationContents(dir).some(({ text }) => re.test(text));
}

function whichCmd(name) {
  const r = spawnSync('bash', ['-lc', `command -v ${name} || true`], { encoding: 'utf8' });
  const p = (r.stdout || '').trim();
  return p || null;
}

function scanHardcodedCron(dir) {
  const hits = [];
  const targets = [
    'server/jobs/notificationCron.js',
    'server/notificationCron.js',
    'server/lib/notificationCron.js',
    'src/lib/notificationCron.js',
  ];
  const files = [];
  for (const rel of targets) {
    const abs = path.join(dir, rel);
    if (fs.existsSync(abs)) files.push({ rel, abs });
  }
  // Implementación de cron de Gastos, nunca tests (*.test.js).
  const serverRoot = path.join(dir, 'server');
  if (fs.existsSync(serverRoot)) {
    for (const abs of walkFiles(serverRoot)) {
      if (!CODE_EXT.test(abs)) continue;
      if (/\.test\.\w+$/.test(abs)) continue;
      const rel = path.relative(dir, abs).replaceAll('\\', '/');
      if (files.some((f) => f.rel === rel)) continue;
      let text;
      try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      if (/recurring-end|recurringEnd|expenses?|gastos/i.test(text) && /timeZone|setInterval|cron/i.test(text)) {
        files.push({ rel, abs });
      }
    }
  }
  for (const { rel, abs } of files) {
    const text = fs.readFileSync(abs, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const n = i + 1;
      if (/Europe\/Madrid/.test(line)) {
        hits.push({ file: rel, line: n, reason: 'zona horaria Europe/Madrid incrustada' });
      }
      if (/6\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(line) && /setInterval\(\s*runRecurringEnd/.test(line)) {
        // Permitido solo como fallback de un env (process.env.… || 6*60*60*1000)
        if (!/process\.env\.[A-Z0-9_]+\s*\|\|/.test(line) && !/Number\(process\.env/.test(line)) {
          hits.push({ file: rel, line: n, reason: 'intervalo de cron de Gastos incrustado (6h fijas)' });
        }
      }
    });
    // Si el cron de recurring-end no lee ninguna env de TZ o intervalo, también es rojo.
    if (/recurring-end|recurringEndAlert|notifyRecurring/i.test(text)) {
      const hasTzEnv = /process\.env\.(APP_TIMEZONE|TZ|NOTIFICATION_TIMEZONE|EXPENSES_TIMEZONE|CRON_TIMEZONE)/.test(text);
      const hasIntervalEnv = /process\.env\.(EXPENSES_RECURRING_END_INTERVAL_MS|NOTIFICATION_INTERVAL_MS|CRON_INTERVAL_MS|RECURRING_END_INTERVAL_MS)/.test(text);
      if (!hasTzEnv) {
        hits.push({ file: rel, line: null, reason: 'cron de Gastos sin zona horaria parametrizable (env)' });
      }
      if (!hasIntervalEnv) {
        hits.push({ file: rel, line: null, reason: 'cron de Gastos sin intervalo parametrizable (env)' });
      }
    }
  }
  return hits;
}

function findUserDocs(dir) {
  const docs = path.join(dir, 'docs');
  const hits = [];
  if (!fs.existsSync(docs)) return hits;
  const rec = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) rec(abs);
      else if (e.isFile() && e.name.endsWith('.md')) hits.push(path.relative(dir, abs).replaceAll('\\', '/'));
    }
  };
  rec(docs);
  return hits;
}

beforeAll(() => {
  expect(fs.existsSync(EXPORT_SCRIPT), 'falta tools/oss/export-oss.mjs').toBe(true);
  const tmp = mkTmp('oss-p01-hashes-');
  hashesFile = writeFile(tmp, 'hashes.txt', '');
  exportDir = mkTmp('oss-p01-export-');
  const r = spawnSync(process.execPath, [EXPORT_SCRIPT, exportDir, '--hashes', hashesFile], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, OSS_FORBIDDEN_HASHES_FILE: hashesFile },
  });
  exportStatus = r;
}, 180_000);

afterAll(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('P0-1 bloque 1 — el export incluye UI, rutas, tablas y migraciones de Gastos', () => {
  it('export-oss.mjs termina y crea el árbol destino', () => {
    expect(exportDir, 'no se asignó el directorio de export').toBeTruthy();
    expect(
      fs.existsSync(exportDir),
      `export no creó el destino (status=${exportStatus?.status})\n${exportStatus?.stderr || ''}\n${exportStatus?.stdout || ''}`,
    ).toBe(true);
    expect(exportStatus?.status, `export-oss salió ${exportStatus?.status}`).toBe(0);
  });

  it('el export contiene la UI y el acceso de Gastos', () => {
    const missing = REQUIRED_EXPORT_PATHS.filter((rel) => !fs.existsSync(path.join(exportDir, rel)));
    expect(missing, `faltan en el export: ${missing.join(', ')}`).toEqual([]);
  });

  it('App.jsx del export monta ExpensesPage y path="gastos"', () => {
    const app = path.join(exportDir, 'src/App.jsx');
    expect(fs.existsSync(app), 'falta src/App.jsx en el export').toBe(true);
    const src = fs.existsSync(app) ? fs.readFileSync(app, 'utf8') : '';
    expect(src.includes('ExpensesPage'), 'el export no referencia ExpensesPage').toBe(true);
    expect(src.includes('path="gastos"'), 'el export no monta path="gastos"').toBe(true);
  });

  it('las migraciones del export crean las tablas de Gastos', () => {
    const missing = GASTOS_TABLES.filter((t) => !findCreateTableHits(exportDir, t));
    expect(missing, `el export no crea: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('P0-1 bloque 2 — cero emails reales y cero allowlist del owner; opt-in universal', () => {
  it('el detector señala una fixture con allowlist y email no-example (caso negativo)', () => {
    const fixture = mkTmp('oss-p01-allowlist-fx-');
    writeFile(fixture, 'src/lib/expensesAccess.js', [
      'export const EXPENSES_ALLOWED_EMAILS = [',
      "  'owner.user@denied-example.test',",
      '];',
      'export function isExpensesFeatureAllowed(email) {',
      '  return EXPENSES_ALLOWED_EMAILS.includes(String(email).toLowerCase());',
      '}',
      '',
    ].join('\n'));
    const hits = scanGastosAllowlistAndEmails(fixture);
    expect(hits.length, 'el detector debía encontrar allowlist + email en la fixture').toBeGreaterThan(0);
    expect(hits.some((h) => h.reason.includes('EXPENSES_ALLOWED_EMAILS'))).toBe(true);
    expect(hits.some((h) => h.reason.includes('email no-example'))).toBe(true);
    // El mensaje de fallo nunca incluye el valor del email.
    const summary = formatHits(hits);
    expect(summary).not.toMatch(/owner\.user@denied-example\.test/);
  });

  it('el detector no señala una fixture de opt-in universal sin allowlist ni emails reales', () => {
    const fixture = mkTmp('oss-p01-universal-fx-');
    writeFile(fixture, 'src/lib/expensesAccess.js', [
      'export function isExpensesFeatureAllowed(email) {',
      "  return typeof email === 'string' && email.trim().length > 0;",
      '}',
      '',
    ].join('\n'));
    const hits = scanGastosAllowlistAndEmails(fixture);
    expect(hits, formatHits(hits)).toEqual([]);
    const src = fs.readFileSync(path.join(fixture, 'src/lib/expensesAccess.js'), 'utf8');
    expect(isExpensesAccessUniversal(src)).toBe(true);
  });

  it('el bundle de Gastos del export no tiene allowlist ni emails no-example', () => {
    const access = path.join(exportDir, 'src/lib/expensesAccess.js');
    expect(fs.existsSync(access), 'falta src/lib/expensesAccess.js en el export (bundle de Gastos)').toBe(true);
    const hits = scanGastosAllowlistAndEmails(exportDir);
    expect(hits, formatHits(hits)).toEqual([]);
  });

  it('isExpensesFeatureAllowed del export es opt-in universal (sin lista de admin/beta/owner)', () => {
    const access = path.join(exportDir, 'src/lib/expensesAccess.js');
    expect(fs.existsSync(access), 'falta src/lib/expensesAccess.js en el export').toBe(true);
    const src = fs.existsSync(access) ? fs.readFileSync(access, 'utf8') : '';
    expect(
      isExpensesAccessUniversal(src),
      'src/lib/expensesAccess.js: el acceso no es opt-in universal (sigue una allowlist)',
    ).toBe(true);
  });
});

describe('P0-1 bloque 3 — el export no arrastra el DROP de oss_remove_modules sobre Gastos', () => {
  it('ninguna migración del export hace DROP de expense_entries, expense_projects o savings_goals', () => {
    const hits = findDropHits(exportDir);
    expect(hits, formatHits(hits)).toEqual([]);
  });

  it('el filtro deja oss_remove_modules fuera de esas tablas o añade una migración nueva; no edita el SQL publicado en origen', () => {
    const sourceDrop = path.join(ROOT, 'supabase/migrations/20261107001100_oss_remove_modules.sql');
    expect(fs.existsSync(sourceDrop), 'falta la migración publicada oss_remove_modules en origen').toBe(true);
    // No se exige que el fichero de origen cambie: el contrato es el árbol exportado.
    const exportDrop = path.join(exportDir, 'supabase/migrations/20261107001100_oss_remove_modules.sql');
    const later = listExportMigrations(exportDir).filter((f) => f > '20261107001100_oss_remove_modules.sql');
    const laterRestore = later.some((f) => {
      const text = fs.readFileSync(path.join(exportDir, 'supabase/migrations', f), 'utf8');
      return GASTOS_TABLES.every((t) => new RegExp(`create\\s+table\\s+(if\\s+not\\s+exists\\s+)?(public\\.)?${t}\\b`, 'i').test(text));
    });
    const filtered = !fs.existsSync(exportDrop) || findDropHits(exportDir).length === 0;
    expect(
      filtered || laterRestore,
      'hace falta filtrar el DROP de Gastos en el export o añadir una migración posterior que restaure las tablas; no editar el SQL publicado en origen',
    ).toBe(true);
  });
});

describe('P0-1 bloque 4 — docs de usuario propias, cron parametrizable, checkSanitized y secret-scan', () => {
  it('el export no incluye docs/claude/expenses.md de producción', () => {
    expect(
      fs.existsSync(path.join(exportDir, 'docs/claude/expenses.md')),
      'el export no debe incluir docs/claude/expenses.md',
    ).toBe(false);
  });

  it('el export incluye documentación de usuario de Gastos propia (no bajo docs/claude/)', () => {
    const docs = findUserDocs(exportDir).filter((rel) => !rel.startsWith('docs/claude/'));
    const named = docs.filter((rel) => /(?:^|\/)(gastos|expenses|self-hosting-gastos)\.md$/i.test(rel));
    const mentioned = docs.filter((rel) => {
      const text = fs.readFileSync(path.join(exportDir, rel), 'utf8');
      return /gastos/i.test(text) && /opt-?in|self-host|export|tabla|expense/i.test(text);
    });
    const found = named.length ? named : mentioned.filter((rel) => /gastos/i.test(path.basename(rel)));
    expect(
      found.length,
      'falta una doc de usuario propia de Gastos (p. ej. docs/gastos.md), distinta de docs/claude/expenses.md',
    ).toBeGreaterThan(0);
  });

  it('cron y zona horaria de Gastos son parametrizables (sin Europe/Madrid ni intervalo fijo incrustado)', () => {
    const hits = scanHardcodedCron(exportDir);
    expect(hits, formatHits(hits)).toEqual([]);
  });

  it('checkSanitized sobre el export = 0 (solo file:line + reason si falla)', () => {
    const { ok, violations } = checkSanitized({ root: exportDir, hashesFile });
    expect(ok, `export no sanitizado:\n${formatHits(violations)}`).toBe(true);
  });

  it('gitleaks sobre el export = 0 si está en el box; si no, se informa y no se inventa', () => {
    const bin = whichCmd('gitleaks');
    if (!bin) {
      expect(bin, 'gitleaks no está en el PATH de este box; no se inventa un recuento').toBeNull();
      return;
    }
    const r = spawnSync(bin, ['detect', '--no-git', '--source', exportDir, '-v'], { encoding: 'utf8' });
    expect(r.status, `gitleaks no es 0 (status=${r.status})`).toBe(0);
  });

  it('trufflehog sobre el export = 0 si está en el box; si no, se informa y no se inventa', () => {
    const bin = whichCmd('trufflehog');
    if (!bin) {
      expect(bin, 'trufflehog no está en el PATH de este box; no se inventa un recuento').toBeNull();
      return;
    }
    const r = spawnSync(bin, ['filesystem', exportDir, '--no-update'], { encoding: 'utf8' });
    expect(r.status, `trufflehog no es 0 (status=${r.status})`).toBe(0);
  });
});

describe('P0-1 bloque 5 — el export incluye los tests de Gastos', () => {
  it('el árbol exportado contiene la suite de Gastos (unit + pg)', () => {
    const missing = REQUIRED_GASTOS_TEST_PATHS.filter((rel) => !fs.existsSync(path.join(exportDir, rel)));
    expect(missing, `faltan tests de Gastos en el export: ${missing.join(', ')}`).toEqual([]);
  });
});
