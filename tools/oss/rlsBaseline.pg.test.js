import { pgDescribe } from './pgTestMode.js';
/**
 * T5 (OSS): la Trazza real arrastra un esquema que "predates the versioned
 * migrations folder" (literal de supabase/migrations/20260716_core_tables_rls.sql):
 * las tablas núcleo (brokers, portfolios, positions, transactions,
 * user_preferences, notifications…) solo existen hoy en el dashboard de
 * Supabase de producción — NINGÚN fichero de este repo las crea. Sin un
 * volcado de ese esquema, el self-hoster de la versión OSS no puede levantar
 * una base de datos propia ni aplicar `supabase/migrations/*.sql` (que son
 * puro ALTER/RLS sobre tablas que, en un Postgres limpio, no existen).
 *
 * Este test exige ese volcado ("baseline") en uno de estos sitios (D5 debe
 * crearlo):
 *   - supabase/baseline/schema.sql           (un único fichero), o
 *   - supabase/baseline.sql                  (alias plano), o
 *   - supabase/baseline/*.sql                (varios, aplicados en orden alfabético)
 *
 * Con el baseline presente, aplica BASELINE + TODAS las migraciones de
 * supabase/migrations contra un Postgres real (el mismo harness que
 * server/lib/pg20261026.harness.js: PGHOST de CI, o initdb local en /tmp vía
 * PG_BIN — nunca un Postgres remoto), dos veces seguidas (idempotencia), y
 * comprueba RLS/privilegios de forma GENÉRICA (sin asumir qué tablas trae el
 * baseline, aparte de assets/ticker_mappings que ya son contractuales):
 *   - rowsecurity = true en todas las tablas de public;
 *   - ninguna función SECURITY DEFINER de public sin `search_path` fijado
 *     (proconfig), para no heredar el search_path de quien la invoque;
 *   - para cada tabla con columna `user_id`: anon no puede leer ni escribir
 *     ninguna fila, y un usuario B (authenticated, auth.uid() = B) no ve ni
 *     puede tocar las filas del usuario A por select/insert/update/delete;
 *   - assets y ticker_mappings: `authenticated` no puede INSERT/UPDATE (son
 *     tablas compartidas que solo escribe el service role — ver CLAUDE.md).
 *
 * Solo corre con PG_TESTS=1 (igual que pg20261026.migration.test.js); sin esa
 * variable, se omite con aviso visible; con PG_TESTS=1 el montaje debe pasar.
 */
import {
  describe, it as vitestIt, expect, beforeAll, afterAll,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startEmbeddedRlsPg,
  isRlsPolicySqlState42501,
  isTablePrivilegeDenied,
  runAsAuthenticated,
  authenticatedSelectCount,
  U_A as FIXTURE_U_A,
} from './rlsOssPgSetup.js';
import {
  MIN_ISOLATION_TABLES,
  ISOLATION_TABLE_NAMES,
  buildSharedIsolationDeps,
  ensureAuthUsersStub,
  seedUserARow,
  missingIsolationFixtures,
} from './rlsUserTableFixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations');

const describePg = pgDescribe(describe);

const U_A = FIXTURE_U_A;
const U_B = '22222222-2222-2222-2222-222222222222';

/**
 * Roles anon/authenticated/service_role + auth.uid() simulado, exactamente
 * como server/lib/pg20261026.harness.js (STUB_SQL) pero SIN crear ninguna
 * tabla — las tablas las trae el baseline, no este fichero.
 */
const ROLE_BOOTSTRAP_SQL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN
  CREATE ROLE anon NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE authenticated NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
