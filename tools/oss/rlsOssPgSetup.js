/**
 * Montaje Postgres local para tests RLS OSS (baseline + migraciones + fix opcional).
 * Solo Postgres embebido (initdb local) — nunca PGHOST remoto/CI en este harness.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startIsolatedRlsPg as startDisposablePg } from './pgPortLease.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations');

export const U_A = '11111111-1111-1111-1111-111111111111';
export const U_B = '22222222-2222-2222-2222-222222222222';

const PSQL_TUPLE = ['-q', '-t', '-A'];
const PSQL_ERROR_VERBOSE = ['-q', '-t', '-A', '-v', 'VERBOSITY=verbose'];

export const ROLE_BOOTSTRAP_SQL = `
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
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY,
  email text
);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT SELECT ON auth.users TO authenticated, service_role;
`;

/**
 * Arranca Postgres desechable local. Rechaza PGHOST (externo o CI) para no contaminar
 * clusters ajenos ni depender de red.
 * @returns {ReturnType<typeof startDisposablePg> | null}
 */
export function startEmbeddedRlsPg() {
  if (process.env.RLS_TEST_FIX_FILE !== undefined) {
    let exists = false;
    try { exists = Boolean(process.env.RLS_TEST_FIX_FILE) && fs.statSync(process.env.RLS_TEST_FIX_FILE).isFile(); } catch { /* fail below */ }
    if (!exists) throw new Error('RLS_TEST_FIX_FILE definido pero el fichero no existe o no es un fichero regular');
  }
  if (process.env.PGHOST) {
    const h = process.env.PGHOST.trim();
    const local = h === 'localhost' || h === '127.0.0.1' || h === '';
    if (!local) {
      throw new Error(
        `RLS harness embebido rechaza PGHOST=${h}: desactiva PGHOST o usa initdb local (PG_BIN)`,
      );
    }
  }
  return startDisposablePg();
}

export function findBaselineFiles() {
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

export function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => path.join(MIGRATIONS_DIR, f));
}

const BASELINE_MISSING_MSG = 'falta baseline: supabase/baseline/schema.sql (u otros bajo supabase/baseline/)';

/** Última línea no vacía de stdout psql (-t -A), evita basura de NOTICE/SET. */
export function lastPsqlField(stdout) {
  const lines = String(stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

/**
 * Denegación por REVOKE / falta de privilegio de tabla (p. ej. anon en email_sends).
 * No sustituye 42501 en INSERT/UPDATE bajo RLS.
 */
export function isTablePrivilegeDenied(err) {
  const msg = `${err?.stderr || ''}${err?.message || ''}`;
  return /permission denied for (table|schema)/i.test(msg) && !/42501/.test(msg);
}

/** Denegación RLS/policy: exige SQLSTATE 42501 (psql VERBOSITY=verbose). */
export function isRlsPolicySqlState42501(err) {
  const msg = `${err?.stderr || ''}${err?.message || ''}`;
  return /SQLSTATE\[42501\]|(?:\b|:)42501\b/.test(msg);
}

/** @deprecated nombre histórico; usar isRlsPolicySqlState42501 o isTablePrivilegeDenied */
export function isRlsDeniedError(err) {
  return isRlsPolicySqlState42501(err) || isTablePrivilegeDenied(err);
}

function wrapAuthenticatedTransaction(userId, bodySql, withVerboseErrors) {
  const jwt = userId.replace(/'/g, "''");
  const verbosity = withVerboseErrors ? 'SET LOCAL client_min_messages = notice;\n' : '';
  return `
BEGIN;
${verbosity}
DO $$ BEGIN PERFORM set_config('request.jwt.claim.sub', '${jwt}', true); END $$;
SET ROLE authenticated;
${bodySql}
COMMIT;
`;
}

/** @returns {{ pg: import('../../server/lib/pg20261026.harness.js').startTestPg extends () => infer R ? R : never, setupError: string | null, fixApplied: boolean }} */
export function mountOssRlsDatabase(options = {}) {
  const baselineFiles = findBaselineFiles();
  if (!baselineFiles) {
    return { pg: null, setupError: BASELINE_MISSING_MSG, fixApplied: false };
  }
  let pg;
  try {
    pg = startEmbeddedRlsPg();
  } catch (e) {
    return { pg: null, setupError: e.message, fixApplied: false };
  }
  if (!pg) {
    return {
      pg: null,
      setupError: 'no se pudo arrancar Postgres embebido (define PG_BIN con initdb/psql locales)',
      fixApplied: false,
    };
  }
  let setupError = null;
  let fixApplied = false;
  try {
    pg.psql(ROLE_BOOTSTRAP_SQL);
    for (const f of baselineFiles) pg.psqlFile(f);
    for (const f of listMigrationFiles()) pg.psqlFile(f);
    if (typeof options.extraSql === 'string' && options.extraSql.trim()) {
      pg.psql(options.extraSql);
    }
    if (typeof options.extraSqlFile === 'string' && fs.existsSync(options.extraSqlFile)) {
      pg.psqlFile(options.extraSqlFile);
    }
    const fixEnv = process.env.RLS_TEST_FIX_FILE;
    if (fixEnv !== undefined) {
      pg.psqlFile(fixEnv);
      fixApplied = true;
    }
  } catch (e) {
    setupError = `fallo aplicando baseline + migraciones: ${e.stderr || e.message}`;
  }
  return { pg, setupError, fixApplied };
}

/**
 * Ejecuta SQL como authenticated con JWT simulado dentro de una transacción.
 * set_config va en DO PERFORM para no mezclar su salida con SELECT COUNT.
 */
export function runAsAuthenticated(pg, userId, bodySql, extraPsqlArgs = PSQL_TUPLE) {
  const sql = wrapAuthenticatedTransaction(userId, bodySql, false);
  return lastPsqlField(pg.psql(sql, extraPsqlArgs));
}

/**
 * Igual que runAsAuthenticated pero propaga error (esperado 42501 en escrituras maliciosas).
 */
export function runAsAuthenticatedExpectError(pg, userId, bodySql) {
  const sql = wrapAuthenticatedTransaction(userId, bodySql, true);
  return pg.psql(sql, PSQL_ERROR_VERBOSE);
}

/** SELECT COUNT como authenticated; privilege denied en SELECT cuenta como 0 visible. */
export function authenticatedSelectCount(pg, userId, table, whereClause = '') {
  try {
    return runAsAuthenticated(
      pg,
      userId,
      `SELECT COUNT(*)::int FROM public.${table} ${whereClause};`,
    );
  } catch (e) {
    if (isTablePrivilegeDenied(e)) return '0';
    throw e;
  }
}

/**
 * Semillas y fixtures: siempre superuser (pg.psql sin SET ROLE).
 * service_role no tiene INSERT en auth.users y no debe recibir GRANT extra que oculte eso.
 */
export function seedAsSuperuser(pg, bodySql, extraPsqlArgs = ['-q']) {
  return pg.psql(bodySql, extraPsqlArgs);
}

export function runAsServiceRole(pg, bodySql, extraPsqlArgs = PSQL_TUPLE) {
  const sql = `
BEGIN;
SET ROLE service_role;
${bodySql}
COMMIT;
`;
  return lastPsqlField(pg.psql(sql, extraPsqlArgs));
}
