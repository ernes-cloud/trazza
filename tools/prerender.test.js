import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prerender, runCli } from './prerender.mjs';
import { SITE_URL } from '../src/lib/siteMeta.js';

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

describe('tools/prerender', () => {
  it('SKIP_PRERENDER=1 lo salta sin abrir el navegador (solo el job verify del CI)', async () => {
    const launchBrowser = vi.fn();
    const res = await prerender({ env: { SKIP_PRERENDER: '1' }, launchBrowser, logger: quiet });
    expect(res).toEqual({ skipped: true });
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it('una ruta del blog que no carga se avisa como AVISO por logger.warn', async () => {
    // Este aviso no salía en el build porque vite.config.js anulaba console.warn en el
    // proceso del prerender (preview() carga la config); lo vigila tools/viteConfig.test.js.
    // Aquí solo se fija el contrato: un aviso, por warn y con el prefijo AVISO.
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prerender-test-'));
    const shell = '<!doctype html><html lang="es"><head><title>T</title></head><body><div id="root"></div></body></html>';
    fs.writeFileSync(path.join(distDir, '404.html'), shell);
    fs.mkdirSync(path.join(distDir, 'blog'));
    fs.writeFileSync(path.join(distDir, 'blog/index.html'), shell);
    fs.writeFileSync(path.join(distDir, 'sitemap.xml'), `<urlset><url><loc>${SITE_URL}/blog</loc></url></urlset>`);

    const fakePage = () => {
      let url = '';
      return {
        on: () => {},
        goto: async (u) => { url = u; },
        waitForFunction: async () => ({ jsonValue: async () => (url.endsWith('/blog') ? 'error' : 'ready') }),
        evaluate: async () => '<main><h1>404</h1></main>',
        waitForTimeout: async () => {},
        close: async () => {},
      };
    };
    const browser = {
      newContext: async () => ({ addInitScript: async () => {}, newPage: async () => fakePage() }),
      close: async () => {},
    };
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    try {
      const res = await prerender({
        env: {}, distDir, logger,
        launchBrowser: async () => browser,
        startPreview: async () => ({ url: 'http://preview.test', close: async () => {} }),
      });
      expect(res).toMatchObject({ routes: 2, withoutPrerender: 1 });
      const out = logger.warn.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(out).toMatch(/\[prerender\] AVISO: sin prerender.*\/blog \(error\)/);
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  });

  it('el HTML que escribe no lleva ningún style="…": van a /assets/prerender-<hash>.css enlazada en el <head>', async () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prerender-css-'));
    const shell = '<!doctype html><html lang="es"><head><title>T</title></head><body><div id="root"></div></body></html>';
    fs.writeFileSync(path.join(distDir, '404.html'), shell);
    fs.writeFileSync(path.join(distDir, 'sitemap.xml'), '<urlset></urlset>');
    const page = () => ({
      on: () => {}, goto: async () => {}, waitForTimeout: async () => {}, close: async () => {},
      waitForFunction: async () => ({ jsonValue: async () => 'ready' }),
      evaluate: async () => '<main><h1 class="t" style="color: rgb(1, 2, 3);">404</h1></main>',
    });
    const browser = { newContext: async () => ({ addInitScript: async () => {}, newPage: async () => page() }), close: async () => {} };
    try {
      await prerender({
        env: {}, distDir, logger: quiet, launchBrowser: async () => browser,
        startPreview: async () => ({ url: 'http://preview.test', close: async () => {} }),
      });
      const html = fs.readFileSync(path.join(distDir, '404.html'), 'utf8');
      expect(html).not.toMatch(/\sstyle="/);
      const href = html.match(/<link rel="stylesheet" href="(\/assets\/prerender-[a-z0-9]+\.css)"><\/head>/)[1];
      const css = fs.readFileSync(path.join(distDir, href), 'utf8');
      const cls = html.match(/<h1 class="t (ps-[a-z0-9]+)">/)[1];
      expect(css).toBe(`.${cls}{color: rgb(1, 2, 3) !important}\n`);
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  });

  // Caso G4 de la 5.ª revisión: generate-seo lee bien el blog, pero el Chromium del
  // prerender no lo pinta (500 de Supabase). Sin esto el build salía con «BUILD OK» y
  // 15/18, y se habrían publicado los artículos sin prerender.
  describe('REQUIRE_BLOG=1: ninguna ruta se puede quedar sin prerender', () => {
    const SHELL = '<!doctype html><html lang="es"><head><title>T</title></head><body><div id="root"></div></body></html>';
    let distDir;
    beforeEach(() => {
      distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prerender-req-'));
      fs.writeFileSync(path.join(distDir, '404.html'), SHELL);
      fs.mkdirSync(path.join(distDir, 'blog', 'articulo-uno'), { recursive: true });
      fs.writeFileSync(path.join(distDir, 'blog/index.html'), SHELL);
      fs.writeFileSync(path.join(distDir, 'blog/articulo-uno/index.html'), SHELL);
      fs.writeFileSync(path.join(distDir, 'sitemap.xml'),
        `<urlset><url><loc>${SITE_URL}/blog</loc></url><url><loc>${SITE_URL}/blog/articulo-uno</loc></url></urlset>`);
    });
    afterEach(() => fs.rmSync(distDir, { recursive: true, force: true }));

    /** Las rutas del blog dan 'error' (data-prerender="error"); el resto se pinta. */
    const blogFailsBrowser = () => {
      const page = () => {
        let url = '';
        return {
          on: () => {}, goto: async (u) => { url = u; }, waitForTimeout: async () => {}, close: async () => {},
          waitForFunction: async () => ({ jsonValue: async () => (url.includes('/blog') ? 'error' : 'ready') }),
          evaluate: async () => '<main><h1>x</h1></main>',
        };
      };
      return { newContext: async () => ({ addInitScript: async () => {}, newPage: async () => page() }), close: async () => {} };
    };
    const run = (env, logger) => prerender({
      env, distDir, logger, launchBrowser: async () => blogFailsBrowser(),
      startPreview: async () => ({ url: 'http://preview.test', close: async () => {} }),
    });

    it('con REQUIRE_BLOG=1, las rutas del blog saltadas son un ERROR (rechaza nombrándolas)', async () => {
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      await expect(run({ REQUIRE_BLOG: '1' }, logger))
        .rejects.toThrow(/REQUIRE_BLOG=1.*\/blog \(error\).*\/blog\/articulo-uno \(error\)/);
      // Nada de «X/Y páginas» que pueda leerse como un build bueno.
      expect(logger.log.mock.calls.flat().join('\n')).not.toMatch(/páginas prerenderizadas/);
    });

    it('con REQUIRE_BLOG=1, la CLI sale con 1', async () => {
      const exit = vi.fn();
      const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      await runCli({ prerenderImpl: () => run({ REQUIRE_BLOG: '1' }, quiet), exit, logger: log });
      expect(exit).toHaveBeenCalledWith(1);
      expect(exit).not.toHaveBeenCalledWith(0);
      expect(log.error.mock.calls.flat().join('\n')).toMatch(/REQUIRE_BLOG=1/);
    });

    it('sin REQUIRE_BLOG sigue siendo AVISO y la CLI sale con 0 (CI sin Supabase)', async () => {
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const res = await run({}, logger);
      expect(res).toMatchObject({ routes: 3, withoutPrerender: 2 });
      expect(logger.warn.mock.calls.flat().join('\n')).toMatch(/\[prerender\] AVISO: sin prerender.*\/blog \(error\)/);
      expect(logger.log.mock.calls.flat().join('\n')).toMatch(/\[prerender\] 1\/3 páginas prerenderizadas/);
      const exit = vi.fn();
      await runCli({ prerenderImpl: () => run({}, quiet), exit, logger: quiet });
      expect(exit).toHaveBeenCalledWith(0);
    });

    it('con REQUIRE_BLOG=1 y todo pintado, sale bien (control)', async () => {
      const page = {
        on: () => {}, goto: async () => {}, waitForTimeout: async () => {}, close: async () => {},
        waitForFunction: async () => ({ jsonValue: async () => 'ready' }), evaluate: async () => '<main><h1>x</h1></main>',
      };
      const browser = { newContext: async () => ({ addInitScript: async () => {}, newPage: async () => page }), close: async () => {} };
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const res = await prerender({
        env: { REQUIRE_BLOG: '1' }, distDir, logger, launchBrowser: async () => browser,
        startPreview: async () => ({ url: 'http://preview.test', close: async () => {} }),
      });
      expect(res).toMatchObject({ routes: 3, withoutPrerender: 0 });
      expect(logger.log.mock.calls.flat().join('\n')).toMatch(/\[prerender\] 3\/3 páginas prerenderizadas/);
    });

    it('REQUIRE_BLOG=1 con SKIP_PRERENDER=1 es un error: un build de despliegue no se salta el prerender', async () => {
      const launchBrowser = vi.fn();
      await expect(prerender({ env: { REQUIRE_BLOG: '1', SKIP_PRERENDER: '1' }, launchBrowser, logger: quiet }))
        .rejects.toThrow(/REQUIRE_BLOG=1.*SKIP_PRERENDER=1/);
      expect(launchBrowser).not.toHaveBeenCalled();
    });
  });

  describe('cierre del navegador y del preview', () => {
    const SHELL = '<!doctype html><html lang="es"><head><title>T</title></head><body><div id="root"></div></body></html>';
    let distDir;
    beforeEach(() => {
      distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prerender-close-'));
      fs.writeFileSync(path.join(distDir, '404.html'), SHELL);
      fs.writeFileSync(path.join(distDir, 'sitemap.xml'), '<urlset></urlset>');
    });
    afterEach(() => fs.rmSync(distDir, { recursive: true, force: true }));

    /** Navegador falso: cada página "pinta" un <h1>, salvo si `fail` (la ruta no llega a pintarse). */
    function fakeBrowser({ fail = false } = {}) {
      const state = { closed: false, onClose: [] };
      const page = {
        on: () => {}, goto: async () => {}, waitForTimeout: async () => {}, close: async () => {},
        waitForFunction: async () => ({ jsonValue: async () => (fail ? 'timeout' : 'ready') }),
        evaluate: async () => '<main><h1>404</h1></main>',
      };
      const browser = {
        newContext: async () => ({ addInitScript: async () => {}, newPage: async () => page }),
        close: async () => { state.closed = true; state.onClose.splice(0).forEach((f) => f()); },
      };
      return { browser, state };
    }

    /**
     * Preview falso que reproduce el bloqueo real: Chromium deja abierta una conexión
     * keep-alive y `http.Server.close()` no llama a su callback hasta que esa conexión
     * se cierra, es decir, hasta que se cierra el navegador.
     */
    function keepAlivePreview(state) {
      return async () => ({
        url: 'http://preview.test',
        close: () => new Promise((resolve) => {
          if (state.closed) resolve();
          else state.onClose.push(resolve);
        }),
      });
    }

    it('cierra el navegador ANTES que el preview: con el orden viejo server.close() esperaba a Chromium para siempre', async () => {
      const { browser, state } = fakeBrowser();
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      // Sin el arreglo se queda colgado hasta el timeout de seguridad (10 s) y el
      // test cae por su propio timeout de 2 s.
      const res = await prerender({
        env: {}, distDir, logger, launchBrowser: async () => browser, startPreview: keepAlivePreview(state),
      });
      expect(res).toMatchObject({ routes: 1, withoutPrerender: 0 });
      expect(state.closed).toBe(true);
      const all = [...logger.log.mock.calls, ...logger.warn.mock.calls].flat().join('\n');
      expect(all).not.toMatch(/no termin/);
    }, 2000);

    it('si el cierre no termina en el plazo de seguridad, avisa, termina lo escrito y devuelve closeTimedOut', async () => {
      // closeTimedOut hace que la CLI salga con 1 (ver runCli más abajo): un cierre
      // colgado puede dejar un Chromium huérfano en el VPS y el build no debe darse por bueno.
      const { browser } = fakeBrowser();
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const res = await prerender({
        env: {}, distDir, logger, closeTimeoutMs: 30,
        launchBrowser: async () => browser,
        startPreview: async () => ({ url: 'http://preview.test', close: () => new Promise(() => {}) }),
      });
      expect(res).toMatchObject({ routes: 1, closeTimedOut: true });
      // Lo que había que escribir en dist/ se escribió antes del cierre.
      expect(fs.readFileSync(path.join(distDir, '404.html'), 'utf8')).toContain('<h1>404</h1>');
      const all = [...logger.log.mock.calls, ...logger.warn.mock.calls].flat().join('\n');
      expect(logger.warn.mock.calls.flat().join('\n')).toMatch(/\[prerender\] AVISO: .*no termin/);
      expect(all).toMatch(/no termin/);
    }, 2000);

    it('un cierre normal devuelve closeTimedOut: false', async () => {
      const { browser, state } = fakeBrowser();
      const res = await prerender({
        env: {}, distDir, logger: quiet, launchBrowser: async () => browser, startPreview: keepAlivePreview(state),
      });
      expect(res.closeTimedOut).toBe(false);
    }, 2000);

    it('un fallo de prerender sigue rechazando aunque el cierre se cuelgue (el build sale con código ≠ 0)', async () => {
      const { browser } = fakeBrowser({ fail: true });
      await expect(prerender({
        env: {}, distDir, logger: quiet, closeTimeoutMs: 30,
        launchBrowser: async () => browser,
        startPreview: async () => ({ url: 'http://preview.test', close: () => new Promise(() => {}) }),
      })).rejects.toThrow(/no llegaron a pintarse: \/404/);
    }, 2000);
  });

  describe('CLI (runCli)', () => {
    const logger = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });

    it('sale con 0 si el prerender termina y el cierre también', async () => {
      const exit = vi.fn();
      await runCli({ prerenderImpl: async () => ({ skipped: false, routes: 3, closeTimedOut: false }), exit, logger: logger() });
      expect(exit).toHaveBeenCalledWith(0);
    });

    it('sale con 0 con SKIP_PRERENDER (resultado { skipped: true })', async () => {
      const exit = vi.fn();
      await runCli({ prerenderImpl: async () => ({ skipped: true }), exit, logger: logger() });
      expect(exit).toHaveBeenCalledWith(0);
    });

    it('sale con 1 si el cierre agotó su plazo, y lo explica por error', async () => {
      const exit = vi.fn();
      const log = logger();
      await runCli({ prerenderImpl: async () => ({ skipped: false, routes: 3, closeTimedOut: true }), exit, logger: log });
      expect(exit).toHaveBeenCalledWith(1);
      expect(exit).not.toHaveBeenCalledWith(0);
      expect(log.error.mock.calls.flat().join('\n')).toMatch(/\[prerender\].*cierre/);
    });

    it('sale con 1 si el prerender rechaza', async () => {
      const exit = vi.fn();
      const log = logger();
      await runCli({ prerenderImpl: async () => { throw new Error('[prerender] boom'); }, exit, logger: log });
      expect(exit).toHaveBeenCalledWith(1);
      expect(log.error).toHaveBeenCalledWith('[prerender] boom');
    });

    it('extremo a extremo: con un preview que no cierra, prerender real + runCli sale con 1', async () => {
      const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prerender-cli-'));
      fs.writeFileSync(path.join(distDir, '404.html'), '<!doctype html><html><head></head><body><div id="root"></div></body></html>');
      fs.writeFileSync(path.join(distDir, 'sitemap.xml'), '<urlset></urlset>');
      const page = {
        on: () => {}, goto: async () => {}, waitForTimeout: async () => {}, close: async () => {},
        waitForFunction: async () => ({ jsonValue: async () => 'ready' }),
        evaluate: async () => '<main><h1>404</h1></main>',
      };
      const browser = { newContext: async () => ({ addInitScript: async () => {}, newPage: async () => page }), close: async () => {} };
      const exit = vi.fn();
      try {
        await runCli({
          exit, logger: logger(),
          prerenderImpl: () => prerender({
            env: {}, distDir, logger: quiet, closeTimeoutMs: 30,
            launchBrowser: async () => browser,
            startPreview: async () => ({ url: 'http://preview.test', close: () => new Promise(() => {}) }),
          }),
        });
        expect(exit).toHaveBeenCalledWith(1);
      } finally {
        fs.rmSync(distDir, { recursive: true, force: true });
      }
    }, 2000);
  });

  it('sin Chromium FALLA (no avisa y sigue): una build de despliegue sin prerender publicaría páginas vacías', async () => {
    const launchBrowser = vi.fn().mockRejectedValue(new Error("Executable doesn't exist"));
    const startPreview = vi.fn();
    await expect(prerender({ env: {}, launchBrowser, startPreview, logger: quiet }))
      .rejects.toThrow(/Chromium[\s\S]*npx playwright install chromium[\s\S]*SKIP_PRERENDER=1/);
    expect(startPreview).not.toHaveBeenCalled();
  });
});
