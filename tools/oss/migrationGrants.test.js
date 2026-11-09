import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditMigrationGrants } from './migrationGrants.js';
const roots = [];
function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trazza-grants-'));
  roots.push(dir);
  for (const [file, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), sql);
  return auditMigrationGrants(dir);
}
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const f = 'CREATE FUNCTION public.f(p_id UUID) RETURNS integer LANGUAGE sql AS $$ SELECT 1; $$;';
const grant = 'GRANT EXECUTE ON FUNCTION public.f(UUID) TO authenticated;';
describe('C1 migration EXECUTE scanner — runtime fixtures', () => {
  it('explicit grant passes', () => { expect(fixture({ '001.sql': f + grant })).toEqual([]); });
  it('missing grant fails with file AND function', () => {
    expect(fixture({ '001.sql': f })).toEqual([expect.stringContaining('001.sql: public.f(uuid)')]);
  });
  it('explicit service_role exemption passes; must be adjacent, not an unrelated comment', () => {
    expect(fixture({ '001.sql': '-- grant-exempt: service_role\n' + f })).toEqual([]);
    expect(fixture({ '001.sql': '-- grant-exempt: service_role\nSELECT 1;\n' + f })).toHaveLength(1);
  });
  it('trigger returns exempt automatically; trigger marker on RPC is invalid', () => {
    expect(fixture({ '001.sql': 'CREATE FUNCTION f() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;' })).toEqual([]);
    expect(() => fixture({ '001.sql': '-- grant-exempt: trigger\n' + f })).toThrow('invalid trigger exemption');
  });
  it('later grants count; an earlier grant alone does not cover a new CREATE/REPLACE', () => {
    expect(fixture({ '001.sql': f, '002.sql': grant })).toEqual([]);
    expect(fixture({ '001.sql': f + grant, '002.sql': f.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION') })).toHaveLength(1);
  });
  it('overloads and quoted mixed-case names are separate identities', () => {
    expect(fixture({ '001.sql': f + 'CREATE FUNCTION public.f(text) RETURNS text AS $$ SELECT $1 $$ LANGUAGE sql;' + grant })).toEqual([expect.stringContaining('public.f(text)')]);
    const quoted = 'CREATE FUNCTION "public"."MixedCase"("p ID" INTEGER) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;';
    expect(fixture({ '001.sql': quoted + 'GRANT EXECUTE ON FUNCTION public."MixedCase"(int4) TO "authenticated";' })).toEqual([]);
    expect(fixture({ '001.sql': quoted + 'GRANT EXECUTE ON FUNCTION public.mixedcase(integer) TO authenticated;' })).toHaveLength(1);
  });
  it('normalizes modes, names, defaults, aliases, arrays and nested default commas', () => {
    expect(fixture({ '001.sql': `CREATE OR REPLACE FUNCTION F(IN p int4, INOUT q timestamptz,
      OUT ignored TEXT, VARIADIC tags varchar[]) RETURNS record LANGUAGE sql AS $$ SELECT 1 $$;
      GRANT EXECUTE ON FUNCTION PUBLIC.f(integer, timestamp with time zone, character varying[]) TO authenticated;` })).toEqual([]);
    expect(fixture({ '001.sql': `CREATE FUNCTION f(p numeric(10,2) DEFAULT round(1,2), q text DEFAULT 'a,b')
      RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
      GRANT EXECUTE ON FUNCTION f(numeric,text) TO authenticated;` })).toEqual([]);
  });
  it('supports quoted/schema-qualified user-defined parameter types', () => {
    expect(fixture({ '001.sql': `CREATE FUNCTION f(p public."MyType"[], "OtherType"[]) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
      GRANT EXECUTE ON FUNCTION f(public."MyType"[], "OtherType"[]) TO authenticated;` })).toEqual([]);
  });
  it('quoted parameter names may themselves match built-in type names', () => {
    expect(fixture({ '001.sql': `CREATE FUNCTION f("text" uuid, numeric integer) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
      GRANT EXECUTE ON FUNCTION f(uuid, int4) TO authenticated;` })).toEqual([]);
  });
  it('later REVOKE wins, unrelated roles do not; regrant repairs it', () => {
    const revoke = 'REVOKE EXECUTE ON FUNCTION f(uuid) FROM PUBLIC, authenticated;';
    expect(fixture({ '001.sql': f + grant, '002.sql': revoke })).toHaveLength(1);
    expect(fixture({ '001.sql': f + grant, '002.sql': revoke + grant })).toEqual([]);
    expect(fixture({ '001.sql': f + grant + 'REVOKE ALL ON FUNCTION f(uuid) FROM PUBLIC, anon;' })).toEqual([]);
    expect(fixture({ '001.sql': f + grant + 'REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION f(uuid) FROM authenticated;' })).toEqual([]);
  });
  it('schema-wide REVOKE invalidates grants; schema-wide GRANT is not an explicit signature grant', () => {
    expect(fixture({ '001.sql': f + grant + 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;' })).toHaveLength(1);
    expect(fixture({ '001.sql': f + 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;' })).toHaveLength(1);
  });
  it('DROP removes old requirements and DROP+CREATE loses previous grants', () => {
    expect(fixture({ '001.sql': f, '002.sql': 'DROP FUNCTION IF EXISTS public.f(uuid);' })).toEqual([]);
    expect(fixture({ '001.sql': f + grant, '002.sql': 'DROP FUNCTION f(uuid);' + f })).toHaveLength(1);
  });
  it('does not confuse comments, bodies or strings with executable grants', () => {
    expect(fixture({ '001.sql': f + `-- ${grant}\nSELECT '${grant}'; DO $body$ BEGIN RAISE NOTICE '${grant}'; END $body$;` })).toHaveLength(1);
    expect(fixture({ '001.sql': 'CREATE FUNCTION private.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;' })).toEqual([]);
  });
  it('handles multiple functions and grantees in a single privilege statement', () => {
    expect(fixture({ '001.sql': f + 'CREATE FUNCTION g() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;' +
      'GRANT EXECUTE ON FUNCTION public.f(uuid), g() TO service_role, authenticated;' })).toEqual([]);
  });
  it('service_role grant alone cannot mask a missing client grant or accidental revoke', () => {
    expect(fixture({ '001.sql': f + 'GRANT EXECUTE ON FUNCTION f(uuid) TO service_role;' })).toHaveLength(1);
  });
});
describe('C1 — repository migrations', () => {
  it('each surviving public function has an explicit client grant or documented exemption', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const failures = auditMigrationGrants(path.join(root, 'supabase/migrations'));
    expect(failures, failures.join('\n')).toEqual([]);
  });
});
