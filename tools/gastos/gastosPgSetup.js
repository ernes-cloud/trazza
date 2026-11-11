/**
 * Montaje Postgres desechable para P0-2 de Gastos (RLS / FK / GRANTs).
 *
 * Aplica SOLO el stub mínimo + las migraciones publicadas de preferencias y
 * gastos. No edita esas migraciones. El GRANT de fixture (simula los default
 * privileges de PostgREST en prod) se aplica DESPUÉS de fotografiar privilegios
 * reales de las migraciones.
 *
 * PG_TESTS=1 · PG_BIN · nunca un PG remoto (se ignora PGHOST).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDisposablePg, STUB_SQL } from '../../server/lib/pg20261026.harness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const PSQL_TUPLE = ['-q', '-t', '-A'];
export const PSQL_ERROR_VERBOSE = ['-q', '-t', '-A', '-v', 'VERBOSITY=verbose'];

export const U_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
export const U_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

export const GOAL_A = 'c0a11111-1111-1111-1111-111111111111';
export const GOAL_B = 'c0b22222-2222-2222-2222-222222222222';
export const PROJECT_A = 'e0a11111-1111-1111-1111-111111111111';
export const PROJECT_B = 'e0b22222-2222-2222-2222-222222222222';
export const ENTRY_A = 'ea111111-1111-1111-1111-111111111111';
export const ENTRY_B = 'eb222222-2222-2222-2222-222222222222';
export const TPL_A = 'aa111111-1111-1111-1111-111111111111';
export const TPL_B = 'bb222222-2222-2222-2222-222222222222';
export const PREF_NOTE_A = 'pref-a';
export const PREF_NOTE_B = 'pref-b';

export const GASTOS_TABLES = [
  'expense_entries',
  'expense_projects',
  'savings_goals',
  'user_preferences',
];

/**
 * Semilla fija: el orden y el conjunto que ya montaban las bases de P0-2.
 * No se añade aquí nada anterior ni intermedio (p. ej. dashboard_widgets o
 * fk_covering_indexes) para no cambiar lo que se aplica a esas bases.
 * Las migraciones de Gastos con nombre posterior a la última semilla se
 * descubren en disco y se concatenan al final.
 */
export const GASTOS_MIGRATION_SEEDS = [
  '20260716_core_tables_rls.sql',
  '20260719_expense_entries.sql',
  '20260719_savings_goals.sql',
  '20260719_expense_recurrence_until_goal.sql',
  '20260719_savings_initial_balance.sql',
  '20260719_expense_budgets.sql',
  '20260720_expense_custom_categories.sql',
  '20260721_savings_goals_allocation.sql',
  '20260725_expenses_widgets.sql',
  '20260727_expense_entries_skipped.sql',
  '20260801_expense_bank_import.sql',
  '20260801_expense_projects.sql',
  '20260801_recurring_end_alerts.sql',
  '20260801_savings_goals_open_envelopes.sql',
  '20260822_savings_goals_completion.sql',
  '20260911_user_preferences_plan_guard.sql',
  '20260912_user_preferences_privacy_onboarding.sql',
];

const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations');

/** Nombre de migración de Gastos (semilla o posterior: expense/savings/recurring/prefs/core RLS). */
export function isGastosMigrationFilename(filename) {
  return /(?:^|\d_)(expense|savings_goals|savings_initial_balance|recurring_end_alerts|user_preferences|core_tables_rls)(?:[._]|$)/.test(filename)
    || filename.includes('expense_');
}

export function lastGastosMigrationSeed() {
  return GASTOS_MIGRATION_SEEDS[GASTOS_MIGRATION_SEEDS.length - 1];
}

export function listGastosMigrationFilenames() {
  const lastSeed = lastGastosMigrationSeed();
  const onDisk = fs.existsSync(MIGRATIONS_DIR)
    ? fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
    : [];
  const extras = onDisk.filter((f) => (
    isGastosMigrationFilename(f)
    && f > lastSeed
    && !GASTOS_MIGRATION_SEEDS.includes(f)
  ));
  return [...GASTOS_MIGRATION_SEEDS, ...extras];
}

