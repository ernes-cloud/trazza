import { describe, it, expect, beforeAll } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { Helmet } from 'react-helmet';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { loadMergedLocale } from '@/i18n/loadMergedLocale.js';
const es = loadMergedLocale('es');
import NotFoundPage from './NotFoundPage';

function render(path = '/no-existe') {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}><NotFoundPage /></MemoryRouter>,
  );
  const head = Helmet.renderStatic();
  return { html, meta: head.meta.toString(), link: head.link.toString(), title: head.title.toString() };
}

describe('NotFoundPage (la 404 real)', () => {
  beforeAll(async () => {
    await i18next.use(initReactI18next).init({ lng: 'es', resources: { es: { translation: es } } });
  });

  it('dice que la página no existe, con su h1 y en español', () => {
    const { html, title } = render();
    expect(html).toContain(`<h1`);
    expect(html).toContain(es.not_found.heading);
    expect(title).toContain(es.not_found.title);
  });

  it('noindex y SIN canonical: una 404 no puede declararse canónica de nada', () => {
    const { meta, link } = render();
    expect(meta).toContain('name="robots" content="noindex, nofollow"');
    expect(link).not.toContain('rel="canonical"');
  });

  it('ofrece volver a la portada y a las guías', () => {
    const { html } = render();
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/guias"');
  });

  it('tema FIJO: ninguna clase dark: (web pública)', () => {
    expect(render().html).not.toMatch(/\bdark:/);
  });
});
