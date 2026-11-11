/**
 * T3 + P0-1 (OSS): la versión self-hosted reintegra Gastos (UI, ruta cliente
 * path="gastos", tablas y migraciones). Siguen fuera los módulos de negocio/SaaS
 * que no tienen sentido fuera del host de producto: beta/allowlist, el embudo
 * de activación (admin), la landing/blog/legales (contenido de marketing del
 * sitio público) y las piezas de negocio del panel de admin (embudo,
 * beta/allowlist, blog, stats y logs). Esta suite no debilita esas exclusiones.
 * El OSS SÍ conserva un panel de admin básico de gestión de usuarios
 * y salud de proveedores (`/api/admin/users`, `/api/admin/health`): no están
 * en la lista de rutas prohibidas de más abajo.
 *
 * Dos router distintos:
 *   - Front: src/App.jsx (appRouteElements) — hoy monta TODO lo anterior.
 *   - Server: se espera `server/app.js` exportando `createApp()` (Express app
 *     sin `.listen()`) para poder introspeccionar su stack de rutas en un
 *     test; HOY NO EXISTE (server/index.js crea el app y lo arranca en el
 *     mismo módulo — ver su cabecera). Mientras no exista, este test falla
 *     con una aserción clara en vez de intentar importar algo que no está.
 *
 * Además: ningún import RELATIVO ('./' o '../') de un fichero bajo src/ o
 * server/ debe apuntar a un fichero que no existe (recorrido estático,
 * sin resolver imports con alias '@/').
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '../..');
const APP_JSX = path.join(ROOT, 'src/App.jsx');
const SERVER_APP_JS = path.join(ROOT, 'server/app.js');

// ── Front: Gastos vuelve al export; el resto de módulos no abiertos sigue fuera ──
const REQUIRED_GASTOS_FRONT_IDENTIFIERS = [
  'ExpensesPage',
  'path="gastos"',
];

const FORBIDDEN_FRONT_IDENTIFIERS = [
  // D3: stats/logs/embudo/forzar precio. UI mínima /app/admin (AdminDashboard) SÍ es OSS.
  'FunnelPanel',
  'adminFunnel',
  'LogConsole',
  'SystemPanels',
  'adminForceAssetPrice',
  'force-asset-price',
  'forceAssetPrice',
  'SignupSourceTracker',
  'signupSource',
  'LandingPage',
  'BlogPage',
  'BlogPostPage',
  'PrivacyPage',
  'TermsPage',
];

describe('src/App.jsx — P0-1: el router front reintegra Gastos', () => {
  it('existe src/App.jsx', () => {
    expect(fs.existsSync(APP_JSX), 'falta src/App.jsx').toBe(true);
  });

  const src = fs.existsSync(APP_JSX) ? fs.readFileSync(APP_JSX, 'utf8') : '';

  for (const needle of REQUIRED_GASTOS_FRONT_IDENTIFIERS) {
    it(`referencia "${needle}" (Gastos en el export OSS)`, () => {
      expect(src.includes(needle), `src/App.jsx no referencia "${needle}" (Gastos debe volver al export)`).toBe(true);
    });
  }
});

describe('src/App.jsx — router front sin embudo/landing/blog/legales (admin mínimo SÍ; Gastos permitido)', () => {
  it('existe src/App.jsx', () => {
    expect(fs.existsSync(APP_JSX), 'falta src/App.jsx').toBe(true);
  });

  const src = fs.existsSync(APP_JSX) ? fs.readFileSync(APP_JSX, 'utf8') : '';

  it('la lista de exclusiones front ya no prohíbe Gastos', () => {
    expect(FORBIDDEN_FRONT_IDENTIFIERS).not.toContain('ExpensesPage');
    expect(FORBIDDEN_FRONT_IDENTIFIERS).not.toContain('path="gastos"');
  });

  for (const needle of FORBIDDEN_FRONT_IDENTIFIERS) {
    it(`no referencia "${needle}"`, () => {
      expect(src.includes(needle), `src/App.jsx referencia "${needle}" (módulo OSS-excluido)`).toBe(false);
    });
  }

  // Planner: OSS conserva UI mínima /app/admin (usuarios + límites IA).
  // Si Develop (ccfea1fb/32657163) eliminó AdminDashboard, estos quedan en ROJO.
  it('conserva AdminDashboard (panel admin mínimo OSS)', () => {
    // Solo cuenta lo trackeado: un leftover untracked en el box no cuenta.
    let tracked = false;
    try {
      tracked = execFileSync('git', ['ls-files', '--', 'src/pages/AdminDashboard.jsx'], {
        cwd: ROOT, encoding: 'utf8',
      }).trim().length > 0;
    } catch { /* sin git */ }
    expect(
      src.includes('AdminDashboard') || tracked,
      'falta AdminDashboard: D3 solo debía quitar stats/logs/embudo/forzar precio, no toda la UI admin',
    ).toBe(true);
  });
  it('conserva la ruta path="admin" bajo /app', () => {
    expect(
      /path=["']admin["']/.test(src) || src.includes('path="admin"') || src.includes("path='admin'"),
      'App.jsx debe montar /app/admin (UI mínima OSS)',
    ).toBe(true);
  });
  it('appRedirects no elimina /app/admin del árbol de rutas', () => {
    const redirects = path.join(ROOT, 'src/lib/appRedirects.jsx');
    expect(fs.existsSync(redirects), 'falta src/lib/appRedirects.jsx').toBe(true);
    const r = fs.readFileSync(redirects, 'utf8');
    // No debe redirigir admin fuera de /app ni borrar la ruta.
    expect(r, 'appRedirects no debe expulsar /app/admin').not.toMatch(/from:\s*['"]admin['"].*to:\s*['"]\/(?!app)/);
  });
});