export const GASTOS_MIGRATIONS = listGastosMigrationFilenames()
  .map((name) => path.join(MIGRATIONS_DIR, name));

/**
 * auth.users + user_preferences (el CREATE original es anterior al folder de
 * migraciones) + transactions para que 20260716 aplique completa.
 */
export const GASTOS_STUB_SQL = `
${STUB_SQL}

CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY,
  email text
);

CREATE TABLE IF NOT EXISTS public.transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id uuid REFERENCES public.positions(id)
);

CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  title text NOT NULL,
  message text NOT NULL,
  is_read boolean DEFAULT false,
  created_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL,
  link text,
  type text,
  send_email boolean DEFAULT true NOT NULL
);

-- OSS baseline: 20260716_core_tables_rls also ALTERs imported_data.
CREATE TABLE IF NOT EXISTS public.imported_data (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  broker_id uuid REFERENCES public.brokers(id) ON DELETE CASCADE,
  transactions jsonb DEFAULT '[]'::jsonb NOT NULL,
  prices jsonb DEFAULT '{}'::jsonb NOT NULL,
  ticker_map jsonb DEFAULT '{}'::jsonb NOT NULL,
  updated_at timestamptz DEFAULT now(),
  UNIQUE (user_id, broker_id)
);

CREATE TABLE IF NOT EXISTS public.user_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'free',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
`;

export const FIXTURE_GRANTS_SQL = `
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.expense_entries, public.expense_projects, public.savings_goals, public.user_preferences
  TO authenticated;
`;