`;

function findBaselineFiles() {
  const singleCandidates = [
    path.join(ROOT, 'supabase/baseline/schema.sql'),
    path.join(ROOT, 'supabase/baseline.sql'),
  ];
  for (const f of singleCandidates) {
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return [f];
  }
  const dir = path.join(ROOT, 'supabase/baseline');
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => path.join(dir, f));
    if (files.length > 0) return files;
  }
  return null;
}

function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => path.join(MIGRATIONS_DIR, f));
}

const BASELINE_MISSING_MSG = 'falta baseline: crea supabase/baseline/schema.sql (o supabase/baseline/*.sql) '
  + 'con un volcado del esquema de Supabase (tablas núcleo + políticas) — hoy ese esquema solo existe '
  + 'en el dashboard de producción (ver supabase/migrations/20260716_core_tables_rls.sql) y por eso '
  + 'supabase/migrations/*.sql no se puede aplicar desde cero';

describePg('RLS baseline OSS — esquema completo + migraciones contra Postgres real', () => {
  const baselineFiles = findBaselineFiles();
  const migrationFiles = listMigrationFiles();
  let pg = null;
  let setupError = null;
  let executedCases = 0;
  function it(name, body) {
    vitestIt(name, () => {
      executedCases += 1;
      expect(process.env.PG_TESTS, 'PG_TESTS=1 required; no silent skips').toBe('1');
      expect(setupError, setupError || 'fixture setup OK').toBeNull();
      expect(pg, 'embedded Postgres fixture required').toBeTruthy();
      body();
    });
  }


  beforeAll(() => {
    if (process.env.PG_TESTS !== '1') { setupError = 'PG_TESTS=1 required'; return; }
    try {
    if (!baselineFiles) { setupError = BASELINE_MISSING_MSG; return; } // nada que montar: los `it` fallan con BASELINE_MISSING_MSG
    try {
      pg = startEmbeddedRlsPg();
    } catch (e) {
      setupError = e.message;
      return;
    }
    if (!pg) {
      setupError = 'no se pudo arrancar Postgres embebido (PG_BIN con initdb/pg_ctl/psql locales; sin PGHOST remoto)';
      return;
    }
    try {
      pg.psql(ROLE_BOOTSTRAP_SQL);
      for (const f of baselineFiles) pg.psqlFile(f);
      for (const f of migrationFiles) pg.psqlFile(f);
    } catch (e) {
      setupError = `fallo aplicando baseline + migraciones: ${e.message}`;
    }
    } catch (e) { setupError = `fixture setup failed: ${e.stderr || e.message}`; }
  });

  afterAll(() => {
    try { expect(executedCases, 'minimum executed cases: no hook-induced skips').toBeGreaterThanOrEqual(9); }
    finally { pg?.stop(); }
  });

  it('existe un baseline de esquema bajo supabase/baseline', () => {
    expect(baselineFiles, BASELINE_MISSING_MSG).not.toBeNull();
  });

  it('el baseline + las migraciones aplican sin error sobre un Postgres limpio', () => {
    if (!baselineFiles) { expect(false, BASELINE_MISSING_MSG).toBe(true); return; }
    expect(setupError, setupError || 'sin error').toBeNull();
  });

  it('las migraciones se pueden reaplicar una segunda vez sin error (idempotencia)', () => {
    if (!baselineFiles) { expect(false, BASELINE_MISSING_MSG).toBe(true); return; }
    if (setupError) { expect(setupError, 'el montaje inicial ya falló; no se reintenta').toBeNull(); return; }
    let err = null;
    try {
      for (const f of migrationFiles) pg.psqlFile(f);
    } catch (e) {
      err = e.stderr || e.message;
    }
    expect(err, err ? `migración no idempotente: ${err}` : 'sin error').toBeNull();
  });

  it('rowsecurity = true en TODAS las tablas de public', () => {
    if (!baselineFiles) { expect(false, BASELINE_MISSING_MSG).toBe(true); return; }
    if (setupError) { expect(setupError).toBeNull(); return; }
    const out = pg.psql(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND rowsecurity = false
      ORDER BY tablename;
    `, ['-q', '-t', '-A']).trim();
    expect(out, `tablas de public SIN RLS habilitado: ${out || '(ninguna encontrada — ¿el baseline no trajo tablas?)'}`).toBe('');
  });

  it('toda función SECURITY DEFINER de public tiene search_path fijado (proconfig)', () => {
    if (!baselineFiles) { expect(false, BASELINE_MISSING_MSG).toBe(true); return; }
    if (setupError) { expect(setupError).toBeNull(); return; }
    const out = pg.psql(`
      SELECT p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef = true
        AND NOT EXISTS (
          SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) cfg
          WHERE cfg LIKE 'search_path=%'
        )
      ORDER BY p.proname;
    `, ['-q', '-t', '-A']).trim();
    expect(out, `funciones SECURITY DEFINER sin search_path fijado: ${out}`).toBe('');
  });

  it('assets y ticker_mappings: authenticated no puede INSERT ni UPDATE (solo service role escribe)', () => {
    if (!baselineFiles) { expect(false, BASELINE_MISSING_MSG).toBe(true); return; }
    if (setupError) { expect(setupError).toBeNull(); return; }
    for (const table of ['assets', 'ticker_mappings']) {
      const exists = pg.psql(
        `SELECT to_regclass('public.${table}') IS NOT NULL;`,
        ['-q', '-t', '-A'],
      ).trim();
      expect(exists, `el baseline no trae la tabla public.${table}`).toBe('t');

      const priv = pg.psql(`
        SELECT
          has_table_privilege('authenticated', 'public.${table}', 'insert') AS a_ins,
          has_table_privilege('authenticated', 'public.${table}', 'update') AS a_upd;
      `, ['-q', '-t', '-A']).trim();
      expect(priv, `authenticated conserva privilegios de escritura en ${table}: ${priv}`).toBe('f|f');
    }
  });

  it('anon no tiene NINGÚN privilegio de escritura en ninguna tabla de public', () => {
    if (!baselineFiles) { expect(false, BASELINE_MISSING_MSG).toBe(true); return; }
    if (setupError) { expect(setupError).toBeNull(); return; }
    const out = pg.psql(`
      SELECT table_name FROM information_schema.role_table_grants
      WHERE grantee = 'anon' AND table_schema = 'public'
        AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
      ORDER BY table_name;
    `, ['-q', '-t', '-A']).trim();
    expect(out, `anon tiene privilegios de escritura en: ${out}`).toBe('');
  });

  it('tablas con columna user_id: anon sin SELECT; usuario B no ve ni toca filas del usuario A', () => {
    if (!baselineFiles) { expect(false, BASELINE_MISSING_MSG).toBe(true); return; }
    if (setupError) { expect(setupError).toBeNull(); return; }

    const userTables = pg.psql(`
      SELECT DISTINCT c.table_name
      FROM information_schema.columns c
      JOIN pg_tables t ON t.tablename = c.table_name AND t.schemaname = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'user_id' AND t.rowsecurity = true
      ORDER BY 1;
    `, ['-q', '-t', '-A']).trim().split('\n').filter(Boolean);

    expect(userTables.length, 'el baseline no trae ninguna tabla con columna user_id (brokers/portfolios/notifications/user_preferences…)').toBeGreaterThan(0);

    const unmapped = missingIsolationFixtures(userTables);
    expect(
      unmapped,
      `tablas con user_id sin fixture (amplía FIXTURE_SQL): ${unmapped.join(', ')}`,
    ).toEqual([]);

    ensureAuthUsersStub(pg);
    const ctx = buildSharedIsolationDeps(pg);

    const tablesToTest = userTables.filter((t) => ISOLATION_TABLE_NAMES.includes(t));
    const fixtureErrors = [];
    const countBeforeByTable = {};

    for (const table of tablesToTest) {
      try {
        seedUserARow(pg, table, ctx);
      } catch (e) {
        const detail = e?.stderr || e?.message || String(e);
        fixtureErrors.push(`${table}: ${detail}`);
        continue;
      }
      const countA = pg.psql(
        `SELECT COUNT(*)::int FROM public.${table} WHERE user_id = '${U_A}';`,
        ['-q', '-t', '-A'],
      ).trim();
      if (Number(countA) > 0) {
        countBeforeByTable[table] = countA;
      }
    }

    const tablesWithValidA = Object.keys(countBeforeByTable).length;
    const fixtureDetail = fixtureErrors.length ? ` — ${fixtureErrors.join(' | ')}` : '';
    expect(
      tablesWithValidA,
      `umbral fixtures ${tablesWithValidA}/${MIN_ISOLATION_TABLES}${fixtureDetail}`,
    ).toBeGreaterThanOrEqual(MIN_ISOLATION_TABLES);
    expect(
      fixtureErrors,
      fixtureErrors.length
        ? `fallos sembrando fixtures (antes de RLS): ${fixtureErrors.join(' | ')}`
        : 'sin errores de fixture',
    ).toEqual([]);
    expect(
      tablesToTest.length,
      `tablas descubiertas en el umbral (${tablesToTest.length}) < MIN_ISOLATION_TABLES (${MIN_ISOLATION_TABLES})`,
    ).toBeGreaterThanOrEqual(MIN_ISOLATION_TABLES);

    for (const table of tablesToTest) {
      const expectedA = countBeforeByTable[table];
      if (expectedA == null) continue;

      let anonSelect;
      try {
        anonSelect = pg.psql(`
          BEGIN;
          SET ROLE anon;
          SELECT COUNT(*)::int FROM public.${table};
          COMMIT;
        `, ['-q', '-t', '-A']).trim();
      } catch (e) {
        if (!isTablePrivilegeDenied(e)) throw e;
        anonSelect = '0';
      }
      expect(anonSelect, `anon puede leer filas de ${table}: ${anonSelect}`).toBe('0');

      const bSelectA = authenticatedSelectCount(pg, U_B, table, `WHERE user_id = '${U_A}'`);
      expect(bSelectA, `authenticated=B ve filas de A en ${table}`).toBe('0');

      try {
        runAsAuthenticated(pg, U_B, `
          UPDATE public.${table} SET user_id = user_id WHERE user_id = '${U_A}';
          DELETE FROM public.${table} WHERE user_id = '${U_A}';
        `);
      } catch (e) {
        if (!isRlsPolicySqlState42501(e) && !isTablePrivilegeDenied(e)) throw e;
      }

      const still = pg.psql(
        `SELECT COUNT(*)::int FROM public.${table} WHERE user_id = '${U_A}';`,
        ['-q', '-t', '-A'],
      ).trim();
      expect(
        still,
        `authenticated=B pudo modificar/borrar filas de A en ${table} (antes=${expectedA}, después=${still})`,
      ).toBe(expectedA);
    }
  });

  it('ficheros de migración listados existen y son al menos uno', () => {
    expect(migrationFiles.length, 'supabase/migrations está vacío o no existe').toBeGreaterThan(0);
    for (const f of migrationFiles) expect(fs.existsSync(f)).toBe(true);
  });
});
