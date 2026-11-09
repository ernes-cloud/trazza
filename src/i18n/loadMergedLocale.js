/**
 * Única fuente de locales: `*.public.json` + `*.app.json`.
 * Los monolitos es.json/en.json ya no existen (I5).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCALES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'locales');

export function loadMergedLocale(lang) {
  if (lang !== 'es' && lang !== 'en') {
    throw new Error(`loadMergedLocale: idioma no soportado (${lang})`);
  }
  const pub = JSON.parse(fs.readFileSync(path.join(LOCALES, `${lang}.public.json`), 'utf8'));
  const app = JSON.parse(fs.readFileSync(path.join(LOCALES, `${lang}.app.json`), 'utf8'));
  return { ...pub, ...app };
}

export function localePath(lang, kind) {
  return path.join(LOCALES, `${lang}.${kind}.json`);
}