// ── Server: createApp() de server/app.js no debe montar estas rutas ─────────
// OJO con '/api/admin/users': el panel de admin básico de gestión de
// usuarios SÍ es OSS (ver server/oss/adminBasic.test.js) — lo que se
// excluye aquí es solo el sufijo '/plan' (PATCH /api/admin/users/:userId/plan,
// gestión de planes de pago/SaaS, M-A de /tmp/oss-d8-review.md), nunca el
// resto de '/api/admin/users'. Por eso se usa la firma completa
// "PATCH /api/admin/users/:userId/plan" como substring, no un genérico
// '/api/admin/users' ni un '/plan' suelto que pudiera colarse en otra ruta.
// Gastos es ruta de cliente (path="gastos"); no se exige ni se prohíbe
// un endpoint de servidor '/gastos'. El resto de exclusiones se mantiene.
const FORBIDDEN_SERVER_ROUTE_SUBSTRINGS = [
  '/api/admin/funnel',
  '/api/admin/beta',
  '/api/admin/blog',
  '/api/admin/logs',
  '/api/admin/stats',
  '/api/admin/force-asset-price',
  'PATCH /api/admin/users/:userId/plan',
];

/** Lista rutas montadas (método + path) recorriendo app._router.stack (Express 4/5 clásico). */
function listRoutePaths(app) {
  const stack = app?._router?.stack || app?.router?.stack || [];
  const paths = [];
  const visit = (layer, prefix) => {
    if (layer.route) {
      const p = `${prefix}${layer.route.path}`;
      for (const m of Object.keys(layer.route.methods || {})) paths.push(`${m.toUpperCase()} ${p}`);
    } else if (layer.name === 'router' && layer.handle?.stack) {
      const nested = layer.regexp && layer.regexp.fast_slash ? '' : prefix;
      for (const l of layer.handle.stack) visit(l, nested);
    }
  };
  for (const layer of stack) visit(layer, '');
  return paths;
}

