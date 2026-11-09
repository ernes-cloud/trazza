import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectSections,
  buildRawKeyPattern,
  findRawKeys,
  checkRawKeys,
} from './checkRawKeys.js';

describe('checkRawKeys', () => {
  it('collectSections incluye secciones de los locales del repo', () => {
    const sections = collectSections();
    expect(sections).toContain('compound_calc');
    expect(sections).toContain('landing');
    expect(sections).toContain('nav');
    expect(sections).toContain('demo_mode');
    expect(sections).toContain('cartera');
  });

  it('buildRawKeyPattern detecta claves crudas y no texto normal', () => {
    const re = buildRawKeyPattern(['compound_calc', 'nav', 'demo_mode']);
    const html = '<h1>compound_calc.title</h1><p>Valor Final</p><span>nav.dashboard</span>';
    expect([...html.matchAll(re)].map((m) => m[0])).toEqual([
      'compound_calc.title',
      'nav.dashboard',
    ]);
    expect('Valor Final'.match(re)).toBeNull();
  });

  it('findRawKeys / checkRawKeys fallan si un HTML tiene claves crudas', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rawkeys-'));
    fs.mkdirSync(path.join(dir, 'calculadora'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'calculadora', 'index.html'),
      '<html><body><h1>compound_calc.title</h1><p>nav.brokers</p></body></html>',
    );
    fs.writeFileSync(path.join(dir, 'ok.html'), '<html><body><h1>Valor Final</h1></body></html>');

    const sections = ['compound_calc', 'nav'];
    const hits = findRawKeys(dir, { sections });
    expect(hits).toHaveLength(1);
    expect(hits[0].matches).toEqual(['compound_calc.title', 'nav.brokers']);

    const bad = checkRawKeys(dir, { sections });
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/compound_calc\.title/);

    const cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rawkeys-ok-'));
    fs.writeFileSync(path.join(cleanDir, 'index.html'), '<h1>Valor Final</h1>');
    expect(checkRawKeys(cleanDir, { sections }).ok).toBe(true);
  });

  it('buildRawKeyPattern con lista vacía no hace match', () => {
    const re = buildRawKeyPattern([]);
    expect('nav.dashboard'.match(re)).toBeNull();
  });
});
