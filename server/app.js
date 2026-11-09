/**
 * Express app factory — builds middleware + routes WITHOUT listen/crons.
 * Entry point (index.js) calls createApp() then listen + schedule crons.
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { validateImport } from './routes/validateImport.js';
import { portfolioChat } from './routes/portfolioChat.js';
import { analyzeCsv } from './routes/analyzeCsv.js';
import { parseFreeform } from './routes/parseFreeform.js';
import { scorePortfolio } from './routes/scorePortfolio.js';
import { analyzeEarnings } from './routes/analyzeEarnings.js';
import { adminHealth } from './routes/adminHealth.js';
import { adminParserCandidates } from './routes/adminParserCandidates.js';
import { adminListUsers } from './routes/adminUsers.js';
import { withRateLimit } from './routes/rateLimiter.js';
import { emailNotify } from './routes/emailNotify.js';
import { logImport } from './routes/logImport.js';
import { logError } from './routes/logError.js';
import { contactForm } from './routes/contactForm.js';
import { tickerMappings } from './routes/tickerMappings.js';
import { createAssets } from './routes/createAssets.js';
import { getShare } from './routes/sharePortfolio.js';
import { sharePage } from './routes/sharePage.js';
import { registerMarketProxies } from './routes/marketProxy.js';
import { marketCalendarHandler } from './routes/marketCalendar.js';
import { adminRunSnapshots } from './routes/adminSnapshots.js';
import { aiLimits } from './routes/aiLimits.js';
import { asyncHandler } from './lib/asyncHandler.js';
import { originGate } from './lib/originGate.js';
import { addLog } from './lib/logBuffer.js';
import { warnIfAdminFallbackEnabled } from './lib/adminResolver.js';

const isTestRuntime = Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test';
if (!isTestRuntime) {
  await import('./loadEnv.js');
}
/** Log and keep the process alive — never process.exit on unhandledRejection. */
export function onUnhandledRejection(reason) {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  console.error('[trazza-server] unhandledRejection:', msg, stack || '');
  addLog('error', 'system', `unhandledRejection: ${msg}`);
}
process.on('unhandledRejection', onUnhandledRejection);

