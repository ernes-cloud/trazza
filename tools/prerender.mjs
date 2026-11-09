#!/usr/bin/env node
/**
 * Postbuild (después de generate-seo): prerender de la web pública.
 *
 * Abre cada ruta del sitemap —y la 404— en Chromium contra `vite preview` y
 * guarda el contenido de #root en su HTML de dist/ (el <head> ya lo escribió
 * generate-seo). Piezas puras en src/lib/prerender.js.
 *
 *   - Sin Chromium FALLA: una build de despliegue sin prerender publicaría las
 *     páginas vacías sin que nadie se enterase. `npx playwright install chromium`.
 *   - SKIP_PRERENDER=1 lo salta: SOLO para el job `verify` del CI (node:22, sin
 *     navegador; su build se descarta). El job e2e-smoke sí lo ejecuta.
 *   - El blog depende de Supabase al compilar: si un artículo o el listado no
 *     cargan (p. ej. con las VITE_* de relleno del CI), esa ruta se queda solo
 *     con su <head>, como antes, y se avisa. Con REQUIRE_BLOG=1 (build de
 *     despliegue, `npm run build:deploy`) eso también rompe la build, igual que
 *     SKIP_PRERENDER=1. Cualquier otra ruta que no llegue a pintarse la rompe
 *     siempre.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getAppUrl } from '../src/lib/appUrl.js';
import { NOT_FOUND_PAGE } from '../src/lib/siteMeta.js';
import { outputPathFor } from '../src/lib/seoHead.js';
import {
  injectRoot, stripNoPrerender, isDataRoute, routesFromSitemap, PRERENDER_START,
  hoistInlineStyles, linkPrerenderStylesheet, shortHash,
} from '../src/lib/prerender.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const READY_TIMEOUT_MS = 20_000;
const CLOSE_TIMEOUT_MS = 10_000;

async function defaultLaunch() {
  const { chromium } = await import('playwright');
  return chromium.launch();
}

async function defaultPreview() {
  const { preview } = await import('vite');
  const server = await preview({ root: ROOT, logLevel: 'warn', preview: { host: '127.0.0.1', port: 4179, strictPort: false, open: false } });
  const url = (server.resolvedUrls?.local?.[0] || 'http://127.0.0.1:4179/').replace(/\/$/, '');
  return {
    url,
    close: () => {
      // http.Server.close() solo cierra las conexiones INACTIVAS y no llama a su
      // callback mientras quede alguna abierta (Chromium abre keep-alive por
      // adelantado): se cortan todas antes de cerrar.
      server.httpServer.closeAllConnections?.();
      return new Promise((r) => server.httpServer.close(() => r()));
    },
  };
}

/**
 * Cierra el navegador y DESPUÉS el preview. Al revés era un bloqueo mutuo: el
 * close() del preview esperaba a la conexión keep-alive de Chromium y Chromium
 * no se cerraba hasta después (el postbuild se quedó vivo >10 min tras decir
 * «15/16», revisión 2026-10-18). Si aun así no termina en `timeoutMs`, avisa y
 * deja de esperar: lo que hubiera que escribir en dist/ ya está escrito, pero
 * la CLI sale con 1 (un Chromium o un socket colgados no son un build limpio).
 * Devuelve 'ok', 'timeout' o 'error'.
 */
async function closeAll({ browser, server, logger, timeoutMs }) {
  let timer;
  const closing = (async () => {
    await browser?.close();
    if (server) await server.close();
  })().then(() => 'ok', (e) => `error: ${e.message.split('\n')[0]}`);
  const timeout = new Promise((r) => { timer = setTimeout(() => r('timeout'), timeoutMs); });
  const res = await Promise.race([closing, timeout]);
  clearTimeout(timer);
  if (res === 'timeout') {
    logger.warn(`[prerender] AVISO: el cierre del navegador y del preview no terminó en ${timeoutMs / 1000} s; dejo de esperar`);
    return 'timeout';
  }
  if (res !== 'ok') {
    logger.warn(`[prerender] AVISO: fallo al cerrar el navegador o el preview (${res}); sigo`);
    return 'error';
  }
  return 'ok';
}

/** Abre una ruta y devuelve el innerHTML de #root cuando la página está pintada, o el motivo del fallo. */
async function snapshot(ctx, baseUrl, route) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(baseUrl + route, { waitUntil: 'networkidle', timeout: 30_000 });
    // Lista cuando React ya montó (el HTML de partida trae la marca de inicio),
    // hay un <h1> y nada sigue cargando (`data-prerender="pending"`).
    const state = await page.waitForFunction((startMark) => {
      const r = document.getElementById('root');
      if (!r || r.innerHTML.includes(startMark)) return null;
      if (r.querySelector('[data-prerender="error"]')) return 'error';
      if (r.querySelector('[data-prerender="pending"]')) return null;
      return r.querySelector('h1') ? 'ready' : null;
    }, PRERENDER_START, { timeout: READY_TIMEOUT_MS }).then((h) => h.jsonValue()).catch(() => 'timeout');
    if (state !== 'ready') return { ok: false, reason: errors[0] ? `${state}: ${errors[0]}` : state };
    // Bajar hasta el final: las secciones con whileInView (framer-motion) se
    // quedan en opacity:0 si nunca entran en pantalla.
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 600) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 40));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(1200); // la animación más larga dura 0,7 s + retardo
    const html = await page.evaluate(() => document.getElementById('root').innerHTML);
    return { ok: true, html };
  } finally {
    await page.close();
  }
}

