/**
 * Fixtures para sembrar filas de A en tablas con user_id (T5 / I-2).
 * MIN_ISOLATION_TABLES debe coincidir con el número de entradas en TABLE_FIXTURES.
 *
 * Para probar el umbral: comenta temporalmente UNA entrada en TABLE_FIXTURES
 * (no bajes MIN_ISOLATION_TABLES) — el test debe fallar con seeded < N.
 */
import { U_A } from './rlsOssPgSetup.js';

/** Número fijo: tablas public con user_id+RLS tras D3 (+ report_sends). */
export const MIN_ISOLATION_TABLES = 13;

/** Tablas cubiertas, en orden alfabético (debe tener longitud MIN_ISOLATION_TABLES). */
export const ISOLATION_TABLE_NAMES = [
  'ai_usage',
  'brokers',
  'imported_data',
  'notifications',
  'portfolio_alerts',
  'portfolio_metrics_cache',
  'portfolio_shares',
  'portfolio_snapshots',
  'portfolios',
  'report_sends',
  'user_asset_preferences',
  'user_preferences',
  'watchlists',
];

if (ISOLATION_TABLE_NAMES.length !== MIN_ISOLATION_TABLES) {
  throw new Error(
    `ISOLATION_TABLE_NAMES (${ISOLATION_TABLE_NAMES.length}) !== MIN_ISOLATION_TABLES (${MIN_ISOLATION_TABLES})`,
  );
}

const ASSET_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BROKER_A = 'ba111111-1111-1111-1111-111111111111';
const WATCHLIST_A = '0e111111-1111-1111-1111-111111111111';
const ST_ACCOUNT_A = 'st-acct-a-0001';
const U_B = '22222222-2222-2222-2222-222222222222';

const SEED = {
  broker: 'b1111111-1111-1111-1111-111111111111',
  portfolio: 'f1111111-1111-1111-1111-111111111111',
  notif: 'c1111111-1111-1111-1111-111111111111',
  imported: 'd1111111-1111-1111-1111-111111111111',
  watchlist2: 'e1111111-1111-1111-1111-111111111111',
  ai: 'a1111111-1111-1111-1111-111111111111',
  pshare: '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  email: '91111111-1111-1111-1111-111111111111',
  eproj: '81111111-1111-1111-1111-111111111111',
  sgoal: '71111111-1111-1111-1111-111111111111',
  eentry: '61111111-1111-1111-1111-111111111111',
};

/** @param {ReturnType<import('../../server/lib/pg20261026.harness.js').startTestPg>} pg */
export function ensureAuthUsersStub(pg) {
  pg.psql(`
    INSERT INTO auth.users (id, email) VALUES
      ('${U_A}', 'user-a@example.com'),
      ('${U_B}', 'user-b@example.com')
    ON CONFLICT (id) DO NOTHING;
  `, ['-q']);
}

/**
 * Dependencias compartidas para fixtures que referencian brokers/assets/watchlists.
 * @param {ReturnType<import('../../server/lib/pg20261026.harness.js').startTestPg>} pg
 */
export function buildSharedIsolationDeps(pg) {
  pg.psql(`
    INSERT INTO auth.users (id, email) VALUES
      ('${U_A}', 'user-a@example.com'),
      ('${U_B}', 'user-b@example.com')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.assets (id, ticker, company_name)
    VALUES ('${ASSET_ID}', 'TST', 'Test Co')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.brokers (id, user_id, name)
    VALUES ('${BROKER_A}', '${U_A}', 'Broker A')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.watchlists (id, user_id, name)
    VALUES ('${WATCHLIST_A}', '${U_A}', 'WL A')
    ON CONFLICT (id) DO NOTHING;
  `, ['-q']);
  return { assetId: ASSET_ID, brokerA: BROKER_A, watchlistA: WATCHLIST_A, stAccountA: ST_ACCOUNT_A };
}