/** @returns {import('express').Express} */
export function createApp() {
  warnIfAdminFallbackEnabled();
  const app = express();

  // Detrás de nginx (producción self-hosted) TODA petición llega desde 127.0.0.1,
  // así que sin esto `req.ip` es el mismo para todo el mundo y los rate-limiters
  // dejan de ser "por IP". Mantener hops explícitos evita confiar en cabeceras
  // forjadas cuando solo hay un proxy de confianza.
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));

  // Vision import sends base64 images / rasterised PDF pages — needs a far larger
  // body than text routes. Mounted FIRST for its path.
  app.use('/api/parse-freeform', express.json({ limit: '30mb' }));
  // Large multi-year CSV exports exceed the default limit; the route truncates/chunks later.
  app.use('/api/analyze-csv', express.json({ limit: '5mb' }));
  app.use(express.json({ limit: '512kb' }));

  // Security headers
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }));

  // CORS: allow only known frontend origins.
  const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim());
  // Known Vite dev ports — do NOT use wildcard regexes.
  const DEV_ORIGINS = ['http://localhost:5173', 'http://localhost:4173', 'http://localhost:3000'];

  app.use(cors({
    origin: (origin, cb) => {
      // No origin: curl/Postman/server-to-server — allow only outside production.
      if (!origin) return cb(null, process.env.NODE_ENV !== 'production');
      if (DEV_ORIGINS.includes(origin)) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      // No ACAO; originGate decides the explicit 403.
      return cb(null, false);
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));

  app.use(originGate({
    allowedOrigins: ALLOWED_ORIGINS,
    devOrigins: DEV_ORIGINS,
    isProd: process.env.NODE_ENV === 'production',
  }));

  // Public endpoint limiters (pre-auth surfaces).
  const shareLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
  });
  const contactLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
  });
  const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
  });
  const telemetryLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
  });
  const mappingsLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 6,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
  });
  const assetsLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
  });
  const adminLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
  });

  // express-rate-limit middleware is async in v8; wrap to keep async safety uniform.
  app.post('/webhooks/notify', asyncHandler(webhookLimiter), asyncHandler(emailNotify));
  // `/contact` kept as backward-compatible alias for older clients.
  app.post('/api/contact', asyncHandler(contactLimiter), asyncHandler(contactForm));
  app.post('/contact', asyncHandler(contactLimiter), asyncHandler(contactForm));
  app.get('/share-data/:token', asyncHandler(shareLimiter), asyncHandler(getShare));
  // Share page HTML from Express with token-specific meta.
  app.get('/share/:token', asyncHandler(shareLimiter), asyncHandler(sharePage));

  // withRateLimit is async: keep wrapped (Express 4 does not catch async rejections).
  app.post('/api/validate-import', asyncHandler(withRateLimit('import')), asyncHandler(validateImport));
  app.post('/api/portfolio-chat', asyncHandler(withRateLimit('chat')), asyncHandler(portfolioChat));
  app.post('/api/analyze-csv', asyncHandler(withRateLimit('import')), asyncHandler(analyzeCsv));
  app.post('/api/parse-freeform', asyncHandler(withRateLimit('import')), asyncHandler(parseFreeform));
  app.post('/api/score-portfolio', asyncHandler(withRateLimit('analysis')), asyncHandler(scorePortfolio));
  app.post('/api/analyze-earnings', asyncHandler(withRateLimit('analysis')), asyncHandler(analyzeEarnings));
  app.post('/api/log-import', asyncHandler(telemetryLimiter), asyncHandler(logImport));
  // Shared ISIN → ticker mapping catalog, validated server-side.
  app.post('/api/ticker-mappings', asyncHandler(mappingsLimiter), asyncHandler(tickerMappings));
  // Shared `assets` row creation happens server-side (service role).
  app.post('/api/assets', asyncHandler(assetsLimiter), asyncHandler(createAssets));
  // Public telemetry endpoint: same limiter as other client-side logs.
  app.post('/api/log-error', asyncHandler(telemetryLimiter), asyncHandler(logError));

  app.get('/api/ai/limits', asyncHandler(aiLimits));

  app.use('/api/admin', asyncHandler(adminLimiter));
  app.get('/api/admin/health', asyncHandler(adminHealth));
  app.get('/api/admin/parser-candidates', asyncHandler(adminParserCandidates));
  app.get('/api/admin/users', asyncHandler(adminListUsers));
  app.post('/api/admin/run-snapshots', asyncHandler(adminRunSnapshots));

  // Market-data proxies: generous per-IP limit for portfolio refresh bursts.
  const marketLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
  });
  registerMarketProxies(app, asyncHandler(marketLimiter));
  // Calendar endpoint mounted server-side once; not one fetch per browser tab.
  app.get('/api/market-calendar/:kind', asyncHandler(marketLimiter), asyncHandler(marketCalendarHandler));

  app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

  app.use(errorHandler);
  return app;
}

/**
 * Central Express error handler — 4xx from body-parser stay 4xx; 500 never leaks message/stack.
 */
export function errorHandler(err, _req, res, _next) {
  console.error('[trazza-server] Unhandled error:', err?.message, err?.stack);
  const status = Number(err?.status) || Number(err?.statusCode) || 500;
  if (status === 400 && err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  // Contract I-1: never expose internal 400 parser/decoder messages.
  if (status === 400) {
    return res.status(400).json({ error: 'Bad request' });
  }
  if (status === 413) {
    return res.status(413).json({ error: 'Payload too large' });
  }
  if (status === 415) {
    return res.status(415).json({ error: 'Unsupported media type' });
  }
  if (status >= 400 && status < 500) {
    return res.status(status).json({ error: 'Bad request' });
  }
  return res.status(500).json({ error: 'Internal server error' });
}
