/**
 * Guardia: toda ruta Express con handler async debe ir envuelta en asyncHandler.
 *
 * Develop implementa `asyncHandler` (p. ej. server/lib/asyncHandler.js) con una
 * marca detectable (`fn.__asyncHandler === true` o `fn.name` que contenga
 * "asyncHandler") y `createApp` sin listen. Las rutas viven en server/app.js
 * (index.js solo hace listen + crons).
 *
 * withRateLimit real (async) debe aparecer envuelto: no mockearlo como sync.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../lib/requireUser.js', () => ({
  requireUser: vi.fn(async () => ({ id: 'u1' })),
}));
vi.mock('../lib/adminSupabase.js', () => ({ supabaseAdmin: null }));
vi.mock('../lib/groqClient.js', () => ({
  getGroq: vi.fn(() => ({
    chat: { completions: { create: vi.fn(async () => ({ choices: [{ message: { content: 'x' } }] })) } },
  })),
}));
vi.mock('../lib/emailTransport.js', () => ({
  sendEmail: vi.fn(async () => ({ ok: true, attempts: 1 })),
}));
vi.mock('../lib/logBuffer.js', () => ({ addLog: vi.fn() }));
vi.mock('../jobs/notificationCron.js', () => ({ startNotificationCron: vi.fn() }));
vi.mock('../jobs/portfolioSnapshots.js', () => ({ startPortfolioSnapshotsCron: vi.fn() }));
vi.mock('../jobs/weeklyReport.js', () => ({ startWeeklyReportCron: vi.fn() }));
vi.mock('../jobs/siteVisits.js', () => ({ startSiteVisitsCron: vi.fn() }));
vi.mock('../jobs/activationEmail.js', () => ({ startActivationEmailCron: vi.fn() }));

const ROUTES_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.dirname(ROUTES_DIR);
const APP_PATH = path.join(SERVER_DIR, 'app.js');

/** ¿Parece un handler async (AsyncFunction o promesa explícita)? */
function isAsyncHandler(fn) {
  if (typeof fn !== 'function') return false;
  if (fn.constructor?.name === 'AsyncFunction') return true;
  return false;
}

function isWrappedByAsyncHandler(fn) {
  if (!fn || typeof fn !== 'function') return false;
  if (fn.__asyncHandler === true || fn.__asyncWrapped === true) return true;
  if (typeof fn.name === 'string' && /asyncHandler/i.test(fn.name)) return true;
  if (fn.__wrapped && isWrappedByAsyncHandler(fn.__wrapped)) return true;
  if (fn.handler && isWrappedByAsyncHandler(fn.handler)) return true;
  return false;
}

/** Recorre app._router.stack y routers anidados; recoge capas route. */
function walkLayers(stack, acc = [], prefix = '') {
  if (!Array.isArray(stack)) return acc;
  for (const layer of stack) {
    if (layer.route) {
      const routePath = prefix + (layer.route.path || '');
      const methods = Object.keys(layer.route.methods || {}).filter((m) => layer.route.methods[m]);
      const handlers = (layer.route.stack || []).map((l) => l.handle);
      acc.push({ path: routePath, methods, handlers });
    } else if (layer.name === 'router' && layer.handle?.stack) {
      const mountPath = typeof layer.path === 'string' ? layer.path : '';
      walkLayers(layer.handle.stack, acc, prefix + mountPath);
    }
  }
  return acc;
}

/**
 * Análisis estático: handlers `export async function X` / `export const X = async`
 * montados en app.js sin `asyncHandler(...)`.
 * @returns {{ unwrapped: string[], mountsParsed: number }}
 */
function findUnwrappedAsyncRoutesFromSource() {
  const appSrc = fs.readFileSync(APP_PATH, 'utf8');
  const routeFiles = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js') && !f.includes('.test.'));

  const asyncExports = new Map(); // exportName → file
  for (const file of routeFiles) {
    const src = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
    const patterns = [
      /export\s+async\s+function\s+(\w+)/g,
      /export\s+const\s+(\w+)\s*=\s*async\s*(?:function)?\s*\(/g,
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(src))) {
        asyncExports.set(m[1], file);
      }
    }
  }

  const unwrapped = [];
  let mountsParsed = 0;
  for (const line of appSrc.split('\n')) {
    const mount = line.match(
      /^\s*app\.(get|post|put|patch|delete)\(\s*['`]([^'`]+)['`](.+)$/,
    );
    if (!mount) continue;
    mountsParsed += 1;
    const method = mount[1].toUpperCase();
    const routePath = mount[2];
    const rest = mount[3];

    const wrappedCall = rest.match(/asyncHandler\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*\)\s*;?\s*$/);
    const plainCall = rest.match(/,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*;?\s*$/);
    const handlerName = wrappedCall?.[1] || plainCall?.[1];
    if (!handlerName || !asyncExports.has(handlerName)) continue;

    const wrappedHere = Boolean(wrappedCall);
    const routeFile = asyncExports.get(handlerName);
    const routeSrc = fs.readFileSync(path.join(ROUTES_DIR, routeFile), 'utf8');
    const wrappedAtExport = new RegExp(
      `export\\s+const\\s+${handlerName}\\s*=\\s*asyncHandler\\s*\\(`,
    ).test(routeSrc)
      || new RegExp(
        `const\\s+${handlerName}\\s*=\\s*asyncHandler\\s*\\([\\s\\S]*?export\\s*\\{[^}]*\\b${handlerName}\\b`,
      ).test(routeSrc);

    if (!wrappedHere && !wrappedAtExport) {
      unwrapped.push(`${method} ${routePath} → ${handlerName} (${routeFile})`);
    }
  }

  const marketSrc = fs.readFileSync(path.join(ROUTES_DIR, 'marketProxy.js'), 'utf8');
  if (/export\s+async\s+function\s+eodhdSecure/.test(marketSrc)
      && !/asyncHandler\s*\(\s*eodhdSecure\s*\)/.test(marketSrc)
      && !/eodhdSecure\s*=\s*asyncHandler/.test(marketSrc)) {
    unwrapped.push('ALL /api/eodhd-secure/* → eodhdSecure (marketProxy.js)');
  }

  return { unwrapped, mountsParsed };
}

