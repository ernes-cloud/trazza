import React, { Suspense } from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { Navigate, Route, Outlet, createRoutesFromChildren, matchRoutes } from 'react-router-dom';
import { APP_REDIRECTS, appRedirectRoutes } from './appRedirects';

vi.mock('@/lib/customSupabaseClient', () => ({
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: null } })) } },
}));

// Se comprueba el árbol de rutas REAL de App.jsx (`appRouteElements()`, lo
// mismo que App mete dentro de <Routes>): si se quita `{appRedirectRoutes()}`
// de App.jsx, /app/cartera cae en la 404 y esto falla. Sin DOM, <Navigate> no
// navega (lo hace en un efecto): se mira qué elemento pinta el router.
//
// El import de @/App arrastra toda la app (1,5–3,4 s medidos): UNA vez, con
// timeout explícito, y los `it` sin imports.
let routes;
let ProtectedRoute;
beforeAll(async () => {
  const { appRouteElements } = await import('@/App');
  ({ default: ProtectedRoute } = await import('@/components/ProtectedRoute'));
  routes = createRoutesFromChildren(appRouteElements());
}, 30_000);

const nonEmpty = (children) => (Array.isArray(children) ? children : [children])
  .filter((c) => c !== null && c !== undefined && typeof c !== 'boolean' && !(typeof c === 'string' && !c.trim()));

/**
 * ¿Cuelga TODO el elemento de un `type` que lo envuelve? Es decir: `type` es un
 * ANCESTRO con hijos de todo lo que pinta la ruta (layout u Outlet), no un hermano.
 * Cada rama, desde la raíz, tiene que pasar por un `type` con children antes de llegar
 * a una hoja; los envoltorios neutros (<Suspense>, fragmentos…) se atraviesan por sus
 * children (el `fallback` es una prop, no cuenta). Así `<><Protected /><Layout /></>`
 * no protege nada, y `<Suspense><Protected><Layout /></Protected></Suspense>` sí.
 */
function wrappedBy(element, type) {
  const kids = nonEmpty(element);
  if (!kids.length) return false;
  return kids.every((e) => {
    if (!e || typeof e !== 'object') return false; // texto o similar fuera del guard
    if (e.type === type) return nonEmpty(e.props?.children).length > 0;
    return wrappedBy(e.props?.children, type);
  });
}

/**
 * Alguna ruta de la cadena de matches es path="/app" y el elemento de alguna de ellas
 * cuelga entero de ProtectedRoute (ver wrappedBy). No depende de que ProtectedRoute sea
 * el elemento RAÍZ de la ruta "/app": sigue valiendo si pasa a un layout sin path por
 * encima, si va envuelto en <Suspense> o si hay un <Route> sin path dentro de /app.
 */
function underProtectedApp(matches, Protected) {
  return {
    app: matches.some((m) => m.route.path === '/app'),
    protected: matches.some((m) => wrappedBy(m.route.element, Protected)),
  };
}
function expectUnderProtectedApp(matches, label) {
  const r = underProtectedApp(matches, ProtectedRoute);
  expect(r.app, `${label} no cuelga de /app`).toBe(true);
  expect(r.protected, `${label} no pasa por ProtectedRoute`).toBe(true);
}

