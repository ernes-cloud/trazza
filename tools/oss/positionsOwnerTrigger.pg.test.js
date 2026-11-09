import { pgDescribe } from './pgTestMode.js';
import { verifyCoreFixtureSchema, verifyCoreFixtureRows } from './pgFixtureContract.js';
/** Defense in depth: broker and portfolio must have the same owner even when
 * service_role bypasses RLS. D5 catalog: broker_id, portfolio_id and entry_price are NOT NULL;
 * NULL cases assert schema rejection, never imaginary successful writes.
 * Review: prod-rls-fix-review.md, recommendation 1. Embedded Postgres only.
 */
import { describe, it as vitestIt, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  mountOssRlsDatabase, seedAsSuperuser, U_A, U_B,
  runAsAuthenticatedExpectError, runAsServiceRole,
} from './rlsOssPgSetup.js';
const describePg = pgDescribe(describe);
const ASSET = 'aa777777-7777-7777-7777-777777777777';
const BA = 'ba777777-7777-7777-7777-777777777777';
const BB = 'bb777777-7777-7777-7777-777777777777';
const PA = 'fa777777-7777-7777-7777-777777777777';
const PB = 'fb777777-7777-7777-7777-777777777777';
const OWN = '0a777777-7777-7777-7777-777777777777';
const EXTRA = '0e777777-7777-7777-7777-777777777777';
const literal = (v) => v === null ? 'NULL' : `'${v}'`;

