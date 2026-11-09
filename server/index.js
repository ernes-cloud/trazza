/**
 * Trazza – Validation Server
 *
 * Standalone Express server that exposes AI-powered CSV validation via Groq.
 * Runs separately from the Vite frontend.
 *
 * Setup:
 *   cd server
 *   npm install
 *   GROQ_API_KEY=gsk_... PORT=4000 node index.js
 *
 * The Vite frontend proxies /api/validate-import to this server.
 * In production, configure your reverse proxy (nginx/caddy) accordingly.
 *
 * Production: run from the server/ directory (systemd WorkingDirectory=…),
 * ExecStart=node index.js — this file ALWAYS listens when executed
 * (no isDirectRun path compare). createApp lives in app.js; tests import app.js,
 * never this file (importing it would bind a port).
 */

import './loadEnv.js';
import { createApp }                    from './app.js';
import { addLog }                       from './lib/logBuffer.js';
import { scheduleCrons }                from './lib/scheduleCrons.js';
import { getAppUrl }                    from './lib/appUrl.js';

const PORT = process.env.PORT || 4000;

function assertAppUrl() {
  try {
    getAppUrl();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[trazza-server] FATAL: ${msg}`);
    process.exit(1);
  }
}

function startServer() {
  assertAppUrl();
  const app = createApp();

  app.listen(PORT, () => {
    console.log(`[trazza-server] Listening on http://localhost:${PORT}`);
    addLog('info', 'system', `Server started on port ${PORT}`);
    scheduleCrons();
    if (!process.env.GROQ_API_KEY) {
      console.warn('[trazza-server] WARNING: GROQ_API_KEY is not set — AI routes will fail');
    }
    const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (svcKey && !svcKey.startsWith('eyJ')) {
      console.warn('[trazza-server] WARNING: SUPABASE_SERVICE_ROLE_KEY looks like the anon key, not the service role JWT. Get the service_role key from Supabase Dashboard → Settings → API.');
    }
    if (!(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL) || !svcKey) {
      console.warn('[trazza-server] WARNING: Supabase not configured — rate limiting disabled');
    }
  });
}

// Always start when this module is executed (node server/index.js, cwd=server,
// or via symlink). No path-equality gate — that exited 0 without listen under
// systemd Restart=on-failure when argv[1] was a symlink.
startServer();
