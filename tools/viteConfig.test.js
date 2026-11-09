import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

describe('vite.config.js', () => {
  it('cargarlo no sustituye console.warn ni console.error del proceso', async () => {
    // La plantilla de  traía `console.warn = () => {}` a nivel de módulo.
    // Como la config se carga DENTRO del proceso que la usa (vite build y el
    // preview() de tools/prerender.mjs), dejaba mudo cualquier console.warn del
    // proceso: los avisos de Vite/Rollup y los AVISO del prerender (revisión 2026-10-18).
    const { warn, error, log } = console;
    const mod = await import('../vite.config.js');
    expect(mod.default).toBeTruthy();
    expect(console.warn).toBe(warn);
    expect(console.error).toBe(error);
    expect(console.log).toBe(log);
  });

  it('el logger de la config no se traga los errores de PostCSS (CssSyntaxError)', async () => {
    // La plantilla de  traía un customLogger que descartaba EN BLOQUE todo
    // error con "CssSyntaxError: [postcss]": un CSS roto compilaba en silencio.
    const { default: config } = await import('../vite.config.js');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const err = new Error('CssSyntaxError: [postcss] /src/index.css:1:1: Unknown word');
      // Sin customLogger, Vite usa el suyo, que no filtra nada.
      if (config.customLogger) {
        config.customLogger.error('[vite:css] fallo de PostCSS', { error: err });
        expect(spy.mock.calls.flat().join('\n')).toMatch(/fallo de PostCSS/);
      } else {
        expect(config.customLogger).toBeUndefined();
      }
    } finally {
      spy.mockRestore();
    }
  });
});

describe('vite.config.js — VITE_VALIDATION_SERVER_URL (sin fallback a :4000)', () => {
  const URL = 'http://127.0.0.1:4100';

  it('en dev (serve, modo development) sin la variable lanza un error claro', async () => {
    const { resolveApiServerTarget } = await import('../vite.config.js');
    expect(() => resolveApiServerTarget({ command: 'serve', mode: 'development', env: {} }))
      .toThrow(/VITE_VALIDATION_SERVER_URL/);
  });

  it('build, preview (serve en modo production: prerender y CI) y vitest (modo test) funcionan sin ella', async () => {
    const { resolveApiServerTarget } = await import('../vite.config.js');
    expect(resolveApiServerTarget({ command: 'build', mode: 'production', env: {} })).toBeNull();
    expect(resolveApiServerTarget({ command: 'serve', mode: 'production', env: {} })).toBeNull();
    expect(resolveApiServerTarget({ command: 'serve', mode: 'test', env: {} })).toBeNull();
  });

  it('con la variable, los proxies del Express apuntan a ella (dev y preview)', async () => {
    const { expressApiProxy } = await import('../vite.config.js');
    const plugin = expressApiProxy({ VITE_VALIDATION_SERVER_URL: URL });
    for (const env of [{ command: 'serve', mode: 'development' }, { command: 'serve', mode: 'production' }]) {
      const proxy = plugin.config({}, env).server.proxy;
      for (const route of ['/api/assets', '/api/admin', '/api/log-error', '/share-data', '/webhooks']) {
        expect(proxy[route]).toEqual({ target: URL, changeOrigin: true });
      }
    }
    expect(expressApiProxy({}).config({}, { command: 'build', mode: 'production' })).toBeUndefined();
    expect(() => expressApiProxy({}).config({}, { command: 'serve', mode: 'development' }))
      .toThrow(/VITE_VALIDATION_SERVER_URL/);
  });

  it('el plugin va en la config y no queda ningún fallback a localhost:4000', async () => {
    const { default: config } = await import('../vite.config.js');
    expect(config.plugins.flat().some((p) => p?.name === 'trazza-express-api-proxy')).toBe(true);
    const src = fs.readFileSync(path.join(ROOT, 'vite.config.js'), 'utf8');
    expect(src).not.toMatch(/localhost:4000/);
    expect(src).not.toMatch(/VITE_VALIDATION_SERVER_URL\s*\|\|/);
  });

  it('los smokes E2E exigen la variable antes de abrir el navegador', () => {
    const dir = path.join(ROOT, 'e2e');
    const smokes = fs.readdirSync(dir).filter((f) => f.endsWith('.smoke.mjs'));
    expect(smokes.length).toBeGreaterThanOrEqual(3);
    for (const f of smokes) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(src, f).toMatch(/import \{ requireValidationServerUrl \} from '\.\/requireEnv\.mjs';/);
      expect(src, f).toMatch(/^requireValidationServerUrl\(\);$/m);
    }
  });

  it('requireValidationServerUrl corta sin la variable y deja pasar con ella', async () => {
    const { requireValidationServerUrl } = await import('../e2e/requireEnv.mjs');
    expect(() => requireValidationServerUrl({})).toThrow(/VITE_VALIDATION_SERVER_URL/);
    expect(requireValidationServerUrl({ VITE_VALIDATION_SERVER_URL: URL })).toBe(URL);
  });

});
