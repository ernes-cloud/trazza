/**
 * Falla si algún HTML de dist/ contiene claves i18n crudas (p. ej. compound_calc.title).
 * Las secciones se derivan de los JSON de locales (públicos + app).
 *
 * Uso: node tools/checkRawKeys.js [distDir]
 * Exporta findRawKeys / buildRawKeyPattern para tests unitarios.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES_DIR = path.join(ROOT, 'src/i18n/locales');

const LOCALE_FILES = [
  'es.public.json',
  'en.public.json',
  'es.app.json',
  'en.app.json',
];

/** Secciones de primer nivel presentes en los JSON de locales. */
export function collectSections(localesDir = LOCALES_DIR, files = LOCALE_FILES) {
  const sections = new Set();
  for (const name of files) {
    const full = path.join(localesDir, name);
    if (!fs.existsSync(full)) continue;
    const data = JSON.parse(fs.readFileSync(full, 'utf8'));
    for (const key of Object.keys(data)) {
      if (typeof data[key] === 'object' && data[key] !== null && !Array.isArray(data[key])) {
        sections.add(key);
      }
    }
  }
  return [...sections].sort();
}

/**
 * Regex que captura `seccion.clave` con secciones conocidas y clave snake_case.
 * Escapa nombres de sección por si llevan caracteres especiales.
 */
export function buildRawKeyPattern(sections) {
  if (!sections.length) return /(?!)/; // never matches
  const alts = sections
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return new RegExp(`\\b(?:${alts})\\.[a-z][a-z0-9_]*\\b`, 'g');
}

function listHtmlFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listHtmlFiles(full));
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

/**
 * @returns {{ file: string, matches: string[] }[]}
 */
export function findRawKeys(distDir, { sections, pattern } = {}) {
  const secs = sections || collectSections();
  const re = pattern || buildRawKeyPattern(secs);
  const hits = [];
  for (const file of listHtmlFiles(distDir)) {
    const html = fs.readFileSync(file, 'utf8');
    const found = [...html.matchAll(re)].map((m) => m[0]);
    if (found.length) {
      hits.push({
        file: path.relative(ROOT, file),
        matches: [...new Set(found)].sort(),
      });
    }
  }
  return hits;
}

export function checkRawKeys(distDir, opts) {
  const hits = findRawKeys(distDir, opts);
  if (!hits.length) return { ok: true, hits: [] };
  const detail = hits
    .map((h) => `${h.file}: ${h.matches.slice(0, 8).join(', ')}${h.matches.length > 8 ? '…' : ''}`)
    .join('\n');
  return { ok: false, hits, message: `claves i18n crudas en dist/:\n${detail}` };
}

function isMain() {
  const entry = process.argv[1] && path.resolve(process.argv[1]);
  return entry === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const distDir = path.resolve(process.argv[2] || path.join(ROOT, 'dist'));
  const result = checkRawKeys(distDir);
  if (!result.ok) {
    console.error(`[checkRawKeys] ${result.message}`);
    process.exit(1);
  }
  console.log('[checkRawKeys] 0 claves crudas en dist/');
}
