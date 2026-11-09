import React from 'react';
import { Route, Navigate } from 'react-router-dom';

/**
 * Rutas antiguas de /app que siguen circulando (enlaces guardados, correos,
 * marcadores): la página de brokers se llama `brokers`, no `cartera`, y la de
 * favoritos `favorites`, no `favoritos`. Relativas a /app.
 */
export const APP_REDIRECTS = [
  { from: 'cartera', to: '/app/brokers' },
  { from: 'favoritos', to: '/app/favorites' },
];

/** Las <Route> de redirección, para meterlas dentro de <Route path="/app"> en App.jsx. */
export function appRedirectRoutes() {
  return APP_REDIRECTS.map(({ from, to }) => (
    <Route key={from} path={from} element={<Navigate to={to} replace />} />
  ));
}
