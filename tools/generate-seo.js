#!/usr/bin/env node
/**
 * Postbuild: SEO estático de las páginas públicas (ver src/lib/seoHead.js).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAppUrl } from '../src/lib/appUrl.js';
import { SITE_NAME, OG_IMAGE, PUBLIC_PAGES, NOT_FOUND_PAGE, ROBOTS_DISALLOW, absoluteUrl, structuredDataFor } from '../src/lib/siteMeta.js';
import { buildHeadTags, injectHead, buildSitemap, buildRobots, outputPathFor, buildAppShell, prepareBaseHtml } from '../src/lib/seoHead.js';
import { loadMergedLocale } from '../src/i18n/loadMergedLocale.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const es = loadMergedLocale('es');
const tr = (key) => key.split('.').reduce((o, k) => o?.[k], es);

function writePage(baseHtml, routePath, { title, description, type, ld, noindex = false, file = outputPathFor(routePath) }) {
  const tags = buildHeadTags({ title, description, url: absoluteUrl(routePath), type, siteName: SITE_NAME, image: OG_IMAGE, ld, noindex });
  const out = path.join(DIST, file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, injectHead(baseHtml, { title, tags, lang: 'es' }));
}

async function main() {
  const indexPath = path.join(DIST, 'index.html');
  if (!fs.existsSync(indexPath)) throw new Error('dist/index.html no existe: ¿se ejecutó vite build?');
  const baseHtml = prepareBaseHtml(fs.readFileSync(indexPath, 'utf8'));
  fs.writeFileSync(path.join(DIST, 'app.html'), buildAppShell(baseHtml, { title: tr('app.title') }));
  const today = new Date().toISOString().slice(0, 10);
  const sitemap = [];

  for (const page of PUBLIC_PAGES) {
    const title = tr(page.titleKey);
    const description = tr(page.descKey);
    if (!title) throw new Error(`[generate-seo] falta la clave ${page.titleKey} en es.public/es.app`);
    const url = absoluteUrl(page.path);
    writePage(baseHtml, page.path, { title, description, type: 'website', ld: structuredDataFor(page.schema, { title, description, url }) });
    sitemap.push({ url, lastmod: today, changefreq: page.changefreq, priority: page.priority });
  }

  const nfTitle = tr(NOT_FOUND_PAGE.titleKey);
  if (!nfTitle) throw new Error(`[generate-seo] falta la clave ${NOT_FOUND_PAGE.titleKey} en es.public/es.app`);
  writePage(baseHtml, NOT_FOUND_PAGE.path, { title: nfTitle, description: tr(NOT_FOUND_PAGE.descKey), type: 'website', ld: [], noindex: true, file: '404.html' });

  fs.writeFileSync(path.join(DIST, 'sitemap.xml'), buildSitemap(sitemap));
  fs.writeFileSync(path.join(DIST, 'robots.txt'), buildRobots({ siteUrl: getAppUrl(), disallow: ROBOTS_DISALLOW }));
  console.log(`[generate-seo] ${PUBLIC_PAGES.length} páginas + 404.html, app.html, sitemap.xml y robots.txt`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
