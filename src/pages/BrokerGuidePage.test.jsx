import { describe, it, expect, beforeAll } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { Helmet } from 'react-helmet';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { loadMergedLocale } from '@/i18n/loadMergedLocale.js';
const es = loadMergedLocale('es');
import BrokerGuidePage from './BrokerGuidePage';

function render(path) {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/guias" element={<p>indice-de-guias</p>} />
        <Route path="/guias/:slug" element={<BrokerGuidePage />} />
      </Routes>
    </MemoryRouter>,
  );
  const head = Helmet.renderStatic();
  return { html, meta: head.meta.toString(), link: head.link.toString() };
}

describe('BrokerGuidePage', () => {
  beforeAll(async () => {
    await i18next.use(initReactI18next).init({ lng: 'es', resources: { es: { translation: es } } });
  });

  it('slug inexistente → NotFoundPage con noindex, no una redirección al índice', () => {
    const { html, meta, link } = render('/guias/no-existe');
    expect(html).toContain(es.not_found.heading);
    expect(html).not.toContain('indice-de-guias');
    expect(meta).toContain('name="robots" content="noindex, nofollow"');
    expect(link).not.toContain('rel="canonical"');
  });

  it('slug válido → la guía con su h1 y su canonical', () => {
    const { html, link } = render('/guias/degiro');
    expect(html).toContain(es.guides.degiro.h1);
    expect(html).not.toContain(es.not_found.heading);
    expect(link).toContain('/guias/degiro');
  });
});
