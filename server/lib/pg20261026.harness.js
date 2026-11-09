/**
 * Postgres para las migraciones 20261026–028.
 *
 * Con PG_TESTS=1:
 *   - Si hay PGHOST (p. ej. service postgres:16 en CI), conecta a ese cluster
 *     y crea una base desechable.
 *   - Si no, initdb en /tmp con binarios de PG_BIN (o rutas del sistema).
 *     NUNCA descarga .deb ni ejecuta apt-get: sin binarios → skip/null.
 *
 * Sin PG_TESTS=1 los tests que importan este módulo deben hacer describe.skip
 * (no arrancar nada ni fallar por falta de psql).
 */
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SYS = '/usr/lib/postgresql/16';

/**
 * Directorios candidatos a binarios PG (initdb/postgres/pg_ctl/psql).
 * PG_BIN gana (ruta completa al directorio `bin`, p. ej.
 * /tmp/pg16-extract/usr/lib/postgresql/16/bin). Sin apt-get download.
 */
function binSearchRoots() {
  const roots = [];
  if (process.env.PG_BIN) roots.push(process.env.PG_BIN);
  roots.push(`${SYS}/bin`, '/usr/bin');
  return roots;
}

function bin(name) {
  for (const base of binSearchRoots()) {
    const p = path.join(base, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function postgresBins() {
  const initdb = bin('initdb');
  const postgres = bin('postgres');
  const pgCtl = bin('pg_ctl');
  const psql = bin('psql');
  if (!initdb || !pgCtl || !psql) return null;
  // `postgres` vive en el paquete server; sin él initdb sirve pero no arranca.
  if (!postgres && !fs.existsSync(path.join(path.dirname(pgCtl), 'postgres'))) return null;
  return { initdb, pgCtl, psql, lib: path.join(path.dirname(path.dirname(pgCtl)), 'lib') };
}

/**
 * Resuelve binarios locales. No descarga nada: si faltan, null (el test
 * hace skip o falla con mensaje claro). CI usa el servicio postgres:16.
 */
export function ensureExtractedServer() {
  return postgresBins();
}

/** Solo hace falta `psql` cuando el cluster ya lo aporta PGHOST (CI). */
export function resolvePsql() {
  return bin('psql') || 'psql';
}

/** Stubs mínimos de roles/esquema Supabase + tablas que tocan las migraciones. */
export const STUB_SQL = `
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
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

CREATE TABLE IF NOT EXISTS public.assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker text,
  company_name text NOT NULL,
  isin text,
  sector text,
  industry text,
  country text,
  asset_class text,
  currency text NOT NULL DEFAULT 'USD',
  current_price numeric
);
-- En producción ya existe assets_ticker_key; el stub lo omite a propósito
-- para que la FASE 1 (CREATE UNIQUE INDEX IF NOT EXISTS) lo cree.

CREATE TABLE IF NOT EXISTS public.brokers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text
);
CREATE TABLE IF NOT EXISTS public.portfolios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text
);
CREATE TABLE IF NOT EXISTS public.positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid REFERENCES public.assets(id),
  broker_id uuid REFERENCES public.brokers(id),
  portfolio_id uuid REFERENCES public.portfolios(id),
  quantity numeric DEFAULT 0
);
CREATE TABLE IF NOT EXISTS public.ticker_mappings (
  isin text PRIMARY KEY,
  ticker text NOT NULL,
  source text,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.ticker_mappings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticker_mappings_select ON public.ticker_mappings;
DROP POLICY IF EXISTS ticker_mappings_insert ON public.ticker_mappings;
DROP POLICY IF EXISTS ticker_mappings_update ON public.ticker_mappings;
CREATE POLICY ticker_mappings_select ON public.ticker_mappings FOR SELECT TO authenticated USING (true);
CREATE POLICY ticker_mappings_insert ON public.ticker_mappings FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY ticker_mappings_update ON public.ticker_mappings FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ticker_mappings TO authenticated, anon, service_role;
ALTER TABLE public.assets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "assets_select_authenticated" ON public.assets;
DROP POLICY IF EXISTS "assets_insert_authenticated" ON public.assets;
CREATE POLICY "assets_select_authenticated"
  ON public.assets FOR SELECT TO authenticated USING (true);
CREATE POLICY "assets_insert_authenticated"
  ON public.assets FOR INSERT TO authenticated WITH CHECK (true);
-- Grants residuales como en prod (default privileges ALL): el REVOKE de la
-- migración 20261029000300 debe poder probarse (UPDATE/REFERENCES/TRIGGER + SELECT anon).
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON public.assets TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assets TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.brokers, public.portfolios, public.positions TO authenticated, service_role;

-- email_sends: grants iniciales a anon/authenticated para que el REVOKE se pueda probar.
CREATE TABLE IF NOT EXISTS public.email_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL DEFAULT 'test',
  recipient text NOT NULL DEFAULT 'x@example.com',
  status text NOT NULL DEFAULT 'sent',
  provider text NOT NULL DEFAULT 'resend',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.email_sends ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.email_sends TO anon, authenticated, service_role;

-- Función vieja (pre-migración): authenticated + SECURITY DEFINER, sin guard.
CREATE OR REPLACE FUNCTION public.update_asset_market_data(
  p_asset_id UUID,
  p_current_price NUMERIC DEFAULT NULL,
  p_company_name TEXT DEFAULT NULL,
  p_isin TEXT DEFAULT NULL,
  p_sector TEXT DEFAULT NULL,
  p_industry TEXT DEFAULT NULL,
  p_country TEXT DEFAULT NULL,
  p_asset_class TEXT DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  UPDATE assets SET current_price = COALESCE(p_current_price, current_price) WHERE id = p_asset_id;
END;
$$;
REVOKE ALL ON FUNCTION public.update_asset_market_data(uuid, numeric, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_asset_market_data(uuid, numeric, text, text, text, text, text, text) TO authenticated;
`;

function makePsqlRunner(psqlBin, connectArgs, env) {
  const psql = (sql, extraArgs = []) => {
    const r = spawnSync(
      psqlBin,
      [...connectArgs, '-v', 'ON_ERROR_STOP=1', ...extraArgs, '-c', sql],
      { env, encoding: 'utf8' },
    );
    if (r.status !== 0) {
      const err = new Error(r.stderr || r.stdout || 'psql failed');
      err.stdout = r.stdout;
      err.stderr = r.stderr;
      throw err;
    }
    return r.stdout;
  };
  const psqlFile = (file) => {
    const r = spawnSync(
      psqlBin,
      [...connectArgs, '-v', 'ON_ERROR_STOP=1', '-f', file],
      { env, encoding: 'utf8' },
    );
    if (r.status !== 0) {
      const err = new Error(r.stderr || r.stdout || `psql -f ${file} failed`);
      err.stdout = r.stdout;
      err.stderr = r.stderr;
      throw err;
    }
    return r.stdout;
  };
  return { psql, psqlFile };
}

/** Cluster ya levantado (CI: services postgres:16 → PGHOST=postgres). */
export function connectEnvPg() {
  const host = process.env.PGHOST;
  if (!host) return null;
  const port = process.env.PGPORT || '5432';
  const user = process.env.PGUSER || 'postgres';
  const password = process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || '';
  const adminDb = process.env.PGDATABASE || 'postgres';
  const psqlBin = resolvePsql();
  const env = { ...process.env, PGPASSWORD: password };
  const dbName = `tzz_mig_${process.pid}_${Date.now().toString(36)}`;

  const adminArgs = ['-h', host, '-p', String(port), '-U', user, '-d', adminDb];
  const created = spawnSync(
    psqlBin,
    [...adminArgs, '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${dbName}`],
    { env, encoding: 'utf8' },
  );
  if (created.status !== 0) {
    throw new Error(created.stderr || created.stdout || `CREATE DATABASE ${dbName} failed`);
  }

  const connectArgs = ['-h', host, '-p', String(port), '-U', user, '-d', dbName];
  const { psql, psqlFile } = makePsqlRunner(psqlBin, connectArgs, env);
  const stop = () => {
    spawnSync(
      psqlBin,
      [...adminArgs, '-c', `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`],
      { env, encoding: 'utf8' },
    );
  };
  return { port: Number(port), dataDir: null, psql, psqlFile, stop, bins: { psql: psqlBin }, via: 'env' };
}

/** Puerto libre distinto de 5299/4299 (reservados a otro agente en trazza-tdd). */
function pickLocalPgPort(preferred) {
  const blocked = new Set([5299, 4299]);
  let p = preferred;
  while (blocked.has(p)) p += 1;
  return p;
}

export function startDisposablePg(port = 55433) {
  port = pickLocalPgPort(port);
  const bins = ensureExtractedServer();
  if (!bins) return null;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg16-r17-'));
  const env = { ...process.env, LD_LIBRARY_PATH: `${bins.lib}${process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : ''}` };
  execFileSync(bins.initdb, ['-D', dataDir, '-U', 'postgres', '--no-sync', '-A', 'trust'], { env, stdio: 'pipe' });
  // unix_socket_directories = dataDir so we don't need /var/run/postgresql
  fs.appendFileSync(path.join(dataDir, 'postgresql.conf'), `\nunix_socket_directories = '${dataDir}'\nlisten_addresses = '127.0.0.1'\nport = ${port}\n`);
  execFileSync(bins.pgCtl, ['-D', dataDir, '-l', path.join(dataDir, 'log'), 'start'], { env, stdio: 'pipe' });
  const connectArgs = ['-h', dataDir, '-p', String(port), '-U', 'postgres'];
  const { psql, psqlFile } = makePsqlRunner(bins.psql, connectArgs, env);
  const stop = () => {
    try { execFileSync(bins.pgCtl, ['-D', dataDir, 'stop', '-m', 'fast'], { env, stdio: 'pipe' }); } catch { /* already down */ }
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { port, dataDir, psql, psqlFile, stop, bins, via: 'local' };
}

/** Preferencia: PGHOST del entorno; si no, Postgres 16 desechable en /tmp. */
export function startTestPg(port = 55433 + Math.floor(Math.random() * 1000)) {
  if (process.env.PGHOST) return connectEnvPg();
  return startDisposablePg(port);
}

export const MIGRATIONS = {
  asset: path.join(ROOT, 'supabase/migrations/20261026000100_asset_market_data_service_role.sql'),
  ticker: path.join(ROOT, 'supabase/migrations/20261026000200_ticker_mappings_server_only.sql'),
  assetsInsert: path.join(ROOT, 'supabase/migrations/20261027000100_assets_insert_server_only.sql'),
  assetsInsertRevoke: path.join(ROOT, 'supabase/migrations/20261029000300_assets_insert_revoke.sql'),
  forceAssetPrice: path.join(ROOT, 'supabase/migrations/20261028000100_force_asset_price.sql'),
  emailSendsRevoke: path.join(ROOT, 'supabase/migrations/20261028000200_email_sends_revoke.sql'),
};