describe('server/app.js — createApp() sin rutas de beta/allowlist/embudo/blog-admin (Gastos no se prohíbe)', () => {
  it('existe server/app.js exportando createApp() (Express app sin .listen())', () => {
    expect(
      fs.existsSync(SERVER_APP_JS),
      'falta server/app.js con createApp(): server/index.js hoy crea el app y lo arranca en el mismo módulo (ver su cabecera), lo que impide introspeccionar/testear sus rutas sin levantar un puerto real',
    ).toBe(true);
  });

  it('createApp() no monta ninguna ruta prohibida', async () => {
    if (!fs.existsSync(SERVER_APP_JS)) {
      expect(false, 'falta server/app.js: no se puede listar su stack de rutas').toBe(true);
      return;
    }
    let createApp;
    try {
      ({ createApp } = await import(SERVER_APP_JS));
    } catch (e) {
      expect(false, `server/app.js no exporta createApp() importable: ${e.message}`).toBe(true);
      return;
    }
    expect(typeof createApp, 'server/app.js no exporta una función createApp()').toBe('function');
    const app = createApp({});
    const routes = listRoutePaths(app).join('\n');
    // Recoge TODAS las rutas prohibidas montadas (embudo/funnel, beta/allowlist,
    // blog, Gastos/expenses…) y falla listándolas todas de una vez, en vez de
    // pararse en la primera coincidencia (un solo `expect` por iteración
    // ocultaba el resto de rutas prohibidas aún montadas).
    const found = FORBIDDEN_SERVER_ROUTE_SUBSTRINGS.filter((forbidden) => routes.includes(forbidden));
    expect(found, `createApp() monta rutas prohibidas:\n${found.join('\n')}`).toEqual([]);
  });
});

// Los 10 handlers de negocio/SaaS (embudo, beta/allowlist, blog-admin) viven
// hoy en server/app.js (createApp()), no en server/index.js (que solo monta
// el app y arranca el listener). Se comprueba contra las rutas REALMENTE
// montadas por createApp(), no por una búsqueda de texto sobre el fichero.
describe('server/app.js (createApp()) — no debería montar los handlers de beta/allowlist/embudo/blog-admin', () => {
  it('existe server/app.js', () => {
    expect(fs.existsSync(SERVER_APP_JS)).toBe(true);
  });

  const HANDLER_ROUTE_SIGNATURES = {
    adminFunnel: 'GET /api/admin/funnel',
    adminListBeta: 'GET /api/admin/beta',
    adminDecideBeta: 'PATCH /api/admin/beta/:userId',
    adminListAllowlist: 'GET /api/admin/beta-allowlist',
    adminAddAllowlist: 'POST /api/admin/beta-allowlist',
    adminRemoveAllowlist: 'DELETE /api/admin/beta-allowlist/:id',
    adminBlogList: 'GET /api/admin/blog',
    adminBlogSave: 'POST /api/admin/blog',
    adminBlogDelete: 'DELETE /api/admin/blog/:id',
    adminBlogNotify: 'POST /api/admin/blog/:id/notify',
    adminForceAssetPrice: 'POST /api/admin/force-asset-price',
  };

  let mountedRoutes = [];
  let importError = null;
  beforeAll(async () => {
    if (!fs.existsSync(SERVER_APP_JS)) return;
    try {
      const { createApp } = await import(SERVER_APP_JS);
      mountedRoutes = listRoutePaths(createApp({}));
    } catch (e) {
      importError = e;
    }
  });

  for (const [handlerName, routeSignature] of Object.entries(HANDLER_ROUTE_SIGNATURES)) {
    it(`no monta el handler ${handlerName} (${routeSignature})`, () => {
      if (!fs.existsSync(SERVER_APP_JS)) {
        expect(false, 'falta server/app.js: no se puede listar su stack de rutas').toBe(true);
        return;
      }
      if (importError) {
        expect(false, `server/app.js no exporta createApp() importable: ${importError.message}`).toBe(true);
        return;
      }
      expect(
        mountedRoutes.includes(routeSignature),
        `createApp() monta el handler ${handlerName} en "${routeSignature}"`,
      ).toBe(false);
    });
  }
});


