import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import i18n from '@/i18n';
import { reportClientError } from '@/lib/errorTelemetry';

/**
 * Catches render errors in child components and shows a recovery UI
 * instead of crashing the whole page.
 *
 * Usage:
 *   <ErrorBoundary>
 *     <SomeAnalyticsWidget />
 *   </ErrorBoundary>
 *
 *   <ErrorBoundary fallback={<p>Custom error message</p>}>
 *     ...
 *   </ErrorBoundary>
 */
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('ErrorBoundary caught an error:', error, info.componentStack);
    // Este boundary envuelve TODOS los widgets de analítica, así que es el
    // sitio con más probabilidad de capturar un fallo de render real. El
    // reporte es fire-and-forget: si falla, el usuario sigue viendo la UI de
    // recuperación igual.
    reportClientError({ kind: 'render', error, componentStack: info?.componentStack });
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="flex flex-col items-center justify-center gap-4 p-10 rounded-xl border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/10 text-center">
          <AlertTriangle className="w-10 h-10 text-red-400" />
          <div>
            <p className="font-bold text-red-600 dark:text-red-400">
              {this.props.title || i18n.t('common.widget_error')}
            </p>
            {this.state.error?.message && (
              <p className="text-xs text-red-400 dark:text-red-500 mt-1 font-mono">
                {this.state.error.message}
              </p>
            )}
          </div>
          <button
            onClick={this.handleRetry}
            className="flex items-center gap-2 px-4 py-2 bg-white dark:bg-slate-800 border border-red-200 dark:border-red-800 rounded-lg text-sm font-bold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
          >
            <RefreshCw className="w-4 h-4" /> {i18n.t('common.retry')}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
