import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as shim from './cspStyleSingleton.js';
import * as original from '../../node_modules/react-style-singleton/dist/es2015/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

class FakeSheet {
  replaceSync(css) { this.css = css; }
}

function fakeDocument({ adopt }) {
  const head = { children: [], appendChild(n) { this.children.push(n); n.parentNode = this; }, removeChild(n) { this.children = this.children.filter((c) => c !== n); } };
  const doc = {
    head,
    createElement: (tag) => ({ tag, text: '', appendChild(t) { this.text += t.data; } }),
    createTextNode: (data) => ({ data }),
    getElementsByTagName: () => [head],
  };
  if (adopt) doc.adoptedStyleSheets = [];
  return doc;
}

describe('cspStyleSingleton (sustituto de react-style-singleton)', () => {
  let saved;
  beforeEach(() => { saved = { document: globalThis.document, CSSStyleSheet: globalThis.CSSStyleSheet }; });
  afterEach(() => { globalThis.document = saved.document; globalThis.CSSStyleSheet = saved.CSSStyleSheet; });

  it('exporta lo mismo que la librería original', () => {
    expect(Object.keys(shim).sort()).toEqual(Object.keys(original).sort());
  });

  it('con hojas construidas: ningún <style> en el <head>; la hoja se adopta con el primer add y se va con el último remove', () => {
    globalThis.document = fakeDocument({ adopt: true });
    globalThis.CSSStyleSheet = FakeSheet;
    const s = shim.stylesheetSingleton();
    s.add('body{overflow:hidden}');
    s.add('ignorado: ya hay hoja');
    expect(document.adoptedStyleSheets).toHaveLength(1);
    expect(document.adoptedStyleSheets[0].css).toBe('body{overflow:hidden}');
    expect(document.head.children).toHaveLength(0);
    s.remove();
    expect(document.adoptedStyleSheets).toHaveLength(1);
    s.remove();
    expect(document.adoptedStyleSheets).toHaveLength(0);
  });

  it('no pisa las hojas adoptadas por otros', () => {
    globalThis.document = fakeDocument({ adopt: true });
    globalThis.CSSStyleSheet = FakeSheet;
    const other = new FakeSheet();
    document.adoptedStyleSheets = [other];
    const s = shim.stylesheetSingleton();
    s.add('a{}');
    s.remove();
    expect(document.adoptedStyleSheets).toEqual([other]);
  });

  it('sin hojas construidas cae al <style> de siempre (y lo quita)', () => {
    globalThis.document = fakeDocument({ adopt: false });
    globalThis.CSSStyleSheet = undefined;
    const s = shim.stylesheetSingleton();
    s.add('a{}');
    expect(document.head.children.map((c) => [c.tag, c.text])).toEqual([['style', 'a{}']]);
    s.remove();
    expect(document.head.children).toHaveLength(0);
  });

  it('vite.config.js lo pone en lugar de react-style-singleton', () => {
    const cfg = fs.readFileSync(path.join(ROOT, 'vite.config.js'), 'utf8');
    expect(cfg).toMatch(/'react-style-singleton':\s*path\.resolve\(__dirname, '\.\/src\/lib\/cspStyleSingleton\.js'\)/);
  });
});