export async function prerender({
  env = process.env, launchBrowser = defaultLaunch, startPreview = defaultPreview,
  distDir = DIST, logger = console, closeTimeoutMs = CLOSE_TIMEOUT_MS,
} = {}) {
  const required = env.REQUIRE_BLOG === '1';
  if (env.SKIP_PRERENDER === '1') {
    if (required) throw new Error('[prerender] REQUIRE_BLOG=1 y SKIP_PRERENDER=1: un build de despliegue no se salta el prerender');
    logger.warn('[prerender] AVISO: SKIP_PRERENDER=1: sin prerender (solo vale para el job verify del CI; NUNCA para desplegar)');
    return { skipped: true };
  }
  let browser;
  try {
    browser = await launchBrowser();
  } catch (e) {
    throw new Error(`[prerender] no se pudo abrir Chromium (${e.message.split('\n')[0]}). `
      + 'Instálalo con "npx playwright install chromium". Solo el job verify del CI puede saltarlo con SKIP_PRERENDER=1.');
  }
  let server;
  let result;
  let closed;
  try {
    server = await startPreview();
    const sitemap = fs.readFileSync(path.join(distDir, 'sitemap.xml'), 'utf8');
    const routes = [NOT_FOUND_PAGE.path, ...routesFromSitemap(sitemap, getAppUrl())];
    const ctx = await browser.newContext({ locale: 'es-ES', viewport: { width: 1280, height: 900 } });
    // La app no manda nada a Sentry ni a /api/log-error mientras se prerenderiza (main.jsx).
    await ctx.addInitScript(() => { window.__TRAZZA_PRERENDER__ = true; });
    const failed = [];
    const skipped = [];
    for (const route of routes) {
      const file = route === NOT_FOUND_PAGE.path ? '404.html' : outputPathFor(route);
      const target = path.join(distDir, file);
      const res = await snapshot(ctx, server.url, route);
      if (!res.ok) {
        (isDataRoute(route) ? skipped : failed).push(`${route} (${res.reason})`);
        continue;
      }
      // Sin un solo style="…" en el HTML: la CSP no lleva 'unsafe-inline' en
      // style-src (src/lib/prerender.js → hoistInlineStyles).
      const { html: rootHtml, css } = hoistInlineStyles(stripNoPrerender(res.html));
      let href = null;
      if (css) {
        href = `/assets/prerender-${shortHash(css)}.css`;
        fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
        fs.writeFileSync(path.join(distDir, href), css);
      }
      fs.writeFileSync(target, linkPrerenderStylesheet(injectRoot(fs.readFileSync(target, 'utf8'), rootHtml, route), href));
    }
    // Los AVISO van por logger.warn (stderr): el log del build se captura con 2>&1
    // (SERVIDOR.md, b). Hasta el 2026-10-18 este aviso no salía porque vite.config.js
    // anulaba console.warn en todo el proceso que la carga, incluido este (preview()).
    // Con REQUIRE_BLOG=1 (build de despliegue) una ruta de datos sin pintar es un
    // error, no un AVISO: generate-seo pudo leer el blog y aun así el Chromium no
    // pintarlo (caso G4 de la 5.ª revisión, 15/18 con «BUILD OK»).
    if (skipped.length && required) {
      throw new Error(`[prerender] REQUIRE_BLOG=1 y estas páginas no llegaron a pintarse: ${[...failed, ...skipped].join(', ')}`);
    }
    if (skipped.length) logger.warn(`[prerender] AVISO: sin prerender (dependen de Supabase al compilar): ${skipped.join(', ')}`);
    if (failed.length) throw new Error(`[prerender] estas páginas no llegaron a pintarse: ${failed.join(', ')}`);
    logger.log(`[prerender] ${routes.length - skipped.length}/${routes.length} páginas prerenderizadas`);
    result = { skipped: false, routes: routes.length, withoutPrerender: skipped.length };
  } finally {
    // Si el try lanzó, el finally cierra y el error se propaga igual.
    closed = await closeAll({ browser, server, logger, timeoutMs: closeTimeoutMs });
  }
  return { ...result, closeTimedOut: closed === 'timeout' };
}

/**
 * CLI inyectable (los tests no lanzan un proceso). process.exit explícito en todos
 * los casos: si el cierre agotó su plazo, algún socket o el proceso de Chromium
 * podría mantener vivo el event loop. Un cierre agotado sale con 1 DESPUÉS de haber
 * escrito todo: el aviso ya salió por warn (closeAll) y aquí se explica el código.
 */
export async function runCli({ prerenderImpl = prerender, exit = process.exit, logger = console } = {}) {
  let res;
  try {
    res = await prerenderImpl();
  } catch (e) {
    logger.error(e.message);
    return exit(1);
  }
  if (res?.closeTimedOut) {
    logger.error('[prerender] el cierre del navegador/preview agotó su plazo: dist/ está escrito, pero salgo con 1. '
      + 'Comprueba que no queda ningún Chromium huérfano (pgrep -fa chrom) antes de repetir el build.');
    return exit(1);
  }
  return exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