const FIXTURE_SQL = {
  brokers: () => `
    INSERT INTO public.brokers (id, user_id, name)
    VALUES ('${SEED.broker}', '${U_A}', 'Seed broker A')
    ON CONFLICT (id) DO NOTHING;
  `,
  portfolios: () => `
    INSERT INTO public.portfolios (id, user_id, name)
    VALUES ('${SEED.portfolio}', '${U_A}', 'Seed PF A')
    ON CONFLICT (id) DO NOTHING;
  `,
  user_preferences: () => `
    INSERT INTO public.user_preferences (user_id) VALUES ('${U_A}')
    ON CONFLICT (user_id) DO NOTHING;
  `,
  notifications: () => `
    INSERT INTO public.notifications (id, user_id, title, message)
    VALUES ('${SEED.notif}', '${U_A}', 't', 'm')
    ON CONFLICT (id) DO NOTHING;
  `,
  imported_data: (ctx) => `
    INSERT INTO public.imported_data (id, user_id, broker_id)
    VALUES ('${SEED.imported}', '${U_A}', '${ctx.brokerA}')
    ON CONFLICT (id) DO NOTHING;
  `,
  watchlists: () => `
    INSERT INTO public.watchlists (id, user_id, name)
    VALUES ('${SEED.watchlist2}', '${U_A}', 'WL seed')
    ON CONFLICT (id) DO NOTHING;
  `,
  ai_usage: () => `
    INSERT INTO public.ai_usage (user_id, feature, period, count)
    VALUES ('${U_A}', 'chat', '2026-01', 1)
    ON CONFLICT (user_id, feature, period) DO NOTHING;
  `,
  portfolio_shares: () => `
    INSERT INTO public.portfolio_shares (id, user_id, mode)
    VALUES ('${SEED.pshare}', '${U_A}', 'live')
    ON CONFLICT (id) DO NOTHING;
  `,
  portfolio_metrics_cache: () => `
    INSERT INTO public.portfolio_metrics_cache (user_id, scope, currency, metrics)
    VALUES ('${U_A}', 'general', 'EUR', '{}'::jsonb)
    ON CONFLICT (user_id, scope) DO NOTHING;
  `,
  user_asset_preferences: (ctx) => `
    INSERT INTO public.user_asset_preferences (user_id, asset_id)
    VALUES ('${U_A}', '${ctx.assetId}')
    ON CONFLICT (user_id, asset_id) DO NOTHING;
  `,
  portfolio_snapshots: () => `
    INSERT INTO public.portfolio_snapshots (user_id, scope, snapshot_date, total_value_eur)
    VALUES ('${U_A}', 'general', CURRENT_DATE, 0)
    ON CONFLICT (user_id, scope, snapshot_date) DO NOTHING;
  `,
  beta_access: () => `
    INSERT INTO public.beta_access (user_id, email, status)
    VALUES ('${U_A}', 'user-a@example.com', 'approved')
    ON CONFLICT (user_id) DO NOTHING;
  `,
  email_sends: () => `
    INSERT INTO public.email_sends (id, kind, recipient, provider, status, user_id)
    VALUES ('${SEED.email}', 'test', 'a@example.com', 'smtp', 'sent', '${U_A}')
    ON CONFLICT (id) DO NOTHING;
  `,
  report_sends: () => `
    INSERT INTO public.report_sends (user_id, kind, period_key)
    VALUES ('${U_A}', 'daily_digest', '2026-01-01')
    ON CONFLICT (user_id, kind, period_key) DO NOTHING;
  `,
  expense_projects: () => `
    INSERT INTO public.expense_projects (id, user_id, name)
    VALUES ('${SEED.eproj}', '${U_A}', 'Proj')
    ON CONFLICT (id) DO NOTHING;
  `,
  savings_goals: () => `
    INSERT INTO public.savings_goals (id, user_id, name, target_amount, target_date)
    VALUES ('${SEED.sgoal}', '${U_A}', 'Goal', 100, CURRENT_DATE + 30)
    ON CONFLICT (id) DO NOTHING;
  `,
  expense_entries: () => `
    INSERT INTO public.expense_entries (id, user_id, type, amount, entry_date)
    VALUES ('${SEED.eentry}', '${U_A}', 'expense', 10, CURRENT_DATE)
    ON CONFLICT (id) DO NOTHING;
  `,
  snaptrade_users: () => `
    INSERT INTO public.snaptrade_users (user_id, st_user_secret)
    VALUES ('${U_A}', 'secret-a')
    ON CONFLICT DO NOTHING;
  `,
  snaptrade_accounts: (ctx) => `
    INSERT INTO public.snaptrade_accounts (st_account_id, user_id, broker_id)
    VALUES ('${ctx.stAccountA}', '${U_A}', '${ctx.brokerA}')
    ON CONFLICT DO NOTHING;
  `,
  portfolio_alerts: () => `
    INSERT INTO public.portfolio_alerts (user_id, scope, enabled)
    VALUES ('${U_A}', 'general', true)
    ON CONFLICT DO NOTHING;
  `,
};

/**
 * Siembra una fila de A en `table`. Lanza si falla (sin catch silencioso).
 * @param {ReturnType<import('../../server/lib/pg20261026.harness.js').startTestPg>} pg
 * @param {string} table
 * @param {ReturnType<typeof buildSharedIsolationDeps>} ctx
 */
export function seedUserARow(pg, table, ctx) {
  const fn = FIXTURE_SQL[table];
  if (!fn) {
    throw new Error(`sin fixture para tabla ${table}; amplía FIXTURE_SQL o excluye la tabla del umbral`);
  }
  pg.psql(fn(ctx), ['-q']);
}

/**
 * Cuenta cuántas tablas del listado descubierto tienen fixture.
 * @param {string[]} discoveredTables
 */
export function missingIsolationFixtures(discoveredTables) {
  const covered = new Set(ISOLATION_TABLE_NAMES);
  return discoveredTables.filter((t) => !covered.has(t));
}
