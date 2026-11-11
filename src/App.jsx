import React, { Suspense, lazy } from 'react';
import { BrowserRouter as Router, Routes, Route, matchPath, Navigate } from 'react-router-dom';
import { lazyPage } from '@/lib/lazyPage';
import { appRedirectRoutes } from '@/lib/appRedirects';
import LanguageRouteSync from '@/components/LanguageRouteSync';
import AppTranslationsGate from '@/components/AppTranslationsGate';
import { Helmet } from 'react-helmet';
import { useTranslation } from 'react-i18next';
import { SupabaseAuthProvider } from '@/contexts/SupabaseAuthContext';
import { UserPreferencesProvider } from '@/contexts/UserPreferencesContext';
import { Toaster } from '@/components/ui/toaster';
import ProtectedRoute from '@/components/ProtectedRoute';
import CookieConsent from '@/components/CookieConsent';
import { ErrorBoundary } from '@/components/ErrorBoundary';

const AuthPage             = lazyPage(() => import('@/pages/AuthPage'));
const ContactPage          = lazyPage(() => import('@/pages/ContactPage'));
const CompoundInterestPage = lazyPage(() => import('@/pages/CompoundInterestPage'));
const DividendCalculatorPage = lazyPage(() => import('@/pages/DividendCalculatorPage'));
const FireCalculatorPage = lazyPage(() => import('@/pages/FireCalculatorPage'));
const BrokerGuidesPage = lazyPage(() => import('@/pages/BrokerGuidesPage'));
const CapitalGainsCalculatorPage = lazyPage(() => import('@/pages/CapitalGainsCalculatorPage'));
const BrokerTaxCalculatorPage = lazyPage(() => import('@/pages/BrokerTaxCalculatorPage'));
const BrokerGuidePage = lazyPage(() => import('@/pages/BrokerGuidePage'));
const SharedPortfolioPage  = lazyPage(() => import('@/pages/SharedPortfolioPage'));
const NotFoundPage         = lazyPage(() => import('@/pages/NotFoundPage'));

function HomeEntry() {
  return <Navigate to="/auth" replace />;
}

// Rutas públicas OSS: sin landing, blog ni legales; la raíz abre el acceso.
const PUBLIC_ROUTES = [
  { path: '/auth', Page: AuthPage },
  { path: '/contact', Page: ContactPage },
  { path: '/calculadora-interes-compuesto', Page: CompoundInterestPage },
  { path: '/calculadora-dividendos', Page: DividendCalculatorPage },
  { path: '/calculadora-fire', Page: FireCalculatorPage },
  { path: '/calculadora-plusvalias', Page: CapitalGainsCalculatorPage },
  { path: '/calculadora-renta-broker', Page: BrokerTaxCalculatorPage },
  { path: '/guias', Page: BrokerGuidesPage },
  { path: '/guias/:slug', Page: BrokerGuidePage },
  { path: '/share/:token', Page: SharedPortfolioPage, boundary: true },
];
const APP_PREFIX = '/app';

/** Página pública que pinta el router para `pathname` (null = la app privada). */
export function matchPublicRoute(pathname) {
  if (pathname === '/' || pathname === APP_PREFIX || pathname.startsWith(`${APP_PREFIX}/`)) {
    if (pathname === '/') return { Page: AuthPage };
    return null;
  }
  const hit = PUBLIC_ROUTES.find((r) => matchPath(r.path, pathname));
  return { Page: hit ? hit.Page : NotFoundPage };
}

/** Descarga el chunk de la página de `pathname` (sin esperar a que React la pida). */
export function preloadRoute(pathname) {
  const hit = matchPublicRoute(pathname);
  return hit?.Page?.preload ? hit.Page.preload() : Promise.resolve();
}

const DashboardLayout      = lazy(() => import('@/components/DashboardLayout'));
const Dashboard            = lazy(() => import('@/pages/Dashboard'));
const CarteraPage          = lazy(() => import('@/pages/CarteraPage'));
const FavoritesPage        = lazy(() => import('@/pages/FavoritesPage'));
const NotificationsPage    = lazy(() => import('@/pages/NotificationsPage'));
const RebalancingCalculator= lazy(() => import('@/pages/RebalancingCalculator'));
const BacktestPage         = lazy(() => import('@/pages/BacktestPage'));
const SettingsPage         = lazy(() => import('@/pages/SettingsPage'));
const AdminDashboard       = lazy(() => import('@/pages/AdminDashboard'));
const ExpensesPage         = lazy(() => import('@/pages/ExpensesPage'));

function RouteFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950">
      <div
        role="status"
        aria-label="…"
        className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"
      />
    </div>
  );
}

/**
 * Las <Route> que App monta dentro de <Routes>, tal cual. Exportadas para que
 * los tests comprueben el árbol REAL (redirecciones de /app, 404…) y no una copia.
 */
export function appRouteElements() {
  return (
    <>
      <Route path="/" element={<HomeEntry />} />
      {PUBLIC_ROUTES.map(({ path, Page, boundary }) => (
        <Route key={path} path={path} element={boundary ? <ErrorBoundary><Page /></ErrorBoundary> : <Page />} />
      ))}

      <Route path="/app" element={<ProtectedRoute><AppTranslationsGate><DashboardLayout /></AppTranslationsGate></ProtectedRoute>}>
        <Route index element={<Dashboard />} />
        <Route path="brokers" element={<CarteraPage />} />
        <Route path="favorites" element={<ErrorBoundary><FavoritesPage /></ErrorBoundary>} />
        <Route path="notificaciones" element={<ErrorBoundary><NotificationsPage /></ErrorBoundary>} />
        <Route path="rebalance" element={<ErrorBoundary><RebalancingCalculator /></ErrorBoundary>} />
        <Route path="backtest" element={<BacktestPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="admin" element={<ErrorBoundary title="Admin"><AdminDashboard /></ErrorBoundary>} />
        <Route path="gastos" element={<ErrorBoundary><ExpensesPage /></ErrorBoundary>} />
        {appRedirectRoutes()}
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </>
  );
}

function App() {
  const { t } = useTranslation();
  return (
    <SupabaseAuthProvider>
    <UserPreferencesProvider>
      <Helmet>
        <title>{t('app.title')}</title>
        <meta name="description" content={t('app.description')} />
      </Helmet>
      <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <LanguageRouteSync />
        <Suspense fallback={<RouteFallback />}>
          <Routes>{appRouteElements()}</Routes>
        </Suspense>
      </Router>
      <Toaster />
      <CookieConsent />
    </UserPreferencesProvider>
    </SupabaseAuthProvider>
  );
}

export default App;
