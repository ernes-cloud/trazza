import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { loadMergedLocale, localePath } from './loadMergedLocale.js';

// Guard rule (CLAUDE.md i18n): es y en (public+app fusionados) deben tener
// exactamente el mismo set de claves. Fuente única: *.public.json + *.app.json.

/** Flatten nested keys into dot-paths, recording array leaves once. */
const keyPaths = (obj, prefix = '') => {
  const paths = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      paths.push(...keyPaths(value, path));
    } else {
      paths.push(path);
    }
  }
  return paths.sort();
};

describe('i18n locale parity', () => {
  const es = loadMergedLocale('es');
  const en = loadMergedLocale('en');
  const esKeys = keyPaths(es);
  const enKeys = keyPaths(en);

  it('es y en (public+app) exponen el mismo set de claves', () => {
    const onlyInEs = esKeys.filter((k) => !enKeys.includes(k));
    const onlyInEn = enKeys.filter((k) => !esKeys.includes(k));
    expect(
      { onlyInEs, onlyInEn },
      `i18n key drift — es-only: ${onlyInEs.join(', ') || 'none'} | en-only: ${onlyInEn.join(', ') || 'none'}`,
    ).toEqual({ onlyInEs: [], onlyInEn: [] });
  });

  it('ambos locales fusionados son no vacíos', () => {
    expect(esKeys.length).toBeGreaterThan(0);
    expect(enKeys.length).toBe(esKeys.length);
  });

  // JSON.parse se queda EN SILENCIO con la última de dos claves iguales, así que
  // el fichero parsea, la paridad pasa y sin embargo una traducción está muerta.
  const duplicateKeys = (filePath, label) => {
    const txt = readFileSync(filePath, 'utf8');
    const dups = [];
    const stack = [{ path: '', keys: new Map() }];
    txt.split('\n').forEach((line, i) => {
      const key = line.match(/^\s*"([^"]+)"\s*:/);
      if (key) {
        const top = stack[stack.length - 1];
        if (top.keys.has(key[1])) {
          dups.push(`${label}:${i + 1} "${key[1]}" en ${top.path || '(raíz)'} (ya estaba en la línea ${top.keys.get(key[1])})`);
        } else {
          top.keys.set(key[1], i + 1);
        }
        if (/\{\s*$/.test(line)) stack.push({ path: top.path ? `${top.path}.${key[1]}` : key[1], keys: new Map() });
      } else if (/^\s*\}/.test(line) && stack.length > 1) {
        stack.pop();
      }
    });
    return dups;
  };

  it.each([
    ['es', 'public'],
    ['es', 'app'],
    ['en', 'public'],
    ['en', 'app'],
  ])('%s.%s.json no tiene claves duplicadas dentro de una sección', (lang, kind) => {
    const dups = duplicateKeys(localePath(lang, kind), `${lang}.${kind}.json`);
    expect(dups, `claves duplicadas (la última gana y la otra queda muerta):\n${dups.join('\n')}`).toEqual([]);
  });
});
