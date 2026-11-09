/**
 * T? (OSS) — el panel de admin básico que el self-hoster SÍ conserva:
 * `GET /api/admin/users` (gestión de usuarios/plan) y `GET /api/admin/health`
 * (salud de proveedores). Ambas pasan por el mismo guard, `requireAdmin`
 * (server/lib/requireAdmin.js).
 *
 * NUEVA fuente de admin (aún SIN implementar en requireAdmin.js en HEAD —
 * existe un WIP en `dev/oss-d4-wip:server/lib/requireAdmin.js` que cubre
 * ADMIN_EMAILS/primer-usuario pero NO email_confirmed_at, NI persistencia,
 * NI un cap de paginación real — ver el resumen al final de este fichero y
 * en /tmp/oss-d8-review.md):
 *   - Admin = el email del usuario autenticado está en la env ADMIN_EMAILS
 *     (lista separada por comas, con trim y comparación case-insensitive;
 *     en los fixtures de este fichero solo se usan direcciones @example.com).
 *     Una lista vacía o solo con basura (sin ningún email válido tras el
 *     trim) EQUIVALE a no definida (I-B): cae a la regla del primer usuario,
 *     nunca "nadie es admin" ni "cualquiera lo es".
 *   - Si ADMIN_EMAILS NO está definida (o está vacía/solo basura): admin =
 *     el primer usuario registrado VERIFICADO (el de `created_at` más
 *     antiguo, SOLO entre los que tengan `email_confirmed_at` — I-C). Un
 *     usuario sin confirmar nunca es admin, ni por ADMIN_EMAILS ni por la
 *     regla del primer registrado.
 *   - `user_preferences.plan` deja de ser la señal de admin: un plan
 *     'admin' que no esté en ADMIN_EMAILS (ni sea el primer registrado
 *     verificado) NO es admin (403), y un email en ADMIN_EMAILS es admin
 *     aunque su plan sea 'user' (si está verificado).
 *   - Paginación real (I-D): `auth.admin.listUsers` es paginado de verdad
 *     (un servidor real puede imponer un tamaño de página pequeño pase lo
 *     que pida el llamador); con más de 50 usuarios, el más antiguo puede
 *     estar fuera de la primera página.
 *   - Persistencia (I-D): una vez resuelto el admin por el respaldo del
 *     primer usuario, la decisión se persiste (no se recalcula en cada
 *     request) — esto también acota cuántas veces se llama a listUsers.
 *   - Borrado (I-D): si el admin persistido desaparece, el siguiente más
 *     antiguo NO hereda admin automáticamente (haría falta ADMIN_EMAILS).
 *   - Aviso (I-D): usar el respaldo del primer usuario deja un
 *     console.warn que menciona ADMIN_EMAILS (para que el self-hoster sepa
 *     que debería fijarla).
 *
 * Se monta la app real con `createApp()` (server/app.js) y se pega con
 * supertest, como server/smokeMockedAuth.impl.test.js. Se mockea SOLO lo que
 * habla con el exterior — nunca Supabase real ni red:
 *   - server/lib/adminSupabase.js → `auth.getUser` (id + email +
 *     email_confirmed_at), `auth.admin.listUsers` (paginado de verdad sobre
 *     `authState.users`, respetando {page, perPage} del llamador — I-D
 *     sustituye esta implementación por una que ADEMÁS impone un cap de
 *     página pequeño), `auth.admin.updateUserById` (una de las dos formas
 *     de persistencia que acepta I-D) y `user_preferences.plan`, todo
 *     controlado por `authState`. Cualquier OTRA tabla de `from(...)`
 *     (p.ej. una futura tabla settings/config/admin) registra sus
 *     upsert/insert/update en `persistenceLog` — la otra forma de
 *     persistencia que acepta I-D.
 *   - server/lib/emailTransport.js → `transporter.verify()` (lo usa el check
 *     SMTP de adminHealth).
 *   - `global.fetch` → el check de Yahoo de adminHealth hace un fetch real;
 *     se mockea a nivel de FICHERO (no por describe) porque varios describes
 *     de este fichero golpean `/api/admin/health`.
 *   - GROQ_API_KEY / EODHD_PLATFORM_KEY se borran a nivel de fichero: sin
 *     ellas adminHealth responde 'unconfigured' para esos dos proveedores
 *     sin llamar a nadie.
 *
 * `GET /api/admin/health` en vez de `/users` para aislar requireAdmin: el
 * handler de `/api/admin/users` (adminListUsers) llama a
 * `auth.admin.listUsers` POR SU CUENTA para construir el listado, lo que
 * contamina cualquier recuento de llamadas o cualquier intento de aislar un
 * fallo de listUsers a SOLO la resolución de admin. `/api/admin/health` no
 * toca `auth.admin.listUsers` en su propio handler, así que cualquier
 * llamada observada viene exclusivamente de `requireAdmin`.
 *
 * I-A — todo caso de "esto debería ser admin" exige status EXACTO 200 y una
 * forma de body mínima específica por ruta (nunca basta "no es 401 ni 403":
 * eso deja pasar un 500 como si fuera acceso admin válido).
 *
 * Import de server/app.js envuelto en try/catch: un fallo de import es una
 * aserción clara ('server/app.js no exporta createApp() importable'), nunca
 * una excepción no controlada ni un timeout de Vitest.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Mock de supabaseAdmin: auth.getUser + auth.admin.listUsers + plan ──────
// authState la pilotan los tests (sin red, sin Supabase real).
const authState = vi.hoisted(() => ({
  // null => sin header válido / token no reconocido (fuerza 401 en requireAdmin)
  userId: 'u-test',
  email: null,
  // I-C: email_confirmed_at del usuario AUTENTICADO (el que lee getUser()).
  // true => confirmado (fecha fija); false => null (sin confirmar). Por
  // defecto true para no romper los casos existentes que no prueban esto.
  emailConfirmed: true,
  omitEmailConfirmed: false,
  // 'user' | 'admin' => plan devuelto para el usuario autenticado en
  // user_preferences. Con la nueva fuente de admin esto YA NO debería
  // decidir nada — solo se pone a 'admin' en el caso (b), que prueba
  // justamente que plan='admin' solo NO basta.
  plan: null,
  // Lista completa de usuarios registrados (para simular auth.admin.listUsers
  // y la regla "sin ADMIN_EMAILS, admin = el primer registrado VERIFICADO").
  // Cada entrada: { id, email, created_at, email_confirmed_at }.
  // email_confirmed_at: null => ese candidato NO está verificado (I-C) y
  // nunca debería poder ganar la regla del primer registrado.
  users: [],
}));

// Registro de escrituras en CUALQUIER tabla que no sea user_preferences/
// ai_usage — así I-D puede comprobar que la resolución del admin por
// respaldo se PERSISTE (upsert/insert/update en una tabla settings/config/
// admin) sin tener que adivinar el nombre exacto que use la implementación.
const persistenceLog = vi.hoisted(() => []);

const supabaseAdminMock = vi.hoisted(() => {
  const userPrefsBuilder = () => ({
    select: () => ({
      // requireAdmin (HEAD hoy): .select('plan').eq('user_id', id).maybeSingle()
      eq: () => ({
        maybeSingle: async () => ({
          data: authState.plan ? { plan: authState.plan } : null,
          error: null,
        }),
      }),
      // adminHealth.checkSupabase: .select('user_id').limit(1)
      limit: async () => ({ data: [], error: null }),
      // adminListUsers: .select('user_id, plan, preferred_currency').in(...)
      in: async () => ({ data: [], error: null }),
    }),
  });

  // Tabla de solo lectura inofensiva (p.ej. ai_usage): nunca debería
  // escribirse desde una ruta de admin básico.
  const readOnlyBuilder = () => ({
    select: () => ({ in: async () => ({ data: [], error: null }) }),
  });

  // CUALQUIER otra tabla (p.ej. una futura tabla de ajustes que persista
  // "quién es el admin resuelto por respaldo"): registra cada
  // upsert/insert/update en persistenceLog y resuelve lecturas vacías.
  // Thenable al final de la cadena: funciona con cualquier longitud de
  // cadena sin tener que adivinar la forma exacta que use la implementación
  // real (select().eq()... o insert() directo, etc).
  function recordingBuilder(table) {
    const api = {};
    const self = () => api;
    api.select = vi.fn(self);
    api.eq = vi.fn(self);
    api.in = vi.fn(self);
    api.order = vi.fn(self);
    api.limit = vi.fn(self);
    api.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    api.single = vi.fn(async () => ({ data: null, error: null }));
    api.upsert = vi.fn((payload, opts) => {
      persistenceLog.push({ table, method: 'upsert', payload, opts });
      return self();
    });
    api.insert = vi.fn((payload) => {
      persistenceLog.push({ table, method: 'insert', payload });
      return self();
    });
    api.update = vi.fn((payload) => {
      persistenceLog.push({ table, method: 'update', payload });
      return self();
    });
    api.then = (resolve, reject) => Promise.resolve({ data: null, error: null }).then(resolve, reject);
    return api;
  }

  return {
    auth: {
      // Cualquier Bearer no vacío cuenta como "sesión válida": el 401 por
      // token inválido/ausente ya lo cubre requireAdmin antes de llegar aquí
      // (no manda Authorization) — este mock solo decide identidad/plan/
      // verificación vía authState.
      getUser: async (token) => {
        if (!token) return { data: { user: null }, error: { message: 'missing token' } };
        return {
          data: {
            user: {
              id: authState.userId,
              email: authState.email,
              // I-C: sin esto confirmado, el email ni siquiera debería
              // poder usar la ruta ADMIN_EMAILS ni la del primer registrado.
              ...(authState.omitEmailConfirmed ? {} : {
                email_confirmed_at: authState.emailConfirmed ? '2020-01-01T00:00:00Z' : null,
              }),
            },
          },
          error: null,
        };
      },
      admin: {
        // Por defecto, pagina DE VERDAD sobre authState.users respetando
        // {page, perPage} del llamador (antes se ignoraban los parámetros y
        // se devolvía SIEMPRE la lista entera, lo que nunca ejercitaba un
        // bucle de paginación real). Con los datasets pequeños (1-2
        // usuarios) de los casos existentes esto no cambia ningún resultado:
        // siguen cabiendo todos en la primera página. I-D sustituye esta
        // implementación, SOLO en su propio describe, por una que además
        // IMPONE un cap de página pequeño pase lo que pida el llamador
        // (simulando un límite real de servidor).
        listUsers: vi.fn(async ({ page = 1, perPage = 1000 } = {}) => {
          const start = (page - 1) * perPage;
          const slice = authState.users.slice(start, start + perPage);
          return { data: { users: slice, total: authState.users.length }, error: null };
        }),
        getUserById: async () => ({ data: { user: null }, error: { message: 'not found' } }),
        // I-D: una de las dos formas de "persistir" el admin resuelto por
        // respaldo (la otra es escribir en una tabla settings/config/admin,
        // ver recordingBuilder más arriba). Vi.fn inofensivo: ninguna
        // implementación actual (HEAD ni el WIP mostrado) lo llama.
        updateUserById: vi.fn(async (userId, attrs) => {
          persistenceLog.push({ table: 'auth.admin.updateUserById', method: 'updateUserById', payload: { userId, attrs } });
          return { data: { user: { id: userId, ...attrs } }, error: null };
        }),
      },
    },
    from: (table) => {
      if (table === 'user_preferences') return userPrefsBuilder();
      if (table === 'ai_usage') return readOnlyBuilder();
      return recordingBuilder(table);
    },
  };
});

vi.mock('../lib/adminSupabase.js', () => ({ supabaseAdmin: supabaseAdminMock }));

vi.mock('../lib/emailTransport.js', () => ({
  transporter: { verify: vi.fn(async () => true) },
  EMAIL_PROVIDER: 'smtp',
}));

// Never read real server/.env or root .env in this file. loadEnv itself is
// left real: this probe detects whether importing createApp invokes dotenv.
const envProbe = vi.hoisted(() => ({ calls: [], inject: false }));
vi.mock('dotenv', () => ({ default: { config: (options) => {
  envProbe.calls.push(options?.path);
  if (envProbe.inject) process.env.TRAZZA_TDD_ENV_SENTINEL = 'synthetic-dotenv-trap';
  return { parsed: {} };
} } }));

const APP_MODULE = '../app.js';

// ── Setup de fichero completo (no solo de un describe): varios describes de
// más abajo golpean /api/admin/health, así que el fetch mockeado y el borrado
// de las API keys de proveedores IA se fijan UNA vez para todo el fichero.
const FILE_SAVED_ENV = {
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  EODHD_PLATFORM_KEY: process.env.EODHD_PLATFORM_KEY,
};
const FILE_SAVED_FETCH = global.fetch;

beforeAll(() => {
  // Sin estas dos keys, adminHealth responde 'unconfigured' para Groq/EODHD
  // sin llamar a ningún servicio externo.
  delete process.env.GROQ_API_KEY;
  delete process.env.EODHD_PLATFORM_KEY;
  // adminHealth.checkYahoo() hace un fetch real a Yahoo — se mockea siempre,
  // para que ninguna petición de este fichero toque la red por accidente.
  global.fetch = vi.fn(async () => ({ ok: true }));
});

afterAll(() => {
  if (FILE_SAVED_ENV.GROQ_API_KEY !== undefined) process.env.GROQ_API_KEY = FILE_SAVED_ENV.GROQ_API_KEY;
  if (FILE_SAVED_ENV.EODHD_PLATFORM_KEY !== undefined) process.env.EODHD_PLATFORM_KEY = FILE_SAVED_ENV.EODHD_PLATFORM_KEY;
  global.fetch = FILE_SAVED_FETCH;
});

beforeEach(() => {
  persistenceLog.length = 0;
  authState.omitEmailConfirmed = false;
});

/**
 * Import aislado de server/app.js vía vi.resetModules() + import dinámico:
 * ningún módulo (incluyendo un futuro caché de resolución de admin dentro de
 * requireAdmin.js) sobrevive de un test a otro. Los vi.mock(...) de arriba
 * SÍ sobreviven a resetModules() (viven fuera del registro de módulos que
 * limpia), así que los mocks de supabaseAdmin/emailTransport se mantienen.
 * Usado por todos los describes "nuevos" (I-B, I-C, I-D y el de
 * llamadas/fuga de listUsers) para que ningún test contamine a otro.
 */