describe('asyncHandler.guard — estático', () => {
  it('ninguna ruta async montada en app.js/routes queda sin asyncHandler', () => {
    const { unwrapped, mountsParsed } = findUnwrappedAsyncRoutesFromSource();
    // Umbral dinámico: tantas rutas como app.get/post/... reales en app.js (no un número fijo).
    const appSrc = fs.readFileSync(APP_PATH, 'utf8');
    const registeredMounts = appSrc.split('\n').filter((line) =>
      /^\s*app\.(get|post|put|patch|delete)\(\s*['`]/.test(line),
    ).length;
    expect(
      mountsParsed,
      `app.js registra ${registeredMounts} rutas app.get/post/...; el parser vio ${mountsParsed}`,
    ).toBe(registeredMounts);
    expect(registeredMounts, 'app.js debe montar al menos una ruta').toBeGreaterThan(0);
    expect(
      unwrapped,
      `Rutas async SIN asyncHandler (${unwrapped.length}):\n${unwrapped.map((u) => `  - ${u}`).join('\n')}`,
    ).toEqual([]);
  });

  it('existe módulo asyncHandler exportando una función marcable', async () => {
    let asyncHandler;
    let err = null;
    try {
      ({ asyncHandler } = await import('../lib/asyncHandler.js'));
    } catch (e) {
      err = e;
      asyncHandler = undefined;
    }
    expect(
      typeof asyncHandler,
      err
        ? `asyncHandler ausente: ${err.message}. Crear server/lib/asyncHandler.js`
        : 'asyncHandler debe ser una función',
    ).toBe('function');
    const wrapped = asyncHandler(async () => {});
    expect(
      isWrappedByAsyncHandler(wrapped),
      'asyncHandler(fn) debe marcar el wrapper (__asyncHandler/__asyncWrapped o name)',
    ).toBe(true);
  });
});

describe('asyncHandler.guard — runtime stack', () => {
  let createApp;
  let app;
  let loadErr = null;

  beforeAll(async () => {
    try {
      ({ createApp } = await import('../app.js'));
    } catch (e) {
      loadErr = e;
      createApp = undefined;
    }
  });

  it('createApp disponible para inspeccionar el stack', () => {
    expect(
      typeof createApp,
      loadErr
        ? `createApp ausente: ${loadErr.message}. Exportar createApp desde server/app.js sin listen.`
        : 'createApp ausente: debe exportarse desde server/app.js',
    ).toBe('function');
    app = createApp({ disableCrons: true });
  });

  it('cada route layer con handler AsyncFunction está envuelta por asyncHandler', () => {
    expect(
      typeof createApp,
      loadErr
        ? `createApp ausente: ${loadErr.message}`
        : 'createApp ausente: server/app.js',
    ).toBe('function');
    if (!app) app = createApp({ disableCrons: true });

    const stack = app?._router?.stack;
    expect(stack, 'app._router.stack debe existir').toBeTruthy();
    const routes = walkLayers(stack);
    const offenders = [];
    for (const r of routes) {
      const terminal = [...r.handlers].reverse().find((h) => typeof h === 'function');
      if (!terminal) continue;
      if (!isAsyncHandler(terminal) && !isWrappedByAsyncHandler(terminal)) {
        continue;
      }
      if (isAsyncHandler(terminal) && !isWrappedByAsyncHandler(terminal)) {
        offenders.push(`${r.methods.join(',').toUpperCase()} ${r.path}`);
      }
      if (isWrappedByAsyncHandler(terminal)) continue;
    }
    for (const r of routes) {
      for (const h of r.handlers) {
        if (isAsyncHandler(h) && !isWrappedByAsyncHandler(h)) {
          const label = `${r.methods.join(',').toUpperCase()} ${r.path}`;
          if (!offenders.includes(label)) offenders.push(label);
        }
      }
    }
    expect(
      offenders,
      `Handlers async sin asyncHandler en stack (${offenders.length}):\n${offenders.map((o) => `  - ${o}`).join('\n')}`,
    ).toEqual([]);
  });

  it('ruta async sin envolver: forzar rechazo produce respuesta controlada (no hang)', async () => {
    expect(
      typeof createApp,
      loadErr
        ? `createApp ausente: ${loadErr.message}`
        : 'createApp ausente: server/app.js',
    ).toBe('function');

    let asyncHandler;
    try {
      ({ asyncHandler } = await import('../lib/asyncHandler.js'));
    } catch {
      asyncHandler = null;
    }
    expect(typeof asyncHandler).toBe('function');

    const http = await import('node:http');
    const boomApp = createApp({ disableCrons: true });
    boomApp.post('/__guard/boom', asyncHandler(async () => {
      throw new Error('guard-secret');
    }));
    const server = http.createServer(boomApp);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3000);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/__guard/boom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: ac.signal,
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(JSON.stringify(body)).not.toContain('guard-secret');
    } finally {
      clearTimeout(timer);
      await new Promise((r) => server.close(r));
    }
  });
});