describe('underProtectedApp (el comprobador, con árboles sintéticos)', () => {
  const Guard = ({ children }) => children;
  const Layout = () => <Outlet />;
  const check = (tree, pathname) => underProtectedApp(matchRoutes(createRoutesFromChildren(tree), pathname), Guard);

  it('ProtectedRoute como elemento de /app', () => {
    expect(check(<Route path="/app" element={<Guard><Layout /></Guard>}>{appRedirectRoutes()}</Route>, '/app/cartera'))
      .toEqual({ app: true, protected: true });
  });
  it('ProtectedRoute en un layout SIN path por encima de /app', () => {
    const tree = <Route element={<Guard><Outlet /></Guard>}><Route path="/app" element={<Layout />}>{appRedirectRoutes()}</Route></Route>;
    expect(check(tree, '/app/cartera')).toEqual({ app: true, protected: true });
  });
  it('ProtectedRoute envuelto en <Suspense>', () => {
    const tree = <Route path="/app" element={<Suspense fallback={null}><Guard><Layout /></Guard></Suspense>}>{appRedirectRoutes()}</Route>;
    expect(check(tree, '/app/cartera')).toEqual({ app: true, protected: true });
  });
  it('<Route> sin path con el layout DENTRO de /app (ProtectedRoute sigue en /app)', () => {
    const tree = <Route path="/app" element={<Guard><Outlet /></Guard>}><Route element={<Layout />}>{appRedirectRoutes()}</Route></Route>;
    expect(check(tree, '/app/cartera')).toEqual({ app: true, protected: true });
  });
  it('engaños: ProtectedRoute que NO envuelve el layout no cuenta', () => {
    const sibling = <Route path="/app" element={<><Guard /><Layout /></>}>{appRedirectRoutes()}</Route>;
    expect(check(sibling, '/app/cartera').protected).toBe(false);
    const halfWrapped = <Route path="/app" element={<><Guard><span /></Guard><Layout /></>}>{appRedirectRoutes()}</Route>;
    expect(check(halfWrapped, '/app/cartera').protected).toBe(false);
    const empty = <Route path="/app" element={<Guard />}>{appRedirectRoutes()}</Route>;
    expect(check(empty, '/app/cartera').protected).toBe(false);
    const inFallback = <Route path="/app" element={<Suspense fallback={<Guard><Layout /></Guard>}><Layout /></Suspense>}>{appRedirectRoutes()}</Route>;
    expect(check(inFallback, '/app/cartera').protected).toBe(false);
  });
  it('control: sin ProtectedRoute, o redirección de primer nivel fuera de /app', () => {
    expect(check(<Route path="/app" element={<Layout />}>{appRedirectRoutes()}</Route>, '/app/cartera').protected).toBe(false);
    expect(check(<Route path="/app/cartera" element={<Navigate to="/app/brokers" replace />} />, '/app/cartera'))
      .toEqual({ app: false, protected: false });
  });
});

/**
 * TODAS las rutas que se pueden pintar bajo /app en un árbol: cada ruta con element
 * (o index) cuyo path completo es `/app` o empieza por `/app/`, con el pathname con el
 * que se llega a ella (`:param` → un valor, `*` → un segmento, `?` opcional → presente).
 * Las rutas sin path (layouts) no son destino propio: se atraviesan. Una ruta con path e
 * hijos solo es destino propio si ninguno de sus hijos (atravesando los sin path) es
 * `index`: si lo hay, a su URL se llega por ese index.
 */
function appPaths(routeList) {
  const hasIndexChild = (r) => (r.children || []).some((c) => c.index || (c.path === undefined && hasIndexChild(c)));
  const concrete = (p) => p.split('/').map((s) => {
    if (s === '*') return 'algo';
    const seg = s.replace(/\?$/, '');
    return seg.startsWith(':') ? 'x1' : seg;
  }).join('/');
  const join = (base, p) => {
    if (p === undefined) return base;
    if (p.startsWith('/')) return p;
    return `${base.replace(/\/$/, '')}/${p}`;
  };
  const out = [];
  const walk = (list, base) => {
    for (const r of list) {
      const full = join(base, r.path);
      const destination = r.index || (r.path !== undefined && !hasIndexChild(r));
      if (destination && (full === '/app' || full.startsWith('/app/'))) {
        out.push({ pathname: concrete(full), route: r });
      }
      if (r.children) walk(r.children, full);
    }
  };
  walk(routeList, '/');
  return out;
}