async function freshApp() {
  vi.resetModules();
  let fresh;
  try {
    fresh = await import(APP_MODULE);
  } catch (e) {
    expect(false, `server/app.js no exporta createApp() importable (import aislado): ${e.message}`).toBe(true);
    return null;
  }
  if (typeof fresh.createApp !== 'function') {
    expect(false, 'server/app.js no exporta una función createApp() (import aislado)').toBe(true);
    return null;
  }
  return fresh.createApp();
}

/** GET con timeout corto: un hang real falla por ASERCIÓN, no por timeout de Vitest. */
async function safeGet(app, path, headers) {
  try {
    let req = request(app).get(path).timeout({ response: 3000, deadline: 3500 });
    if (headers) req = req.set(headers);
    return await req;
  } catch (e) {
    expect(false, `GET ${path} no respondió (timeout/red en vez de una respuesta HTTP): ${e.message}`).toBe(true);
    return null;
  }
}

/**
 * I-A: todo caso de "esto debería ser admin" exige status EXACTO 200 y una
 * forma de body mínima específica por ruta — nunca basta con "no es 401 ni
 * 403" (eso deja pasar un 500, que NO es acceso admin válido, como verde).
 */
function expectAdminOkShape(routePath, body) {
  if (routePath === '/api/admin/users') {
    expect(
      Array.isArray(body?.users),
      `body.users debería ser un array de usuarios en ${routePath} (body: ${JSON.stringify(body)})`,
    ).toBe(true);
    return;
  }
  if (routePath === '/api/admin/health') {
    const hasProviderChecks = !!body && typeof body === 'object'
      && (Array.isArray(body.providers) || (body.providers && typeof body.providers === 'object'));
    expect(
      hasProviderChecks,
      `body debería incluir los checks de salud por proveedor en ${routePath} (body: ${JSON.stringify(body)})`,
    ).toBe(true);
    return;
  }
  throw new Error(`expectAdminOkShape: ruta sin forma de body definida: ${routePath}`);
}

