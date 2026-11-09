import { describe, it, expect } from 'vitest';
import { createApp } from './app.js';

function listMountedRoutes(app) {
  const routes = [];
  for (const layer of app?._router?.stack || []) {
    if (!layer.route?.path) continue;
    const methods = Object.keys(layer.route.methods || {}).filter((m) => layer.route.methods[m]);
    for (const method of methods) {
      routes.push(`${method.toUpperCase()} ${layer.route.path}`);
    }
  }
  return routes.sort();
}

const REMOVED_ROUTE = 'PATCH /api/admin/users/:userId/plan';

describe('createApp route contract (m-3)', () => {
  it('mounts the exact 25 method+path contract routes (sin PATCH plan de usuario)', () => {
    const app = createApp();
    const all = listMountedRoutes(app);
    const contract = all.filter((entry) => ![
      'POST /contact',
      'GET /share-data/:token',
      'GET /share/:token',
      'GET /health',
    ].includes(entry));

    expect(contract).toEqual([
      'GET /api/admin/health',
      'GET /api/admin/parser-candidates',
      'GET /api/admin/users',
      'GET /api/ai/limits',
      'GET /api/eodhd-secure/*',
      'GET /api/eodhd/*',
      'GET /api/frankfurter/*',
      'GET /api/market-calendar/:kind',
      'GET /api/nasdaq/*',
      'GET /api/yahoo-profile/:ticker',
      'GET /api/yahoo/*',
      'GET /api/yahoo2/*',
      'POST /api/admin/run-snapshots',
      'POST /api/analyze-csv',
      'POST /api/analyze-earnings',
      'POST /api/assets',
      'POST /api/contact',
      'POST /api/log-error',
      'POST /api/log-import',
      'POST /api/parse-freeform',
      'POST /api/portfolio-chat',
      'POST /api/score-portfolio',
      'POST /api/ticker-mappings',
      'POST /api/validate-import',
      'POST /webhooks/notify',
    ]);
    expect(contract).toHaveLength(25);
    expect(contract).not.toContain(REMOVED_ROUTE);
  });
});
