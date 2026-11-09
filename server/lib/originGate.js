/**
 * Corta peticiones con Origin no permitido (403), incluido el preflight OPTIONS.
 * El paquete `cors` con cb(null, false) deja pasar a la ruta sin ACAO — no es un 403.
 */

export function isOriginAllowed(origin, { allowed = [], dev = [], isProd = false } = {}) {
  if (!origin) return !isProd;
  return dev.includes(origin) || allowed.includes(origin);
}

/**
 * @param {{ allowedOrigins: string[], devOrigins?: string[], isProd?: boolean }} opts
 */
export function originGate({
  allowedOrigins,
  devOrigins = [],
  isProd = process.env.NODE_ENV === 'production',
}) {
  return function originGateMiddleware(req, res, next) {
    const origin = req.headers.origin;
    if (
      origin
      && !isOriginAllowed(origin, { allowed: allowedOrigins, dev: devOrigins, isProd })
    ) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    return next();
  };
}
