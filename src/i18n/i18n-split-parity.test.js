import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { PUBLIC_PAGES, NOT_FOUND_PAGE } from '@/lib/siteMeta.js';

/**
 * Paridad del i18n partido (M-C): es/en en `public` y `app`, y las claves de
 * las páginas públicas viven en el bundle público. Separado de
 * i18n-parity.test.js para no romper la paridad del monolitico actual.
 */

const localesDir = new URL('./locales/', import.meta.url);

const load = (name) => {
  const file = fileURLToPath(new URL(`${name}.json`, localesDir));
  if (!existsSync(file)) {
    throw new Error(`Falta src/i18n/locales/${name}.json (split public/app aún no creado)`);
  }
  return JSON.parse(readFileSync(file, 'utf8'));
};

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

const get = (obj, key) => key.split('.').reduce((o, k) => o?.[k], obj);

describe('i18n split public/app parity', () => {
  it('paridad es/en en public y en app', () => {
    const pairs = [
      ['es.public', 'en.public'],
      ['es.app', 'en.app'],
    ];
    for (const [a, b] of pairs) {
      const aKeys = keyPaths(load(a));
      const bKeys = keyPaths(load(b));
      const onlyA = aKeys.filter((k) => !bKeys.includes(k));
      const onlyB = bKeys.filter((k) => !aKeys.includes(k));
      expect(
        { onlyA, onlyB },
        `drift ${a}/${b} — solo en ${a}: ${onlyA.join(', ') || 'none'} | solo en ${b}: ${onlyB.join(', ') || 'none'}`,
      ).toEqual({ onlyA: [], onlyB: [] });
    }
  });

  it('ninguna clave de página pública falta en el locale public', () => {
    const pub = load('es.public');
    const keys = [
      ...PUBLIC_PAGES.flatMap((p) => [p.titleKey, p.descKey]),
      NOT_FOUND_PAGE.titleKey,
      NOT_FOUND_PAGE.descKey,
    ];
    const missing = keys.filter((k) => typeof get(pub, k) !== 'string');
    expect(missing, `claves públicas ausentes en es.public: ${missing.join(', ')}`).toEqual([]);
  });
});