describe('todas las rutas de /app pasan por ProtectedRoute', () => {
  // 5.ª revisión, hallazgo 4 (mutación E7): /app con DashboardLayout SIN guard, index,
  // settings y admin colgando de él, y el guard solo en un <Route> sin path alrededor de
  // brokers, favorites y las redirecciones. Comprobando solo esas 4 rutas, el test
  // seguía verde con /app, /app/settings y /app/admin sin ProtectedRoute.
  it('el recorrido ve E7 en un árbol sintético (control)', () => {
    const Guard = ({ children }) => children;
    const Layout = () => <Outlet />;
    const P = () => null;
    const e7 = createRoutesFromChildren(
      <Route path="/app" element={<Layout />}>
        <Route index element={<P />} />
        <Route path="settings" element={<P />} />
        <Route path="admin" element={<P />} />
        <Route element={<Guard><Outlet /></Guard>}>
          <Route path="brokers" element={<P />} />
          <Route path="favorites" element={<P />} />
          {appRedirectRoutes()}
        </Route>
      </Route>,
    );
    const unprotected = appPaths(e7)
      .filter(({ pathname }) => !underProtectedApp(matchRoutes(e7, pathname), Guard).protected)
      .map((x) => x.pathname);
    expect(unprotected.sort()).toEqual(['/app', '/app/admin', '/app/settings']);
  });

  it('appPaths: :param, * y rutas absolutas dentro de /app', () => {
    const P = () => null;
    const tree = createRoutesFromChildren(
      <Route path="/app" element={<P />}>
        <Route path="post/:id" element={<P />} />
        <Route path="files/*" element={<P />} />
        <Route path="/app/abs" element={<P />} />
      </Route>,
    );
    expect(appPaths(tree).map((x) => x.pathname)).toEqual(['/app', '/app/post/x1', '/app/files/algo', '/app/abs']);
  });

  it('en el árbol REAL de App, cada ruta bajo /app (index incluido) resuelve a sí misma y cuelga de ProtectedRoute', () => {
    const all = appPaths(routes);
    const names = all.map((x) => x.pathname);
    // Que el recorrido no sea vacío: las de hoy tienen que estar.
    for (const p of ['/app', '/app/brokers', '/app/favorites', '/app/settings', '/app/admin', '/app/cartera', '/app/favoritos']) {
      expect(names, p).toContain(p);
    }
    for (const { pathname, route } of all) {
      const matches = matchRoutes(routes, pathname);
      expect(matches, `${pathname} no casa con ninguna ruta`).toBeTruthy();
      expect(matches[matches.length - 1].route, `${pathname} cae en otra ruta`).toBe(route);
      expectUnderProtectedApp(matches, pathname);
    }
  });
});

function leaf(pathname) {
  const matches = matchRoutes(routes, pathname);
  return matches ? matches[matches.length - 1].route : null;
}

describe('redirecciones de rutas antiguas de /app', () => {
  it('declara cartera → brokers y favoritos → favorites', () => {
    expect(APP_REDIRECTS).toEqual([
      { from: 'cartera', to: '/app/brokers' },
      { from: 'favoritos', to: '/app/favorites' },
    ]);
  });

  it.each([
    ['/app/cartera', '/app/brokers'],
    ['/app/favoritos', '/app/favorites'],
  ])('en el árbol de App, %s → <Navigate replace to="%s">', (from, to) => {
    const route = leaf(from);
    expect(route, `${from} no casa con ninguna ruta`).toBeTruthy();
    // Una <Route path="/app/cartera"> de primer nivel también llegaría al Navigate,
    // pero fuera de /app (sin ProtectedRoute ni DashboardLayout).
    expectUnderProtectedApp(matchRoutes(routes, from), from);
    expect(route.path, `${from} cae en la 404`).not.toBe('*');
    expect(route.element?.type).toBe(Navigate);
    expect(route.element.props.to).toBe(to);
    expect(route.element.props.replace).toBe(true);
  });

  it('el destino casa con una ruta real de /app que no es la 404 ni redirige otra vez', () => {
    for (const { to } of APP_REDIRECTS) {
      const matches = matchRoutes(routes, to);
      expect(matches, to).toBeTruthy();
      expectUnderProtectedApp(matches, to);
      const route = matches[matches.length - 1].route;
      expect(route.path, to).not.toBe('*');
      expect(route.element?.type, to).not.toBe(Navigate);
    }
  });
});