describe('P0-1 no debilita las exclusiones de los demás módulos', () => {
  it('el front sigue prohibiendo embudo, landing, blog, legales y force-asset-price', () => {
    const mustStay = [
      'FunnelPanel',
      'LandingPage',
      'BlogPage',
      'PrivacyPage',
      'TermsPage',
      'force-asset-price',
    ];
    const missing = mustStay.filter((id) => !FORBIDDEN_FRONT_IDENTIFIERS.includes(id));
    expect(missing, `se han debilitado exclusiones front: ${missing.join(', ')}`).toEqual([]);
  });

  it('el server sigue prohibiendo funnel, beta, blog, logs, stats, force-asset-price y PATCH plan', () => {
    const mustStay = [
      '/api/admin/funnel',
      '/api/admin/beta',
      '/api/admin/blog',
      '/api/admin/logs',
      '/api/admin/stats',
      '/api/admin/force-asset-price',
      'PATCH /api/admin/users/:userId/plan',
    ];
    const missing = mustStay.filter((id) => !FORBIDDEN_SERVER_ROUTE_SUBSTRINGS.includes(id));
    expect(missing, `se han debilitado exclusiones server: ${missing.join(', ')}`).toEqual([]);
  });

  it('FORBIDDEN_SERVER_ROUTE_SUBSTRINGS ya no incluye /gastos', () => {
    expect(FORBIDDEN_SERVER_ROUTE_SUBSTRINGS).not.toContain('/gastos');
  });
});

// ── Imports relativos rotos en src/ y server/ ───────────────────────────────

const CODE_EXT_RE = /\.(js|jsx|mjs|cjs|ts|tsx)$/;
const RESOLVE_EXTS = ['', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);

function listSourceFiles(root) {
  const out = [];
  const rec = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) rec(abs);
      else if (CODE_EXT_RE.test(e.name)) out.push(abs);
    }
  };
  rec(root);
  return out;
}

/** Especificadores de import/require RELATIVOS ('./' o '../') de un fichero fuente. */
function extractRelativeSpecifiers(content) {
  const specs = new Set();
  const patterns = [
    /\bfrom\s+['"](\.[^'"]*)['"]/g,
    /\bimport\s*\(\s*['"](\.[^'"]*)['"]\s*\)/g,
    /\brequire\s*\(\s*['"](\.[^'"]*)['"]\s*\)/g,
    /^\s*import\s+['"](\.[^'"]*)['"]/gm,
  ];
  for (const re of patterns) {
    let m;
    // eslint-disable-next-line no-cond-assign
    while ((m = re.exec(content))) specs.add(m[1]);
  }
  return specs;
}

/** true si `spec` (relativo a `fromFile`) resuelve a un fichero real. */
function resolvesToFile(fromFile, spec) {
  const clean = spec.split('?')[0].split('#')[0];
  const base = path.resolve(path.dirname(fromFile), clean);
  for (const ext of RESOLVE_EXTS) {
    if (fs.existsSync(base + ext) && fs.statSync(base + ext).isFile()) return true;
  }
  // Directorio con index.*
  if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
    for (const ext of RESOLVE_EXTS) {
      const idx = path.join(base, `index${ext}`);
      if (fs.existsSync(idx) && fs.statSync(idx).isFile()) return true;
    }
  }
  return false;
}

describe('imports relativos en src/ y server/ resuelven a ficheros existentes', () => {
  const dirs = [path.join(ROOT, 'src'), path.join(ROOT, 'server')];
  const broken = [];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of listSourceFiles(dir)) {
      const content = fs.readFileSync(file, 'utf8');
      for (const spec of extractRelativeSpecifiers(content)) {
        // No se verifican extensiones de asset no ejecutable (css, svg, png…):
        // las resuelve Vite/webpack con loaders propios, fuera del alcance
        // de "import de módulo apunta a fichero inexistente".
        if (/\.(css|scss|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|mp3|mp4|pdf|csv|json)$/i.test(spec)) {
          const clean = spec.split('?')[0];
          const base = path.resolve(path.dirname(file), clean);
          if (!fs.existsSync(base)) broken.push({ file: path.relative(ROOT, file), spec });
          continue;
        }
        if (!resolvesToFile(file, spec)) {
          broken.push({ file: path.relative(ROOT, file), spec });
        }
      }
    }
  }

  it('no hay imports relativos a ficheros inexistentes bajo src/ o server/', () => {
    const msg = broken.map((b) => `${b.file} → "${b.spec}"`).join('\n');
    expect(broken.length, `imports rotos:\n${msg}`).toBe(0);
  });
});