describe('panel de admin básico OSS — GET /api/admin/users y GET /api/admin/health', () => {
  let createApp;
  let importError = null;

  beforeAll(async () => {
    try {
      ({ createApp } = await import(APP_MODULE));
    } catch (e) {
      importError = e;
    }
  });

  // ADMIN_EMAILS se restaura en cada test (varios casos la fijan o la
  // borran a propósito): se guarda el valor "de fábrica" antes de cada test
  // y se repone tal cual después, nunca se arrastra entre casos.
  let savedAdminEmails;

  beforeEach(() => {
    savedAdminEmails = process.env.ADMIN_EMAILS;
    authState.userId = 'u-test';
    authState.email = null;
    authState.emailConfirmed = true;
    authState.plan = null;
    authState.users = [];
  });

  afterEach(() => {
    if (savedAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = savedAdminEmails;
  });

  function getApp() {
    if (importError) {
      expect(false, `server/app.js no exporta createApp() importable: ${importError.message}`).toBe(true);
      return null;
    }
    if (typeof createApp !== 'function') {
      expect(false, 'server/app.js no exporta una función createApp()').toBe(true);
      return null;
    }
    return createApp();
  }

  /** Recorre app._router.stack (Express 4/5 clásico) listando "MÉTODO path". */
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

  function expectRouteMounted(app, routeSignature) {
    const mounted = listRoutePaths(app);
    expect(mounted.includes(routeSignature), `falta ruta ${routeSignature}`).toBe(true);
  }

  describe.each([
    ['GET /api/admin/users', '/api/admin/users'],
    ['GET /api/admin/health', '/api/admin/health'],
  ])('%s', (routeSignature, routePath) => {
    it('sin sesión (sin Authorization): 401', async () => {
      const app = getApp();
      if (!app) return;
      expectRouteMounted(app, routeSignature);

      const res = await safeGet(app, routePath);
      if (!res) return;
      expect(res.status).toBe(401);
    });

    it('con usuario normal (ni en ADMIN_EMAILS ni primer registrado): 403', async () => {
      const app = getApp();
      if (!app) return;
      expectRouteMounted(app, routeSignature);

      // ADMIN_EMAILS fijado a OTRA dirección, para no depender de la rama
      // "sin ADMIN_EMAILS → primer registrado" en este caso base.
      process.env.ADMIN_EMAILS = 'owner@example.com';
      authState.userId = 'u-test';
      authState.email = 'normal-user@example.com';
      authState.emailConfirmed = true;
      authState.plan = 'user';
      authState.users = [
        { id: 'u-owner', email: 'owner@example.com', created_at: '2020-01-01T00:00:00Z', email_confirmed_at: '2020-01-02T00:00:00Z' },
        { id: 'u-test', email: 'normal-user@example.com', created_at: '2021-01-01T00:00:00Z', email_confirmed_at: '2021-01-02T00:00:00Z' },
      ];

      const res = await safeGet(app, routePath, { Authorization: 'Bearer valid-user-token' });
      if (!res) return;
      expect(res.status).toBe(403);
    });

    it('(a) email del usuario en ADMIN_EMAILS, SIN plan admin: 200 y forma de body correcta (I-A)', async () => {
      const app = getApp();
      if (!app) return;
      expectRouteMounted(app, routeSignature);

      // Espacios y mayúsculas a propósito: ADMIN_EMAILS se parsea con trim
      // y comparación case-insensitive.
      process.env.ADMIN_EMAILS = ' Admin@Example.com , other@example.com ';
      authState.userId = 'u-admin';
      authState.email = 'admin@example.com';
      authState.emailConfirmed = true;
      authState.plan = 'user'; // a propósito NO admin: el email basta
      authState.users = [
        { id: 'u-admin', email: 'admin@example.com', created_at: '2022-01-01T00:00:00Z', email_confirmed_at: '2022-01-02T00:00:00Z' },
      ];

      const res = await safeGet(app, routePath, { Authorization: 'Bearer valid-admin-email-token' });
      if (!res) return;
      // I-A: exacto 200, nunca "no es 401/403" (eso dejaba pasar un 500).
      expect(
        res.status,
        `con email en ADMIN_EMAILS, ${routeSignature} debería responder EXACTO 200 (un 500 no es acceso admin válido); respondió ${res.status} (body: ${JSON.stringify(res.body)})`,
      ).toBe(200);
      expectAdminOkShape(routePath, res.body);
    });

    it("(b) plan='admin' en user_preferences pero el email NO está en ADMIN_EMAILS: 403", async () => {
      const app = getApp();
      if (!app) return;
      expectRouteMounted(app, routeSignature);

      process.env.ADMIN_EMAILS = 'owner@example.com';
      authState.userId = 'u-plan-admin';
      authState.email = 'not-admin@example.com';
      authState.emailConfirmed = true;
      authState.plan = 'admin'; // único caso de este fichero con plan 'admin'
      authState.users = [
        { id: 'u-owner', email: 'owner@example.com', created_at: '2020-01-01T00:00:00Z', email_confirmed_at: '2020-01-02T00:00:00Z' },
        { id: 'u-plan-admin', email: 'not-admin@example.com', created_at: '2023-01-01T00:00:00Z', email_confirmed_at: '2023-01-02T00:00:00Z' },
      ];

      const res = await safeGet(app, routePath, { Authorization: 'Bearer plan-admin-not-in-list-token' });
      if (!res) return;
      expect(res.status).toBe(403);
    });

    it('(c) sin ADMIN_EMAILS: el primer usuario registrado → 200 y forma de body correcta (I-A)', async () => {
      const app = getApp();
      if (!app) return;
      expectRouteMounted(app, routeSignature);

      delete process.env.ADMIN_EMAILS;
      authState.userId = 'u-first';
      authState.email = 'first@example.com';
      authState.emailConfirmed = true;
      authState.plan = 'user'; // el plan no debería importar aquí tampoco
      authState.users = [
        { id: 'u-first', email: 'first@example.com', created_at: '2019-06-01T00:00:00Z', email_confirmed_at: '2019-06-02T00:00:00Z' },
        { id: 'u-second', email: 'second@example.com', created_at: '2022-06-01T00:00:00Z', email_confirmed_at: '2022-06-02T00:00:00Z' },
      ];

      const res = await safeGet(app, routePath, { Authorization: 'Bearer first-registered-user-token' });
      if (!res) return;
      expect(
        res.status,
        `sin ADMIN_EMAILS, el primer usuario registrado en ${routeSignature} debería responder EXACTO 200; respondió ${res.status} (body: ${JSON.stringify(res.body)})`,
      ).toBe(200);
      expectAdminOkShape(routePath, res.body);
    });

    it('(d) sin ADMIN_EMAILS: un usuario registrado después del primero → 403', async () => {
      const app = getApp();
      if (!app) return;
      expectRouteMounted(app, routeSignature);

      delete process.env.ADMIN_EMAILS;
      authState.userId = 'u-second';
      authState.email = 'second@example.com';
      authState.emailConfirmed = true;
      authState.plan = 'user';
      authState.users = [
        { id: 'u-first', email: 'first@example.com', created_at: '2019-06-01T00:00:00Z', email_confirmed_at: '2019-06-02T00:00:00Z' },
        { id: 'u-second', email: 'second@example.com', created_at: '2022-06-01T00:00:00Z', email_confirmed_at: '2022-06-02T00:00:00Z' },
      ];

      const res = await safeGet(app, routePath, { Authorization: 'Bearer second-registered-user-token' });
      if (!res) return;
      expect(res.status).toBe(403);
    });
  });
});

// ── Comprobación estática: la nueva fuente de admin no puede apoyarse en
// `user_preferences.plan`, y tiene que leer ADMIN_EMAILS del entorno ───────
describe('fuente de admin — comprobación estática de server/lib/requireAdmin.js', () => {
  const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  /** Recorre server/ (sin node_modules) listando ficheros .js que no son tests. */
  function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      if (!/\.(jsx?|mjs)$/.test(entry.name)) return [];
      if (/\.test\.|\.impl\.test\./.test(entry.name)) return [];
      return [full];
    });
  }

  // Descubre el/los guard(s) de admin: hoy es exactamente
  // server/lib/requireAdmin.js, pero esto también atrapa cualquier otro
  // fichero de server/ que defina una función `requireAdmin` (el nombre que
  // usan TODAS las rutas admin para importar el guard), por si aparece una
  // segunda implementación o se mueve de sitio.
  const adminGuardFiles = walk(SERVER_DIR).filter((f) => {
    if (/^requireAdmin.*\.jsx?$/i.test(path.basename(f))) return true;
    const src = fs.readFileSync(f, 'utf8');
    return /export\s+(async\s+)?function\s+requireAdmin\s*\(/.test(src);
  });

  it('se ha encontrado al menos un guard de admin que revisar', () => {
    // Si esto da 0, la búsqueda de arriba dejó de encontrar el guard (p.ej.
    // tras un rename) y las dos comprobaciones de abajo pasarían en falso
    // por no tener nada que mirar — esta aserción lo impide.
    expect(adminGuardFiles.length).toBeGreaterThan(0);
  });

  it('no decide admin mirando `plan` (ni user_preferences.plan ni comparaciones con "admin")', () => {
    for (const file of adminGuardFiles) {
      const src = fs.readFileSync(file, 'utf8');
      const rel = path.relative(SERVER_DIR, file);
      expect(
        src,
        `${rel} no debería leer/usar "plan" para decidir quién es admin (la nueva fuente es ADMIN_EMAILS / primer usuario registrado)`,
      ).not.toMatch(/\.plan\b|['"]plan['"]|plan\s*[=!]==?\s*['"]admin['"]/i);
    }
  });

  it('lee ADMIN_EMAILS del entorno', () => {
    for (const file of adminGuardFiles) {
      const src = fs.readFileSync(file, 'utf8');
      const rel = path.relative(SERVER_DIR, file);
      expect(src, `${rel} debería leer process.env.ADMIN_EMAILS`).toMatch(/process\.env\.ADMIN_EMAILS/);
    }
  });
});

// ── I-B: ADMIN_EMAILS vacía o solo basura (sin ningún email válido tras el
// trim) equivale a NO DEFINIDA → cae a la regla del primer usuario. Nunca
// "nadie es admin" (fail-closed silencioso sin aviso) ni "cualquiera es
// admin" (fail-open). El caso "email en MAYÚSCULAS/con espacios SÍ coincide"
// ya lo cubre el caso (a) de arriba con ' Admin@Example.com , other@example.com '.
describe('I-B — ADMIN_EMAILS vacía o solo basura se trata como NO definida', () => {
  const MALFORMED_VALUES = ['', ' , ', ',', 'not-an-email, also-not-one'];

  let savedAdminEmails;
  beforeEach(() => {
    savedAdminEmails = process.env.ADMIN_EMAILS;
    authState.userId = 'u-test';
    authState.email = null;
    authState.emailConfirmed = true;
    authState.plan = null;
    authState.users = [];
  });
  afterEach(() => {
    if (savedAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = savedAdminEmails;
  });

  for (const malformed of MALFORMED_VALUES) {
    it(`ADMIN_EMAILS=${JSON.stringify(malformed)} → el primer usuario registrado es admin (200)`, async () => {
      process.env.ADMIN_EMAILS = malformed;
      authState.userId = 'u-first';
      authState.email = 'first@example.com';
      authState.users = [
        { id: 'u-first', email: 'first@example.com', created_at: '2019-01-01T00:00:00Z', email_confirmed_at: '2019-01-02T00:00:00Z' },
        { id: 'u-second', email: 'second@example.com', created_at: '2022-01-01T00:00:00Z', email_confirmed_at: '2022-01-02T00:00:00Z' },
      ];

      const app = await freshApp();
      if (!app) return;
      const res = await safeGet(app, '/api/admin/health', { Authorization: 'Bearer first-token' });
      if (!res) return;
      expect(
        res.status,
        `ADMIN_EMAILS=${JSON.stringify(malformed)} debería tratarse como no definida (regla del primer usuario); respondió ${res.status} (body: ${JSON.stringify(res.body)})`,
      ).toBe(200);
      expectAdminOkShape('/api/admin/health', res.body);
    });

    it(`ADMIN_EMAILS=${JSON.stringify(malformed)} → un usuario distinto del primero NO es admin (403)`, async () => {
      process.env.ADMIN_EMAILS = malformed;
      authState.userId = 'u-second';
      authState.email = 'second@example.com';
      authState.users = [
        { id: 'u-first', email: 'first@example.com', created_at: '2019-01-01T00:00:00Z', email_confirmed_at: '2019-01-02T00:00:00Z' },
        { id: 'u-second', email: 'second@example.com', created_at: '2022-01-01T00:00:00Z', email_confirmed_at: '2022-01-02T00:00:00Z' },
      ];

      const app = await freshApp();
      if (!app) return;
      const res = await safeGet(app, '/api/admin/health', { Authorization: 'Bearer second-token' });
      if (!res) return;
      expect(
        res.status,
        `ADMIN_EMAILS=${JSON.stringify(malformed)} tratada como no definida: un usuario que no es el primer registrado no debería ser admin; respondió ${res.status}`,
      ).toBe(403);
    });
  }
});

// ── I-C: sin email_confirmed_at, nunca admin — ni por ADMIN_EMAILS ni por la
// regla del primer registrado. El primer VERIFICADO (no necesariamente el
// primero en registrarse) es el admin de respaldo.
describe('I-C — sin email verificado, nunca admin', () => {
  let savedAdminEmails;
  beforeEach(() => {
    savedAdminEmails = process.env.ADMIN_EMAILS;
    authState.userId = 'u-test';
    authState.email = null;
    authState.emailConfirmed = true;
    authState.plan = null;
    authState.users = [];
  });
  afterEach(() => {
    if (savedAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = savedAdminEmails;
  });

  it('email en ADMIN_EMAILS pero sin confirmar (email_confirmed_at null) → 403', async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    authState.userId = 'u-unconfirmed';
    authState.email = 'admin@example.com';
    authState.emailConfirmed = false; // getUser() devuelve email_confirmed_at: null
    authState.users = [
      { id: 'u-unconfirmed', email: 'admin@example.com', created_at: '2022-01-01T00:00:00Z', email_confirmed_at: null },
    ];

    const app = await freshApp();
    if (!app) return;
    const res = await safeGet(app, '/api/admin/health', { Authorization: 'Bearer unconfirmed-admin-token' });
    if (!res) return;
    expect(
      res.status,
      `un email en ADMIN_EMAILS sin confirmar nunca debería ser admin; respondió ${res.status} (body: ${JSON.stringify(res.body)})`,
    ).toBe(403);
  });

  it('el primer usuario registrado SIN confirmar nunca es admin; lo es el primer VERIFICADO', async () => {
    delete process.env.ADMIN_EMAILS;
    const users = [
      { id: 'u-unconfirmed-first', email: 'unconfirmed@example.com', created_at: '2018-01-01T00:00:00Z', email_confirmed_at: null },
      { id: 'u-verified-second', email: 'verified@example.com', created_at: '2019-01-01T00:00:00Z', email_confirmed_at: '2019-01-02T00:00:00Z' },
      { id: 'u-verified-third', email: 'later@example.com', created_at: '2020-01-01T00:00:00Z', email_confirmed_at: '2020-01-02T00:00:00Z' },
    ];

    // (1) el más antiguo de TODOS, sin confirmar, nunca debería ser admin.
    authState.userId = 'u-unconfirmed-first';
    authState.email = 'unconfirmed@example.com';
    authState.emailConfirmed = false;
    authState.users = users;
    const app1 = await freshApp();
    if (!app1) return;
    const resUnconfirmed = await safeGet(app1, '/api/admin/health', { Authorization: 'Bearer unconfirmed-first-token' });
    if (!resUnconfirmed) return;
    expect(
      resUnconfirmed.status,
      `el usuario más antiguo registrado, sin confirmar, no debería ser admin; respondió ${resUnconfirmed.status}`,
    ).toBe(403);

    // (2) el primer VERIFICADO (segundo en registrarse) SÍ debería ser admin.
    authState.userId = 'u-verified-second';
    authState.email = 'verified@example.com';
    authState.emailConfirmed = true;
    authState.users = users;
    const app2 = await freshApp();
    if (!app2) return;
    const resVerified = await safeGet(app2, '/api/admin/health', { Authorization: 'Bearer verified-second-token' });
    if (!resVerified) return;
    expect(
      resVerified.status,
      `el primer usuario VERIFICADO debería ser admin (200); respondió ${resVerified.status} (body: ${JSON.stringify(resVerified.body)})`,
    ).toBe(200);
    expectAdminOkShape('/api/admin/health', resVerified.body);

    // (3) un tercero, verificado pero registrado después del primer
    // verificado, no debería ser admin.
    authState.userId = 'u-verified-third';
    authState.email = 'later@example.com';
    authState.emailConfirmed = true;
    authState.users = users;
    const app3 = await freshApp();
    if (!app3) return;
    const resThird = await safeGet(app3, '/api/admin/health', { Authorization: 'Bearer verified-third-token' });
    if (!resThird) return;
    expect(
      resThird.status,
      `un usuario verificado pero que no es el primer VERIFICADO no debería ser admin; respondió ${resThird.status}`,
    ).toBe(403);
  });
});

// ── I-D (paginación): auth.admin.listUsers es paginado de verdad. Un
// servidor real puede imponer un tamaño de página pequeño pase lo que pida
// el llamador (p.ej. la implementación pide perPage:1000 pero el servidor
// solo devuelve 8 por página) — con >50 usuarios el más antiguo puede
// quedar fuera de la primera página, y una implementación que confíe en
// "si chunk.length < perPage_pedido, ya no hay más páginas" deja de
// paginar tras la primera tanda y resuelve mal el admin.
describe('I-D — paginación real de listUsers (page/perPage respetados, cap de servidor pequeño)', () => {
  const PAGE_CAP = 8;
  const TOTAL_USERS = 55; // > 50: el "primero por defecto" de un listUsers de una sola página
  const PAGE1_OLDEST_INDEX = 3; // más antiguo DENTRO de la página 1, pero NO el más antiguo global
  const DEEP_OLDEST_INDEX = 30; // más antiguo GLOBAL, fuera de la página 1 con PAGE_CAP=8

  function buildUsers() {
    const users = [];
    for (let i = 0; i < TOTAL_USERS; i++) {
      users.push({
        id: `u-${i}`,
        email: `user${i}@example.com`,
        created_at: '2023-01-01T00:00:00Z',
        email_confirmed_at: '2023-01-02T00:00:00Z',
      });
    }
    users[PAGE1_OLDEST_INDEX] = { ...users[PAGE1_OLDEST_INDEX], created_at: '2021-06-01T00:00:00Z' };
    users[DEEP_OLDEST_INDEX] = { ...users[DEEP_OLDEST_INDEX], created_at: '2015-01-01T00:00:00Z' };
    return users;
  }

  /** listUsers que respeta {page, perPage} pero IMPONE un cap de página real, ignorando perPage pedido. */
  function makeCappedListUsers(allUsers, cap) {
    return vi.fn(async ({ page = 1, perPage = 1000 } = {}) => {
      const effective = Math.min(perPage, cap);
      const start = (page - 1) * effective;
      const slice = allUsers.slice(start, start + effective);
      return { data: { users: slice, total: allUsers.length }, error: null };
    });
  }

  let savedAdminEmails;
  let originalListUsers;

  beforeEach(() => {
    savedAdminEmails = process.env.ADMIN_EMAILS;
    delete process.env.ADMIN_EMAILS;
    authState.userId = 'u-test';
    authState.email = null;
    authState.emailConfirmed = true;
    authState.plan = null;
    authState.users = buildUsers();
    originalListUsers = supabaseAdminMock.auth.admin.listUsers;
    supabaseAdminMock.auth.admin.listUsers = makeCappedListUsers(authState.users, PAGE_CAP);
  });

  afterEach(() => {
    if (savedAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = savedAdminEmails;
    supabaseAdminMock.auth.admin.listUsers = originalListUsers;
  });

  it(`el más antiguo GLOBAL (fuera de la página 1 con un cap de servidor de ${PAGE_CAP}) es admin (200)`, async () => {
    authState.userId = `u-${DEEP_OLDEST_INDEX}`;
    authState.email = `user${DEEP_OLDEST_INDEX}@example.com`;

    const app = await freshApp();
    if (!app) return;
    const res = await safeGet(app, '/api/admin/health', { Authorization: 'Bearer deep-oldest-token' });
    if (!res) return;
    expect(
      res.status,
      `el usuario más antiguo global (índice ${DEEP_OLDEST_INDEX} de ${TOTAL_USERS}, fuera de la página 1 con cap=${PAGE_CAP}) debería ser admin; respondió ${res.status} (body: ${JSON.stringify(res.body)}) — probable bug: deja de paginar tras la primera página`,
    ).toBe(200);
    expectAdminOkShape('/api/admin/health', res.body);
  });

  it('el más antiguo DENTRO de la página 1 (pero no el más antiguo global) NO es admin (403)', async () => {
    authState.userId = `u-${PAGE1_OLDEST_INDEX}`;
    authState.email = `user${PAGE1_OLDEST_INDEX}@example.com`;

    const app = await freshApp();
    if (!app) return;
    const res = await safeGet(app, '/api/admin/health', { Authorization: 'Bearer page1-oldest-token' });
    if (!res) return;
    expect(
      res.status,
      `el usuario más antiguo de la página 1 (índice ${PAGE1_OLDEST_INDEX}) NO es el más antiguo global (ese es el índice ${DEEP_OLDEST_INDEX}); no debería ser admin. Respondió ${res.status} (body: ${JSON.stringify(res.body)})`,
    ).toBe(403);
  });
});

// ── I-D (persistencia, borrado y aviso): una vez resuelto el admin por el
// respaldo del primer usuario registrado, la decisión se persiste (no se
// recalcula en cada request) y queda un aviso para el self-hoster.
describe('I-D — persistencia, borrado y aviso del respaldo por primer usuario', () => {
  let savedAdminEmails;
  beforeEach(() => {
    savedAdminEmails = process.env.ADMIN_EMAILS;
    delete process.env.ADMIN_EMAILS;
    authState.userId = 'u-test';
    authState.email = null;
    authState.emailConfirmed = true;
    authState.plan = null;
    authState.users = [];
  });
  afterEach(() => {
    if (savedAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = savedAdminEmails;
  });

  it(
    [
      'tras resolver admin por el primer usuario registrado, la decisión se persiste',
      '(acepta CUALQUIERA de dos formas: upsert/insert/update en una tabla cuyo',
      'nombre contenga "setting"/"config"/"admin", O auth.admin.updateUserById',
      'con app_metadata.role === "admin" / app_metadata.is_admin en "admin"/true)',
    ].join(' '),
    async () => {
      authState.userId = 'u-first';
      authState.email = 'first@example.com';
      authState.users = [
        { id: 'u-first', email: 'first@example.com', created_at: '2019-01-01T00:00:00Z', email_confirmed_at: '2019-01-02T00:00:00Z' },
        { id: 'u-second', email: 'second@example.com', created_at: '2022-01-01T00:00:00Z', email_confirmed_at: '2022-01-02T00:00:00Z' },
      ];

      const app = await freshApp();
      if (!app) return;

      const res = await safeGet(app, '/api/admin/health', { Authorization: 'Bearer first-token' });
      if (!res) return;
      expect(res.status, 'el primer usuario debe resolver como admin antes de comprobar la persistencia').toBe(200);

      const persistedInTable = persistenceLog.some(
        (entry) => /setting|config|admin/i.test(entry.table) && ['upsert', 'insert', 'update'].includes(entry.method),
      );
      const updateCalls = supabaseAdminMock.auth.admin.updateUserById.mock.calls;
      const persistedViaUpdateUserById = updateCalls.some(([, attrs]) => {
        const meta = attrs?.app_metadata || {};
        return meta.role === 'admin' || meta.is_admin === 'admin' || meta.is_admin === true;
      });

      expect(
        persistedInTable || persistedViaUpdateUserById,
        [
          'tras resolver el admin por el respaldo (primer usuario registrado) se espera que la',
          'decisión se PERSISTA (no se recalcule desde cero en cada request). Este test acepta',
          'CUALQUIERA de estas dos formas:',
          '  1) un upsert/insert/update en una tabla cuyo nombre contenga "setting", "config" o "admin";',
          '  2) auth.admin.updateUserById(userId, { app_metadata: { role: "admin" } }) (o { is_admin: "admin"/true }).',
          `persistenceLog capturado: ${JSON.stringify(persistenceLog)}`,
          `auth.admin.updateUserById.mock.calls: ${JSON.stringify(updateCalls)}`,
        ].join('\n'),
      ).toBe(true);
    },
  );

  it('si el admin persistido desaparece de listUsers, el siguiente más antiguo NO hereda admin automáticamente (403; hace falta ADMIN_EMAILS)', async () => {
    authState.userId = 'u-first';
    authState.email = 'first@example.com';
    authState.users = [
      { id: 'u-first', email: 'first@example.com', created_at: '2019-01-01T00:00:00Z', email_confirmed_at: '2019-01-02T00:00:00Z' },
      { id: 'u-second', email: 'second@example.com', created_at: '2022-01-01T00:00:00Z', email_confirmed_at: '2022-01-02T00:00:00Z' },
    ];

    const app = await freshApp();
    if (!app) return;

    const first = await safeGet(app, '/api/admin/health', { Authorization: 'Bearer first-token' });
    if (!first) return;
    expect(first.status, 'el primer usuario debe resolver como admin antes de simular su borrado').toBe(200);

    // Se borra el admin de listUsers (p.ej. se dio de baja la cuenta), SIN
    // fijar ADMIN_EMAILS: si la resolución se recalculase en cada petición,
    // "el siguiente más antiguo" (u-second) pasaría a ser admin sin que
    // nadie lo haya decidido explícitamente — la carrera que describe I-D.
    authState.users = authState.users.filter((u) => u.id !== 'u-first');
    authState.userId = 'u-second';
    authState.email = 'second@example.com';

    const afterDeletion = await safeGet(app, '/api/admin/health', { Authorization: 'Bearer second-token' });
    if (!afterDeletion) return;
    expect(
      afterDeletion.status,
      `tras borrar al admin persistido, el siguiente más antiguo (second@example.com) respondió ${afterDeletion.status}; se esperaba 403 porque la regla de "primer usuario" no debería recalcularse automáticamente (hace falta fijar ADMIN_EMAILS explícitamente para dar admin a otra persona)`,
    ).toBe(403);
  });

  it('al usar el respaldo del primer usuario se registra un console.warn que menciona ADMIN_EMAILS', async () => {
    authState.userId = 'u-first';
    authState.email = 'first@example.com';
    authState.users = [
      { id: 'u-first', email: 'first@example.com', created_at: '2019-01-01T00:00:00Z', email_confirmed_at: '2019-01-02T00:00:00Z' },
    ];

    const app = await freshApp();
    if (!app) return;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await safeGet(app, '/api/admin/health', { Authorization: 'Bearer first-token' });
      if (!res) return;
      expect(res.status, 'el primer usuario debe resolver como admin para que se dispare el aviso').toBe(200);

      const mentionsAdminEmails = warnSpy.mock.calls.some((args) =>
        args.some((arg) => typeof arg === 'string' && arg.includes('ADMIN_EMAILS')),
      );
      expect(
        mentionsAdminEmails,
        // Nota: este test solo espía console.warn, no un posible logger.warn
        // propio del proyecto — sin un nombre de módulo "logger" conocido en
        // este repo no hay nada concreto que mockear ahí; el enunciado
        // acepta cualquiera de los dos, pero solo se puede comprobar el que
        // es observable desde fuera sin adivinar una ruta de import.
        `se esperaba al menos una llamada a console.warn mencionando "ADMIN_EMAILS" al usar el respaldo del primer usuario; llamadas capturadas: ${JSON.stringify(warnSpy.mock.calls)}`,
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ── GET /api/admin/health SIN ADMIN_EMAILS: cuántas veces se llama a
// auth.admin.listUsers (debería estar acotado/cacheado/persistido, no
// repaginarse en cada request) y qué pasa si esa llamada falla (nunca debe
// filtrar el mensaje de error real al cliente). Se usa /api/admin/health en
// vez de /api/admin/users: el handler de /users llama a listUsers por su
// cuenta para construir el listado, lo que contaminaría tanto el recuento de
// llamadas como el aislamiento del fallo a SOLO la resolución de admin.
//
// Avisamos por delante: estos tests pueden quedar en ROJO tanto en HEAD
// como en el WIP (ver resumen al final del fichero); el objetivo es que
// fallen por ASERCIÓN con un mensaje claro, nunca por timeout ni por un
// import roto.
describe('GET /api/admin/health sin ADMIN_EMAILS — llamadas a listUsers y fuga de error', () => {
  let savedAdminEmails;

  beforeEach(() => {
    savedAdminEmails = process.env.ADMIN_EMAILS;
    authState.userId = 'u-test';
    authState.email = null;
    authState.emailConfirmed = true;
    authState.plan = null;
    authState.users = [];
  });

  afterEach(() => {
    if (savedAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = savedAdminEmails;
  });

  it('(a) 3 peticiones seguidas del primer usuario registrado: tras la primera resolución (que puede paginar), las 2 siguientes hacen CERO llamadas adicionales a listUsers', async () => {
    delete process.env.ADMIN_EMAILS;
    authState.userId = 'u-first';
    authState.email = 'first@example.com';
    authState.users = [
      { id: 'u-first', email: 'first@example.com', created_at: '2019-01-01T00:00:00Z', email_confirmed_at: '2019-01-02T00:00:00Z' },
      { id: 'u-second', email: 'second@example.com', created_at: '2022-01-01T00:00:00Z', email_confirmed_at: '2022-01-02T00:00:00Z' },
    ];

    const app = await freshApp();
    if (!app) return;
    supabaseAdminMock.auth.admin.listUsers.mockClear();

    // La PRIMERA resolución puede llamar a listUsers varias veces
    // (paginación real): no se acota aquí a propósito.
    const res1 = await safeGet(app, '/api/admin/health', { Authorization: 'Bearer first-registered-user-token' });
    if (!res1) return;
    expect(
      res1.status,
      `la primera petición del primer usuario registrado debería resolver admin (200); respondió ${res1.status} (body: ${JSON.stringify(res1.body)})`,
    ).toBe(200);

    const callsAfterFirst = supabaseAdminMock.auth.admin.listUsers.mock.calls.length;

    for (let i = 2; i <= 3; i++) {
      const res = await safeGet(app, '/api/admin/health', { Authorization: 'Bearer first-registered-user-token' });
      if (!res) return;
      expect(res.status, `petición ${i}/3: el primer usuario registrado no debería dejar de ser admin`).toBe(200);

      const callsNow = supabaseAdminMock.auth.admin.listUsers.mock.calls.length;
      expect(
        callsNow - callsAfterFirst,
        `petición ${i}/3 a GET /api/admin/health añadió ${callsNow - callsAfterFirst} llamada(s) a auth.admin.listUsers tras la primera resolución (total acumulado: ${callsNow}); se esperaban CERO llamadas adicionales (la resolución de "primer usuario" debería cachearse/persistirse, no repaginar todos los usuarios en cada request)`,
      ).toBe(0);
    }
  });

  it('(b) listUsers falla (error devuelto O excepción lanzada) con un centinela único → 500 genérico, el centinela NUNCA llega al body', async () => {
    const CENTINELA = 'SENTINEL_LISTUSERS_7f3a';
    const variants = [
      ['listUsers resuelve { error }', async () => ({ data: null, error: new Error(CENTINELA) })],
      ['listUsers lanza', async () => { throw new Error(CENTINELA); }],
    ];

    for (const [label, impl] of variants) {
      delete process.env.ADMIN_EMAILS;
      authState.userId = 'u-any';
      authState.email = 'any@example.com';
      authState.users = [];

      const app = await freshApp();
      if (!app) return;

      const original = supabaseAdminMock.auth.admin.listUsers;
      supabaseAdminMock.auth.admin.listUsers = vi.fn(impl);
      try {
        const res = await safeGet(app, '/api/admin/health', { Authorization: 'Bearer any-token' });
        if (!res) return;

        expect(res.status, `[${label}] status`).toBe(500);
        const bodyStr = JSON.stringify(res.body);
        expect(
          bodyStr,
          `[${label}] el body de un 500 nunca debe incluir el mensaje real del error (filtra detalles internos al cliente): ${bodyStr}`,
        ).not.toContain(CENTINELA);
      } finally {
        supabaseAdminMock.auth.admin.listUsers = original;
      }
    }
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────
 * RESUMEN — contrato por test nuevo/modificado, y qué se espera en HEAD
 * (ee736f43, plan-based) y en el WIP (dev/oss-d4-wip, ADMIN_EMAILS/primer
 * usuario SIN email_confirmed_at/persistencia/cap de paginación real):
 *
 * (a)/(c) reforzados a 200 exacto + forma de body (I-A)
 *   Contrato: un caso "debería ser admin" nunca puede colarse con un 500.
 *   HEAD: ROJO — decide por `plan`, ADMIN_EMAILS no se usa; (a) y (c) dan 403.
 *   WIP:  VERDE — implementa ADMIN_EMAILS y primer-usuario; responde 200 con
 *         la forma de body correcta en ambas rutas.
 *
 * I-B (ADMIN_EMAILS malformada = no definida)
 *   Contrato: '', ' , ', ',' y "sin @" se descartan tras trim+filter; con
 *   cero emails válidos, cae a la regla del primer usuario.
 *   HEAD: ROJO — ignora ADMIN_EMAILS por completo (decide por `plan`).
 *   WIP:  VERDE — su parseo ya hace `.split(',').map(trim).filter(Boolean)`,
 *         así que '', ' , ' y ',' quedan con longitud 0 y caen al primer
 *         usuario correctamente. "not-an-email, also-not-one" es el ÚNICO
 *         sub-caso que el WIP NO cubre: no descarta entradas sin "@", así
 *         que las trataría como ADMIN_EMAILS "definida" con basura dentro,
 *         y ningún usuario la igualaría nunca → 403 para TODOS, incluido el
 *         primer registrado (se esperaba 200). Ese sub-caso queda ROJO en
 *         el WIP tal cual está mostrado.
 *
 * I-C (sin email_confirmed_at, nunca admin)
 *   Contrato: ni ADMIN_EMAILS ni la regla del primer usuario pueden premiar
 *   una cuenta sin confirmar; el primer VERIFICADO es el admin de respaldo.
 *   HEAD: ROJO — no existe el concepto en absoluto.
 *   WIP:  ROJO — no lee `email_confirmed_at` en ningún sitio (ni del
 *         usuario autenticado vía getUser, ni al recorrer `listUsers` para
 *         elegir "first"); un email de ADMIN_EMAILS sin confirmar entraría
 *         igualmente, y el primer registrado sin confirmar ganaría sobre el
 *         primer VERIFICADO. PENDIENTE de implementar, como anota la
 *         revisión.
 *
 * I-D (paginación real, perPage pequeño forzado por el "servidor")
 *   Contrato: con un cap de página real, el código debe seguir paginando
 *   hasta agotar los usuarios, no asumir que la primera tanda es todo.
 *   HEAD: ROJO — no pagina en absoluto (decide por `plan`).
 *   WIP:  ROJO — su bucle corta con `if (chunk.length < 1000) break` usando
 *         el `perPage` que ÉL PIDE (1000), no el que el mock realmente
 *         devuelve (capado a 8); como el primer `chunk.length` (8) ya es
 *         menor que 1000, se detiene tras la página 1 SIEMPRE. El caso
 *         "más antiguo global fuera de página 1" (200 esperado) sale 403
 *         en el WIP; el caso "más antiguo de página 1, no global" (403
 *         esperado) sale 200 — exactamente el bug que describe el hallazgo
 *         I-D de /tmp/oss-d8-review.md.
 *
 * I-D (persistencia tras resolver por respaldo)
 *   Contrato: la resolución de "primer usuario" se escribe en algún sitio
 *   persistente (tabla settings/config/admin, o auth.admin.updateUserById
 *   con app_metadata admin) — se documenta que el test acepta CUALQUIERA de
 *   las dos formas.
 *   HEAD: ROJO — no hay resolución que persistir.
 *   WIP:  ROJO — recalcula todo en cada request con `listUsers` y no
 *         escribe en ninguna tabla nueva ni llama a `updateUserById`;
 *         `persistenceLog` queda vacío y `updateUserById.mock.calls` también.
 *
 * I-D (borrado del admin persistido)
 *   Contrato: si el admin desaparece de listUsers, el siguiente más antiguo
 *   NO hereda admin automáticamente sin ADMIN_EMAILS explícito.
 *   HEAD: ROJO — primera petición (resolver admin) ya da 403 porque HEAD no
 *         implementa esta regla; el test corta ahí.
 *   WIP:  ROJO, pero por el motivo OPUESTO al deseado: como el WIP SÍ
 *         recalcula "first" en cada request (no persiste), tras borrar a
 *         u-first, u-second SÍ pasa a ser el nuevo "first" por created_at y
 *         obtiene 200 — justo la carrera que I-D quiere prohibir.
 *
 * I-D (aviso console.warn con ADMIN_EMAILS)
 *   Contrato: usar el respaldo del primer usuario deja constancia por log.
 *   HEAD: ROJO — nunca llega a esa rama.
 *   WIP:  ROJO — no hay ningún console.warn ni log equivalente en esa rama
 *         del código mostrado.
 *
 * GET /api/admin/health sin ADMIN_EMAILS — (a) 0 llamadas adicionales tras
 * la primera resolución
 *   Contrato: cachear/persistir "quién es el primer usuario" entre
 *   requests, no repaginar todos los usuarios en cada petición.
 *   HEAD: ROJO — primera petición ya da 403 (no implementa la regla); el
 *         test corta ahí antes de medir llamadas.
 *   WIP:  ROJO — cada request vuelve a llamar a `listUsers` desde cero (sin
 *         caché ni persistencia); las peticiones 2 y 3 añaden llamadas
 *         nuevas en vez de cero.
 *
 * GET /api/admin/health sin ADMIN_EMAILS — (b) fuga de error de listUsers
 *   Contrato: un fallo de `listUsers` (error devuelto o excepción) nunca
 *   debe filtrar su mensaje real en un 500 al cliente.
 *   HEAD: ROJO — primera petición ya da 403, nunca llega a llamar listUsers
 *         (decide por `plan`); el test corta ahí sin ver un 500.
 *   WIP:  ROJO en AMBAS variantes. `if (error) throw error;` hace que la
 *         variante "error devuelto" caiga en el mismo `catch (listErr)` que
 *         la variante "lanza", y ese catch responde `{ error: 'Could not
 *         resolve admin user', detail: listErr.message }` — `detail` ES el
 *         mensaje real/centinela, justo la fuga que el test prohíbe. El
 *         status 500 es correcto; el body no lo es. No es obvio a primera
 *         vista del código del WIP, se deja documentado aquí.
 * ─────────────────────────────────────────────────────────────────────────
 */


// D4 review C-1 / I-1 / I-2 / I-6. Only synthetic identities and secrets.
describe('D4 review — omitted verification, persisted-read failures, bounded resolution, hermetic env', () => {
  const CURRENT = { id: 'review-current', email: 'owner@example.com',
    created_at: '2020-01-01T00:00:00Z', email_confirmed_at: '2020-01-02T00:00:00Z' };
  const OMITTED = { id: 'review-unverified', email: 'unverified@example.com', created_at: '2010-01-01T00:00:00Z' };
  const SENTINEL = 'TDD-SYNTHETIC-ADMIN-RESOLUTION-ERROR';
  let savedEnv; let originalFrom; let originalListUsers;
  beforeEach(() => {
    savedEnv = Object.fromEntries(['ADMIN_EMAILS', 'NODE_ENV', 'TRAZZA_TDD_ENV_SENTINEL'].map((key) => [key, process.env[key]]));
    delete process.env.ADMIN_EMAILS;
    process.env.NODE_ENV = 'test';
    authState.userId = CURRENT.id; authState.email = CURRENT.email;
    authState.emailConfirmed = true; authState.omitEmailConfirmed = false;
    authState.users = [CURRENT]; authState.plan = null;
    envProbe.calls.length = 0; envProbe.inject = false;
    originalFrom = supabaseAdminMock.from;
    originalListUsers = supabaseAdminMock.auth.admin.listUsers;
    supabaseAdminMock.auth.admin.listUsers = vi.fn(async ({ page = 1, perPage = 200 } = {}) => ({
      data: { users: authState.users.slice((page - 1) * perPage, page * perPage) }, error: null,
    }));
  });
  afterEach(() => {
    vi.useRealTimers();
    supabaseAdminMock.from = originalFrom;
    supabaseAdminMock.auth.admin.listUsers = originalListUsers;
    envProbe.inject = false;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  async function health(app) {
    return safeGet(app, '/api/admin/health', { Authorization: 'Bearer synthetic-review-token' });
  }
  function fakeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
  }
  function guardRequest() { return { headers: { authorization: 'Bearer synthetic-review-token' } }; }

  it('C-1: email_confirmed_at AUSENTE nunca concede admin por ADMIN_EMAILS', async () => {
    process.env.ADMIN_EMAILS = CURRENT.email;
    authState.omitEmailConfirmed = true;
    const auth = await supabaseAdminMock.auth.getUser('synthetic');
    expect(auth.data.user).not.toHaveProperty('email_confirmed_at');
    const response = await health(await freshApp());
    expect(response.status).toBe(403);
    expect(persistenceLog).toEqual([]);
  });
  it('C-1: primer usuario con clave AUSENTE no es admin ni se persiste', async () => {
    authState.omitEmailConfirmed = true;
    const { email_confirmed_at: ignored, ...withoutKey } = CURRENT;
    authState.users = [withoutKey];
    expect(authState.users[0]).not.toHaveProperty('email_confirmed_at');
    const response = await health(await freshApp());
    expect.soft(response.status).toBe(403);
    expect(persistenceLog, 'no debe guardar un primer usuario no verificado').toEqual([]);
  });
  it('C-1: listUsers ignora al más antiguo con clave AUSENTE y elige al verificado', async () => {
    authState.users = [OMITTED, CURRENT];
    expect(OMITTED).not.toHaveProperty('email_confirmed_at');
    const response = await health(await freshApp());
    expect.soft(response.status).toBe(200);
    expect(JSON.stringify(persistenceLog)).not.toContain(OMITTED.id);
  });
  it('C-1: candidato sin clave no se guarda aunque el solicitante verificado sea otro', async () => {
    authState.users = [OMITTED];
    const response = await health(await freshApp());
    expect(response.status).toBe(403);
    expect(persistenceLog, 'no debe reservar para siempre admin a un candidato omitempty').toEqual([]);
  });

  for (const mode of ['error', 'throw']) {
    it(`I-1: lectura persistida con ${mode} devuelve 500 genérico sin sobrescribir ni recalcular`, async () => {
      let stored = { user_id: 'persisted-deleted-owner' };
      const before = { ...stored };
      const writes = vi.fn((payload) => { stored = payload.value; return api; });
      const api = {
        select() { return api; }, eq() { return api; },
        maybeSingle: async () => {
          if (mode === 'throw') throw new Error(SENTINEL);
          return { data: null, error: new Error(SENTINEL) };
        },
        upsert: writes, insert: writes, update: writes,
        then(resolve, reject) { return Promise.resolve({ data: null, error: null }).then(resolve, reject); },
      };
      supabaseAdminMock.from = (table) => table === 'server_app_config' ? api : originalFrom(table);
      const response = await health(await freshApp());
      expect.soft(response.status, 'review I-1 exige lanzar error, no recalcular').toBe(500);
      expect.soft(response.body).toEqual({ error: 'Internal server error' });
      expect.soft(JSON.stringify(response.body)).not.toContain(SENTINEL);
      expect.soft(writes, 'la fila preexistente nunca se sobrescribe').not.toHaveBeenCalled();
      expect.soft(stored).toEqual(before);
      expect(supabaseAdminMock.auth.admin.listUsers, 'no recalcular ante lectura fallida').not.toHaveBeenCalled();
    });
  }

  it('I-2: listUsers que no responde termina requireAdmin en <=5.5s con 500 genérico', async () => {
    vi.resetModules();
    const { requireAdmin } = await import('../lib/requireAdmin.js');
    supabaseAdminMock.auth.admin.listUsers = vi.fn(() => new Promise(() => {}));
    vi.useFakeTimers();
    const res = fakeRes(); let finished = false;
    // No socket real ni timeout de Vitest: reloj virtual, petición al guard real.
    void requireAdmin(guardRequest(), res, supabaseAdminMock).then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(5500);
    expect.soft(finished, 'falta timeout de resolución (~5s según review)').toBe(true);
    expect.soft(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
  for (const mode of ['error', 'throw']) {
    it(`I-2: fallo listUsers ${mode} se cachea negativamente: dos peticiones posteriores no repaginan`, async () => {
      vi.resetModules();
      const { requireAdmin } = await import('../lib/requireAdmin.js');
      const list = vi.fn(async () => {
        if (mode === 'throw') throw new Error(SENTINEL);
        return { data: null, error: new Error(SENTINEL) };
      });
      supabaseAdminMock.auth.admin.listUsers = list;
      for (let index = 0; index < 3; index += 1) {
        const res = fakeRes();
        await requireAdmin(guardRequest(), res, supabaseAdminMock);
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: 'Internal server error' });
        expect(JSON.stringify(res.body)).not.toContain(SENTINEL);
      }
      expect(list, 'tres peticiones inmediatas deben compartir un fallo cacheado/backoff, no tres paginaciones').toHaveBeenCalledTimes(1);
      expect(persistenceLog).toEqual([]);
    });
  }
  it('I-6: importar createApp en test no llama dotenv ni carga el centinela del .env simulado', async () => {
    // loadEnv usa rutas relativas a import.meta.url, NO cwd: una trampa cwd no
    // probaría nada. dotenv.config está simulado para ambas rutas, sin leerlas.
    delete process.env.TRAZZA_TDD_ENV_SENTINEL;
    envProbe.inject = true;
    await freshApp();
    expect.soft(envProbe.calls, 'loadEnv debe estar solo en index.js, no en app.js').toEqual([]);
    expect(process.env.TRAZZA_TDD_ENV_SENTINEL).toBeUndefined();
  });
});
