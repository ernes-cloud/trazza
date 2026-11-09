import { describe, it, expect } from 'vitest';
import React, { Suspense } from 'react';
import { renderToString } from 'react-dom/server';
import { lazyPage } from './lazyPage.jsx';

const tree = (Page) => <Suspense fallback={<span>cargando</span>}><Page who="mundo" /></Suspense>;

describe('lazyPage', () => {
  it('sin precargar se comporta como React.lazy: primero el fallback', () => {
    const Page = lazyPage(() => new Promise(() => {})); // nunca llega
    expect(renderToString(tree(Page))).toContain('cargando');
  });

  it('precargada, pinta la página en el PRIMER render, sin pasar por Suspense', async () => {
    const Page = lazyPage(async () => ({ default: ({ who }) => <h1>hola {who}</h1> }));
    await Page.preload();
    const html = renderToString(tree(Page));
    expect(html).toContain('hola <!-- -->mundo');
    expect(html).not.toContain('cargando');
  });

  it('preload solo descarga una vez y, si falla, se puede reintentar', async () => {
    let calls = 0;
    const Page = lazyPage(async () => {
      calls += 1;
      if (calls === 1) throw new Error('red');
      return { default: () => <p>ok</p> };
    });
    await expect(Page.preload()).rejects.toThrow('red');
    await Page.preload();
    await Page.preload();
    expect(calls).toBe(2);
  });
});
