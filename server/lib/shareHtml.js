/**
 * La BASE HTML de /share/:token: de qué fichero sale y cómo se deja lista.
 *
 * Desde el prerender (2026-10-17) `index.html` lleva la portada dentro de #root;
 * servirlo tal cual en /share pintaba la home hasta que React montaba. La base
 * buena es `app.html` (el shell neutro que escribe tools/generate-seo.js); si no
 * está (despliegue antiguo), vale `index.html` pasando por `emptyRoot()`.
 *
 * Pura salvo `readShareBase`, que recibe el lector inyectado (testeable).
 */

import path from 'node:path';
import { emptyRoot, PRERENDER_START, PRERENDER_END } from '../../src/lib/prerender.js';
import { getAppHostname } from './appUrl.js';

/**
 * WEB_STATIC_ROOT must be absolute, normalized, without `..` segments, and must
 * not point at /etc, /proc or /sys (or anything under them). Invalid values fall
 * back to `/srv/www/<host>` with a warning.
 */
function isSafeStaticRoot(raw) {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  const posix = trimmed.replace(/\\/g, '/');
  if (!path.posix.isAbsolute(posix)) return false;
  if (posix.split('/').includes('..')) return false;
  const normalized = path.posix.normalize(posix).replace(/\/+$/, '') || '/';
  if (!path.posix.isAbsolute(normalized)) return false;
  if (normalized.split('/').includes('..')) return false;
  for (const root of ['/etc', '/proc', '/sys']) {
    if (normalized === root || normalized.startsWith(`${root}/`)) return false;
  }
  return true;
}

function normalizeStaticRoot(raw) {
  return path.posix.normalize(String(raw).trim().replace(/\\/g, '/')).replace(/\/+$/, '') || '/';
}

function defaultHostnameRoot() {
  return `/srv/www/${getAppHostname()}`;
}

function warnInvalidStaticRoot(raw) {
  console.warn(
    `[shareHtml] WEB_STATIC_ROOT inválido (${JSON.stringify(String(raw))}); usando default /srv/www/<host>`,
  );
}

function defaultStaticWebRoot() {
  const fromEnv = process.env.WEB_STATIC_ROOT;
  if (fromEnv && String(fromEnv).trim()) {
    const raw = String(fromEnv).trim();
    if (isSafeStaticRoot(raw)) return normalizeStaticRoot(raw);
    warnInvalidStaticRoot(raw);
  }
  return defaultHostnameRoot();
}

function resolveStaticRoot(env) {
  const fromParam = env.WEB_STATIC_ROOT?.trim();
  if (fromParam) {
    if (isSafeStaticRoot(fromParam)) return normalizeStaticRoot(fromParam);
    warnInvalidStaticRoot(fromParam);
    return defaultHostnameRoot();
  }
  return defaultStaticWebRoot();
}

const EMPTY_ROOT = '<div id="root"></div>';

/**
 * Candidatos en orden de preferencia:
 *   1. WEB_APP_HTML
 *   2. el app.html junto a WEB_INDEX_HTML
 *   3. WEB_STATIC_ROOT (o directorio hermano de distDir) /app.html
 *   4. WEB_INDEX_HTML
 *   5. dist/app.html
 *   6. WEB_STATIC_ROOT /index.html
 *   7. dist/index.html
 * Reglas: el app.html del directorio estático por defecto gana a una portada
 * configurada (revisión 2.ª: una portada hay que vaciarla con emptyRoot y depende
 * de que su #root siga casando), pero dist/app.html NO gana a WEB_INDEX_HTML
 * (revisión 3.ª: sería el shell de OTRO build, con otros chunks). En cada
 * directorio, app.html antes que su index.html. Las variables vacías se omiten y
 * no se repite ningún fichero.
 *
 * WEB_STATIC_ROOT sobreescribe el directorio estático por defecto
 * `/srv/www/<hostname>` cuando está definido y es una ruta absoluta segura
 * (sin `..`, fuera de /etc|/proc|/sys); si no, se ignora con warning.
 */
export function shareHtmlCandidates({ env = {}, distDir }) {
  const staticDir = resolveStaticRoot(env);
  const list = [
    env.WEB_APP_HTML,
    // WEB_INDEX_HTML era la única variable antes de app.html: su app.html hermano
    // gana a la portada que apunta.
    env.WEB_INDEX_HTML ? path.join(path.dirname(env.WEB_INDEX_HTML), 'app.html') : null,
    `${staticDir}/app.html`,
    env.WEB_INDEX_HTML,
    path.join(distDir, 'app.html'),
    `${staticDir}/index.html`,
    path.join(distDir, 'index.html'),
  ].filter(Boolean);
  return [...new Set(list)];
}

/**
 * Devuelve el HTML con #root vacío y sin marcadores de prerender, o null si no
 * puede garantizarlo (el llamador prueba el siguiente candidato).
 */
export function normalizeShareBase(html) {
  if (typeof html !== 'string' || !html) return null;
  let out = emptyRoot(html);
  // #root sin contenido pero con el atributo de ruta (o con espacios dentro).
  out = out.replace(/<div id="root"[^>]*>\s*<\/div>/, EMPTY_ROOT);
  if (!out.includes(EMPTY_ROOT)) return null;
  if (out.includes(PRERENDER_START) || out.includes(PRERENDER_END) || out.includes('data-prerender-path')) return null;
  return out;
}

/** Lee los candidatos en orden y devuelve el primero que se pueda normalizar. */
export async function readShareBase(candidates, readFile) {
  for (const file of candidates) {
    let raw;
    try {
      raw = await readFile(file);
    } catch (e) {
      // ENOENT es lo normal (el candidato no existe en este despliegue); otro error se avisa.
      if (e?.code !== 'ENOENT') console.warn(`[shareHtml] no se pudo leer ${file}: ${e?.message}`);
      continue;
    }
    const html = normalizeShareBase(raw);
    if (html) return { file, html };
    console.warn(`[shareHtml] ${file} no tiene un #root vaciable; se prueba el siguiente`);
  }
  return null;
}
