/**
 * P0-1 bloque 3 (PG): aplica las migraciones del export en un Postgres
 * desechable y comprueba que existen expense_entries, expense_projects,
 * savings_goals y user_preferences con RLS, y que la política y los GRANT
 * de P0-2 siguen presentes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgDescribe } from './pgTestMode.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  startEmbeddedRlsPg,
  ROLE_BOOTSTRAP_SQL,
  lastPsqlField,
} from './rlsOssPgSetup.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const EXPORT_SCRIPT = path.join(ROOT, 'tools/oss/export-oss.mjs');
const TABLES = ['expense_entries', 'expense_projects', 'savings_goals', 'user_preferences'];
const POLICY_BY_TABLE = {
  expense_entries: 'users manage own expense_entries',
  expense_projects: 'users manage own expense_projects',
  savings_goals: 'users manage own savings_goals',
  user_preferences: 'user_preferences_own_user',
};
const REQUIRED_GRANTS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

const describePg = pgDescribe(describe);

const tmpDirs = [];
let exportDir = null;
let pg = null;
let applyError = null;

function mkTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function listSql(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => path.join(dir, f));
}

function findBaselineFiles(root) {
  const single = [
    path.join(root, 'supabase/baseline/schema.sql'),
    path.join(root, 'supabase/baseline.sql'),
  ];
  for (const f of single) {
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return [f];
  }
  const dir = path.join(root, 'supabase/baseline');
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    const files = listSql(dir);
    if (files.length) return files;
  }
  return [];
}

beforeAll(() => {
  if (process.env.PG_TESTS !== '1') {
    applyError = 'PG_TESTS=1 required';
    return;
  }
  // Si el árbol bajo test ya es un export (sin .git, o con docs/gastos.md
  // generado), se aplican sus migraciones tal cual. En el repo fuente se
  // rehace el export para incluir el filtro de oss_remove_modules.
  const alreadyExport = !fs.existsSync(path.join(ROOT, '.git'));
  if (alreadyExport) {
    exportDir = ROOT;
  } else {
    const hashesFile = path.join(mkTmp('oss-p01-pg-hashes-'), 'hashes.txt');
    fs.writeFileSync(hashesFile, '');
    exportDir = mkTmp('oss-p01-pg-export-');
    const r = spawnSync(process.execPath, [EXPORT_SCRIPT, exportDir, '--hashes', hashesFile], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, OSS_FORBIDDEN_HASHES_FILE: hashesFile },
    });
    if (r.status !== 0 || !fs.existsSync(exportDir)) {
      applyError = `export-oss falló (status=${r.status})`;
      return;
    }
  }
  try {
    pg = startEmbeddedRlsPg();
  } catch (e) {
    applyError = e.message;
    return;
  }
  if (!pg) {
    applyError = 'no se pudo arrancar Postgres embebido (define PG_BIN con initdb/psql locales)';
    return;
  }
  try {
    pg.psql(ROLE_BOOTSTRAP_SQL);
    for (const f of findBaselineFiles(exportDir)) pg.psqlFile(f);
    const migDir = path.join(exportDir, 'supabase/migrations');
    for (const f of listSql(migDir)) pg.psqlFile(f);
  } catch (e) {
    applyError = `fallo aplicando baseline + migraciones del export: ${e.stderr || e.message}`;
  }
}, 240_000);

afterAll(() => {
  try { pg?.stop?.(); } catch { /* ignore */ }
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function q(sql) {
  return lastPsqlField(pg.psql(sql, ['-q', '-t', '-A']));
}

describePg('P0-1 bloque 3 — migraciones del export en PG desechable', () => {
  it('el montaje aplica las migraciones del export sin error de setup', () => {
    expect(applyError, applyError || 'montaje OK').toBeNull();
    expect(pg, 'no hay Postgres desechable').toBeTruthy();
  });

  for (const table of TABLES) {
    it(`existe public.${table}`, () => {
      expect(applyError, applyError || 'montaje OK').toBeNull();
      const exists = q(`
        SELECT COALESCE((
          SELECT '1' FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = '${table}' AND c.relkind = 'r'
        ), '0');
      `);
      expect(exists, `no existe public.${table} tras aplicar las migraciones del export`).toBe('1');
    });

    it(`public.${table} tiene RLS habilitado`, () => {
      expect(applyError, applyError || 'montaje OK').toBeNull();
      const rls = q(`
        SELECT COALESCE((
          SELECT CASE WHEN c.relrowsecurity THEN '1' ELSE '0' END
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = '${table}' AND c.relkind = 'r'
        ), 'missing');
      `);
      expect(rls, `RLS no está habilitado en public.${table}`).toBe('1');
    });

    it(`public.${table} conserva la política P0-2 TO authenticated`, () => {
      expect(applyError, applyError || 'montaje OK').toBeNull();
      const expected = POLICY_BY_TABLE[table];
      const found = q(`
        SELECT COALESCE((
          SELECT string_agg(pol.polname, ',')
          FROM pg_policy pol
          JOIN pg_class c ON c.oid = pol.polrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = '${table}'
        ), '');
      `);
      expect(
        found.split(',').includes(expected),
        `falta la política P0-2 "${expected}" en public.${table}`,
      ).toBe(true);
      const roles = q(`
        SELECT COALESCE((
          SELECT string_agg(DISTINCT r.rolname, ',')
          FROM pg_policy pol
          JOIN pg_class c ON c.oid = pol.polrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_roles r ON r.oid = ANY (pol.polroles)
          WHERE n.nspname = 'public' AND c.relname = '${table}'
            AND pol.polname = '${expected.replaceAll("'", "''")}'
        ), '');
      `);
      expect(roles.split(',').includes('authenticated'), `la política ${expected} no está TO authenticated`).toBe(true);
    });

    it(`public.${table} conserva GRANT SIDU a authenticated (P0-2)`, () => {
      expect(applyError, applyError || 'montaje OK').toBeNull();
      const grants = q(`
        SELECT COALESCE((
          SELECT string_agg(privilege_type, ',' ORDER BY privilege_type)
          FROM information_schema.role_table_grants
          WHERE table_schema = 'public'
            AND table_name = '${table}'
            AND grantee = 'authenticated'
        ), '');
      `);
      const have = new Set(grants.split(',').filter(Boolean));
      const missing = REQUIRED_GRANTS.filter((p) => !have.has(p));
      expect(missing, `faltan GRANT P0-2 en public.${table} para authenticated: ${missing.join(', ')}`).toEqual([]);
    });
  }
});
