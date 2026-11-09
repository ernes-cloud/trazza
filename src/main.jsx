import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/index.css';
import { i18nReady } from '@/i18n';
import { installGlobalErrorHandlers } from '@/lib/errorTelemetry';
import { prerenderBootMode } from '@/lib/prerender';
import { markBootedFromPrerender, isPrerendering } from '@/lib/prerenderBoot';

const appModule = import('@/App');

const { pathname: bootPath } = window.location;
if (
  bootPath === '/'
  || bootPath === '/app'
  || bootPath.startsWith('/app/')
  || bootPath === '/auth'
) {
  void import('@supabase/supabase-js').catch(() => {});
}

if (!isPrerendering()) {
  installGlobalErrorHandlers();
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const rootEl = document.getElementById('root');
const { pathname } = window.location;
const bootMode = prerenderBootMode({ prerenderPath: rootEl.dataset.prerenderPath, pathname });
let routeReady = Promise.resolve();
if (bootMode === 'reuse') {
  markBootedFromPrerender();
  routeReady = appModule
    .then((m) => m.preloadRoute(pathname))
    .catch((e) => console.warn('[prerender] no se pudo precargar la ruta', e));
} else if (bootMode === 'discard') {
  rootEl.replaceChildren();
}

Promise.all([i18nReady, routeReady, appModule]).then(([, , mod]) => {
  const App = mod.default;
  ReactDOM.createRoot(rootEl).render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
});