describePg('positions owner-coherence trigger — including BYPASSRLS', () => {
  let pg; let setupError = null;
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

  function ready() { expect(setupError, setupError || 'embedded setup OK').toBeNull(); expect(pg).toBeTruthy(); }
  function stored(id = OWN) {
    return pg.psql(`SELECT COALESCE(broker_id::text, 'NULL') || '|' || COALESCE(portfolio_id::text, 'NULL')
      FROM public.positions WHERE id = '${id}';`, ['-q', '-t', '-A']).trim();
  }
  function run(role, sql) {
    return role === 'authenticated'
      ? runAsAuthenticatedExpectError(pg, U_A, sql)
      : runAsServiceRole(pg, sql, ['-q', '-t', '-A', '-v', 'VERBOSITY=verbose']);
  }
  function rejected(role, sql, { bothNull = false } = {}) {
    let error;
    try { run(role, sql); } catch (e) { error = e; }
    expect(error, 'la escritura debe rechazarse; RLS no basta para service_role').toBeTruthy();
    const stderr = String(error?.stderr || error?.message || '');
    const state = stderr.match(/ERROR:\s+([0-9A-Z]{5}):/)?.[1];
    // No privilege-denied false greens. For service_role the trigger itself
    // must report an integrity/generic trigger error, never an RLS error.
    const allowed = bothNull ? ['23514']
      : role === 'authenticated' ? ['42501', '23514', 'P0001'] : ['23514', 'P0001'];
    expect(allowed, stderr).toContain(state);
    if (!bothNull && state !== '42501') {
      const message = stderr.match(/ERROR:\s+[0-9A-Z]{5}:\s*([^\r\n]*)/)?.[1] || '';
      expect(message).not.toBe('');
      expect(message, 'mensaje público genérico, sin propietarios/UUID/email').not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\S+@\S+/i,
      );
    }
  }
  beforeAll(() => {
    if (process.env.PG_TESTS !== '1') { setupError = 'PG_TESTS=1 required'; return; }
    try {
    const mounted = mountOssRlsDatabase();
    pg = mounted.pg; setupError = mounted.setupError;
    if (setupError || !pg) return;
    verifyCoreFixtureSchema(pg);
    seedAsSuperuser(pg, `
      INSERT INTO auth.users (id, email) VALUES ('${U_A}', 'a@example.com'), ('${U_B}', 'b@example.com');
      INSERT INTO public.assets (id, ticker, company_name) VALUES ('${ASSET}', 'OWNERTRG', 'Trigger fixture');
      INSERT INTO public.brokers (id, user_id, name) VALUES ('${BA}', '${U_A}', 'A'), ('${BB}', '${U_B}', 'B');
      INSERT INTO public.portfolios (id, user_id, name) VALUES ('${PA}', '${U_A}', 'A'), ('${PB}', '${U_B}', 'B');
    `);
    } catch (e) { setupError = `fixture setup failed: ${e.stderr || e.message}`; }
  });
  beforeEach(() => {
    try {
    if (setupError || !pg) return;
    seedAsSuperuser(pg, `DELETE FROM public.positions WHERE asset_id = '${ASSET}';
      INSERT INTO public.positions (entry_price, id, asset_id, broker_id, portfolio_id, quantity)
      VALUES (10, '${OWN}', '${ASSET}', '${BA}', '${PA}', 1);`);
    verifyCoreFixtureRows(pg, 1);
    } catch (e) { setupError = `fixture reset failed: ${e.stderr || e.message}`; }
  });
  afterAll(() => {
    try { expect(executedCases, 'minimum executed cases: no hook-induced skips').toBeGreaterThanOrEqual(22); }
    finally { pg?.stop(); }
  });

  it('has a BEFORE INSERT/UPDATE trigger, invoker function and empty search_path', () => {
    ready();
    const count = pg.psql(`SELECT COUNT(*) FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = 'public.positions'::regclass AND NOT t.tgisinternal
        AND (t.tgtype::int & 23) = 23 AND t.tgenabled IN ('O', 'A')
        AND NOT p.prosecdef AND 'search_path=""' = ANY(p.proconfig)
        AND (t.tgattr::text = '' OR
          (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
           FROM pg_attribute a WHERE a.attrelid = t.tgrelid AND a.attnum = ANY(t.tgattr::smallint[]))
          = ARRAY['broker_id', 'portfolio_id']::text[]);`, ['-q', '-t', '-A']).trim();
    expect(Number(count), 'falta trigger invoker BEFORE INSERT/UPDATE con search_path vacío').toBeGreaterThan(0);
  });
  it('service_role really bypasses RLS and sees both owners (anti false-green)', () => {
    ready();
    expect(runAsServiceRole(pg, `SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user;`)).toBe('t');
    expect(runAsServiceRole(pg, `SELECT COUNT(*) FROM public.brokers WHERE id IN ('${BA}', '${BB}');`)).toBe('2');
    expect(runAsServiceRole(pg, `SELECT COUNT(*) FROM public.portfolios WHERE id IN ('${PA}', '${PB}');`)).toBe('2');
  });

  for (const role of ['authenticated', 'service_role']) {
    for (const [label, broker, portfolio] of [['broker A + cartera B', BA, PB], ['broker B + cartera A', BB, PA]]) {
      it(`${role}: INSERT rechaza ${label}`, () => {
        ready();
        rejected(role, `INSERT INTO public.positions (entry_price, id, asset_id, broker_id, portfolio_id, quantity)
          VALUES (10, '${EXTRA}', '${ASSET}', '${broker}', '${portfolio}', 2);`);
        expect(stored(EXTRA)).toBe('');
      });
    }
    for (const [column, target] of [['broker_id', BB], ['portfolio_id', PB]]) {
      it(`${role}: UPDATE ${column} rechaza otro propietario`, () => {
        ready(); rejected(role, `UPDATE public.positions SET ${column} = '${target}' WHERE id = '${OWN}';`);
        expect(stored()).toBe(`${BA}|${PA}`);
      });
    }
    for (const column of ['broker_id', 'portfolio_id']) {
      for (const operation of ['INSERT', 'UPDATE']) {
        it(`${role}: ${operation} ${column}=NULL viola NOT NULL`, () => {
          ready();
          const broker = column === 'broker_id' ? null : BA;
          const portfolio = column === 'portfolio_id' ? null : PA;
          // service_role isolates the schema constraint. authenticated may
          // reject the row earlier via RLS, which is also fail-closed.
          const sql = operation === 'INSERT'
            ? `INSERT INTO public.positions (entry_price, id, asset_id, broker_id, portfolio_id, quantity)
               VALUES (10, '${EXTRA}', '${ASSET}', ${literal(broker)}, ${literal(portfolio)}, 2);`
            : `UPDATE public.positions SET ${column} = NULL WHERE id = '${OWN}';`;
          let error;
          try { run(role, sql); } catch (e) { error = e; }
          expect(error, 'NULL debe rechazarse, nunca saltar el test').toBeTruthy();
          const state = String(error?.stderr || error?.message).match(/ERROR:\s+([0-9A-Z]{5}):/)?.[1];
          expect(role === 'service_role' ? ['23502'] : ['23502', '42501']).toContain(state);
          expect(stored()).toBe(`${BA}|${PA}`);
          expect(stored(EXTRA)).toBe('');
        });
      }
    }
    it(`${role}: INSERT coherente pasa`, () => {
      ready();
      run(role, `INSERT INTO public.positions (entry_price, id, asset_id, broker_id, portfolio_id, quantity)
        VALUES (10, '${EXTRA}', '${ASSET}', '${BA}', '${PA}', 2);`);
      expect(stored(EXTRA)).toBe(`${BA}|${PA}`);
    });
    it(`${role}: UPDATE conjunto coherente pasa`, () => {
      ready();
      run(role, `UPDATE public.positions SET broker_id = '${BA}', portfolio_id = '${PA}', quantity = 5 WHERE id = '${OWN}';`);
      expect(pg.psql(`SELECT quantity::int FROM public.positions WHERE id = '${OWN}';`, ['-q', '-t', '-A']).trim()).toBe('5');
    });
  }
});