export function lastPsqlField(stdout) {
  const lines = String(stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

export function isTablePrivilegeDenied(err) {
  const msg = `${err?.stderr || ''}${err?.message || ''}`;
  return /permission denied for (table|schema|relation)/i.test(msg) && !/42501/.test(msg);
}

/** Denegación RLS/policy: exige SQLSTATE 42501 (psql VERBOSITY=verbose). */
export function isRlsPolicySqlState42501(err) {
  const msg = `${err?.stderr || ''}${err?.message || ''}`;
  return /SQLSTATE\[42501\]|(?:\b|:)42501\b/.test(msg);
}

export function isRlsPolicyViolation(err) {
  const msg = `${err?.stderr || ''}${err?.message || ''}`;
  return isRlsPolicySqlState42501(err) && /row-level security/i.test(msg);
}

/**
 * Rechazo de pertenencia (FK ajena). La migración de Develop
 * (`*expense_ownership_rls_grants`) lanza RAISE EXCEPTION … ERRCODE = '42501'.
 * Solo aceptamos ese SQLSTATE: no 23514 (CHECK), P0001 (RAISE por defecto)
 * ni 23503 (FK relacional estándar). El texto del error puede mencionar
 * «no pertenece», pero no basta por sí solo.
 */
export function isOwnershipRejection(err) {
  return isRlsPolicySqlState42501(err);
}

function wrapRoleTransaction(role, userId, bodySql, withVerboseErrors) {
  const jwt = userId ? userId.replace(/'/g, "''") : '';
  const sub = `DO $$ BEGIN PERFORM set_config('request.jwt.claim.sub', '${jwt}', true); END $$;`;
  const verbosity = withVerboseErrors ? 'SET LOCAL client_min_messages = notice;\n' : '';
  return `
BEGIN;
${verbosity}
${sub}
SET LOCAL ROLE ${role};
${bodySql}
COMMIT;
`;
}

export function runAsAuthenticated(pg, userId, bodySql, extraPsqlArgs = PSQL_TUPLE) {
  return lastPsqlField(pg.psql(wrapRoleTransaction('authenticated', userId, bodySql, false), extraPsqlArgs));
}

export function runAsAuthenticatedExpectError(pg, userId, bodySql) {
  return pg.psql(wrapRoleTransaction('authenticated', userId, bodySql, true), PSQL_ERROR_VERBOSE);
}

export function runAsAnon(pg, bodySql, extraPsqlArgs = PSQL_TUPLE) {
  return lastPsqlField(pg.psql(wrapRoleTransaction('anon', '', bodySql, false), extraPsqlArgs));
}

export function runAsAnonExpectError(pg, bodySql) {
  return pg.psql(wrapRoleTransaction('anon', '', bodySql, true), PSQL_ERROR_VERBOSE);
}

export function seedAsSuperuser(pg, sql, extra = PSQL_TUPLE) {
  return pg.psql(sql, extra);
}

export function authenticatedSelectCount(pg, userId, table, whereClause = '') {
  try {
    return runAsAuthenticated(
      pg,
      userId,
      `SELECT COUNT(*)::int FROM public.${table} ${whereClause};`,
    );
  } catch (e) {
    if (isTablePrivilegeDenied(e) || isRlsPolicySqlState42501(e)) return '0';
    throw e;
  }
}

export function snapshotPrivileges(pg, tables = GASTOS_TABLES) {
  const list = tables.map((t) => `'${t}'`).join(', ');
  const raw = lastPsqlField(pg.psql(`
    SELECT string_agg(
      c.relname || ':' ||
      r.rolname || ':' ||
      p.priv || '=' ||
      COALESCE(has_table_privilege(r.rolname, 'public.' || c.relname, p.priv)::text, 'f'),
      ',' ORDER BY c.relname, r.rolname, p.priv
    )
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS p(priv)
    CROSS JOIN (SELECT rolname FROM pg_roles WHERE rolname IN ('authenticated', 'anon')) r
    WHERE c.relname IN (${list});
  `, PSQL_TUPLE));
  const map = {};
  for (const part of (raw || '').split(',').filter(Boolean)) {
    const [table, role, rest] = part.split(':');
    const [priv, val] = rest.split('=');
    map[`${table}:${role}:${priv}`] = val === 'true' || val === 't';
  }
  return map;
}

export function policyRolesByTable(pg, tables = GASTOS_TABLES) {
  const list = tables.map((t) => `'${t}'`).join(', ');
  const raw = pg.psql(`
    SELECT tablename || '|' || policyname || '|' || array_to_string(roles, ',')
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename IN (${list})
    ORDER BY tablename, policyname;
  `, PSQL_TUPLE);
  return String(raw).split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const [table, policy, roles] = line.split('|');
    return { table, policy, roles: (roles || '').split(',').filter(Boolean) };
  });
}

export function fixtureSql() {
  return `
    INSERT INTO auth.users (id, email) VALUES
      ('${U_A}', 'a@example.com'),
      ('${U_B}', 'b@example.com')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.user_preferences (user_id) VALUES
      ('${U_A}'),
      ('${U_B}')
    ON CONFLICT (user_id) DO NOTHING;

    INSERT INTO public.savings_goals (id, user_id, name, target_amount, target_date, start_date)
    VALUES
      ('${GOAL_A}', '${U_A}', 'Goal A', 1000, '2027-12-31', '2026-01-01'),
      ('${GOAL_B}', '${U_B}', 'Goal B', 1000, '2027-12-31', '2026-01-01')
    ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, name = EXCLUDED.name;

    INSERT INTO public.expense_projects (id, user_id, name, goal_id)
    VALUES
      ('${PROJECT_A}', '${U_A}', 'Project A', '${GOAL_A}'),
      ('${PROJECT_B}', '${U_B}', 'Project B', '${GOAL_B}')
    ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, goal_id = EXCLUDED.goal_id;

    INSERT INTO public.expense_entries (
      id, user_id, type, category, amount, currency, entry_date, recurrence, recurrence_active
    ) VALUES
      ('${TPL_A}', '${U_A}', 'expense', 'other', 10, 'EUR', '2026-01-01', 'monthly', true),
      ('${TPL_B}', '${U_B}', 'expense', 'other', 10, 'EUR', '2026-01-01', 'monthly', true),
      ('${ENTRY_A}', '${U_A}', 'expense', 'other', 25, 'EUR', '2026-02-01', 'none', true),
      ('${ENTRY_B}', '${U_B}', 'expense', 'other', 25, 'EUR', '2026-02-01', 'none', true)
    ON CONFLICT (id) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      project_id = NULL,
      recurring_source_id = NULL,
      amount = EXCLUDED.amount;
  `;
}

export function resetFixtures(pg) {
  seedAsSuperuser(pg, `
    DELETE FROM public.expense_entries WHERE user_id IN ('${U_A}', '${U_B}');
    DELETE FROM public.expense_projects WHERE user_id IN ('${U_A}', '${U_B}');
    DELETE FROM public.savings_goals WHERE user_id IN ('${U_A}', '${U_B}');
    DELETE FROM public.user_preferences WHERE user_id IN ('${U_A}', '${U_B}');
  `);
  seedAsSuperuser(pg, fixtureSql());
  const role = lastPsqlField(pg.psql(
    `SELECT current_setting('session_replication_role');`,
    PSQL_TUPLE,
  ));
  if (role !== 'origin') {
    throw new Error(`fixture leaked replication mode: ${role}`);
  }
}

/**
 * Siembra que necesita saltarse triggers (p. ej. una fila histórica incoherente).
 * El modo replica SOLO vive dentro de esta transacción.
 */
export function seedWithReplicaInTransaction(pg, innerSql) {
  seedAsSuperuser(pg, `
    BEGIN;
    SET LOCAL session_replication_role = replica;
    ${innerSql}
    COMMIT;
    DO $$ BEGIN
      IF current_setting('session_replication_role') <> 'origin' THEN
        RAISE EXCEPTION 'fixture leaked replication mode';
      END IF;
    END $$;
  `);
}

export function applyPublishedGastosMigrations(pg) {
  for (const file of GASTOS_MIGRATIONS) {
    if (!fs.existsSync(file)) throw new Error(`falta migración publicada: ${file}`);
    pg.psqlFile(file);
  }
}

export function applyFixFile(pg, fixFile) {
  if (!fixFile || !fs.existsSync(fixFile)) {
    throw new Error(`falta la migración candidata de verificación: ${fixFile || '(ruta vacía)'}`);
  }
  pg.psqlFile(fixFile);
}

export function resolveFixFile() {
  const fromEnv = process.env.GASTOS_P0_FIX_FILE;
  if (fromEnv) return fromEnv;
  const fallback = '/workspace/trazza-tests/tdd-gastos-verify/p0-2-rls-fk-candidate.sql';
  return fs.existsSync(fallback) ? fallback : null;
}

/**
 * Arranca un PG local desechable (nunca PGHOST). Aplica stub + migraciones.
 * Fotografía privilegios ANTES del GRANT de fixture.
 */
export function mountGastosDatabase({ applyFix = false, fixtureGrants = true } = {}) {
  const pg = startDisposablePg(55433 + Math.floor(Math.random() * 2000));
  if (!pg) throw new Error('no se pudo arrancar Postgres desechable (PG_BIN)');
  try {
    pg.psql(GASTOS_STUB_SQL);
    applyPublishedGastosMigrations(pg);
    if (applyFix) applyFixFile(pg, resolveFixFile());
    const privilegesBeforeFixtureGrants = snapshotPrivileges(pg);
    const policies = policyRolesByTable(pg);
    if (fixtureGrants) pg.psql(FIXTURE_GRANTS_SQL);
    seedAsSuperuser(pg, fixtureSql());
    const role = lastPsqlField(pg.psql(
      `SELECT current_setting('session_replication_role');`,
      PSQL_TUPLE,
    ));
    if (role !== 'origin') throw new Error(`montaje leaked replication mode: ${role}`);
    return { pg, privilegesBeforeFixtureGrants, policies, setupError: null };
  } catch (e) {
    try { pg.stop(); } catch { /* ignore */ }
    return {
      pg: null,
      privilegesBeforeFixtureGrants: {},
      policies: [],
      setupError: `fixture setup failed: ${e.stderr || e.message}`,
    };
  }
}

export function migrationSqlCorpus() {
  const dir = path.join(ROOT, 'supabase/migrations');
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ file: f, sql: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

export function publishedGrantMentions(table) {
  return migrationSqlCorpus().filter(({ sql }) => {
    const re = new RegExp(`GRANT\\s+[^;]*\\b${table}\\b[^;]*;`, 'i');
    return re.test(sql);
  }).map((x) => x.file);
}
