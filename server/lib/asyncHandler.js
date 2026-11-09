/**
 * Wraps an async Express handler so rejections become a safe 500 JSON
 * (or next(err) if headers were already sent) instead of unhandledRejection.
 *
 * Marked for the asyncHandler.guard contract (__asyncHandler).
 *
 * Nota N1v2: la forma ideal `Promise.resolve(fn(...)).catch(next)` deja a Express
 * responder HTML en rutas montadas DESPUÉS del errorHandler (caso del test TDD
 * que añade `/__test/async-reject` tras createApp). Por eso respondemos aquí el
 * 500 genérico; el errorHandler central de app.js cubre body-parser / next(err)
 * de middleware síncrono (4xx tipados, CORS, etc.).
 */
export function asyncHandler(fn) {
  function asyncHandlerWrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      if (res.headersSent) return next(err);
      console.error('[trazza-server] Unhandled error:', err?.message, err?.stack);
      res.status(500).json({ error: 'Internal server error' });
    });
  }
  asyncHandlerWrapped.__asyncHandler = true;
  asyncHandlerWrapped.__wrapped = fn;
  return asyncHandlerWrapped;
}
