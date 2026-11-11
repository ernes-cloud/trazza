/**
 * P0-2 seguridad de Gastos: RLS aislado, FK de pertenencia, policies/GRANTs.
 *
 * Sobre las migraciones publicadas de developSecond los casos de aislamiento
 * por auth.uid() pueden estar verdes; policies TO PUBLIC, GRANTs no versionados
 * y FKs sin pertenencia deben quedar rojos por esa razón (no por un fallo de
 * montaje). La describe «candidato» aplica un SQL externo de verificación y
 * debe poner verdes policies, GRANTs vivos y FKs — sin commitear ese SQL.
 *
 * PG_TESTS=1 · Postgres embebido local.
 */
import { describe, it as vitestIt, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  mountGastosDatabase,
  resolveFixFile,
  resetFixtures,
  seedWithReplicaInTransaction,
  runAsAuthenticated,
  runAsAuthenticatedExpectError,
  runAsAnon,
  runAsAnonExpectError,
  authenticatedSelectCount,
  seedAsSuperuser,
  isRlsPolicySqlState42501,
  isRlsPolicyViolation,
  isOwnershipRejection,
  isTablePrivilegeDenied,
  lastPsqlField,
  PSQL_TUPLE,
  publishedGrantMentions,
  migrationSqlCorpus,
  GASTOS_TABLES,
  U_A,
  U_B,
  GOAL_A,
  GOAL_B,
  PROJECT_A,
  PROJECT_B,
  ENTRY_A,
  ENTRY_B,
  TPL_A,
  TPL_B,
} from './gastosPgSetup.js';

const runPg = process.env.PG_TESTS === '1';
const describePg = runPg ? describe : describe.skip;

function expectSetup(setupError) {
  expect(setupError, setupError || 'montaje OK').toBeNull();
}

function catchRun(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}

function expectRlsWriteDenied(err, label) {
  expect(err, `${label}: se esperaba fallo de escritura, no éxito`).not.toBeNull();
  expect(
    isRlsPolicySqlState42501(err),
    `${label}: INSERT/UPDATE debe ser SQLSTATE 42501 (VERBOSE), no un error de setup: ${err?.stderr || err?.message}`,
  ).toBe(true);
}

function expectOwnershipDenied(err, label) {
  expect(err, `${label}: se esperaba rechazo de FK ajena, no éxito`).not.toBeNull();
  expect(
    isOwnershipRejection(err),
    `${label}: debe rechazarse con SQLSTATE 42501 (VERBOSE), no un error de setup ni otro código (23514/P0001/23503): ${err?.stderr || err?.message}`,
  ).toBe(true);
}

function superCount(pg, sql) {
  return lastPsqlField(pg.psql(sql, PSQL_TUPLE));
}

function assertAuthenticatedNoBypass(pg) {
  const flag = lastPsqlField(pg.psql(
    `SELECT rolbypassrls::text FROM pg_roles WHERE rolname = 'authenticated';`,
    PSQL_TUPLE,
  ));
  expect(flag).toBe('false');
}

function registerSuite({ title, applyFix }) {
  describePg(title, () => {
    let pg;
    let setupError = null;
    let privilegesBeforeFixtureGrants = {};
    let policies = [];
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

    /** Comprobaciones sobre supabase/migrations: el SQL candidato no cuenta. */
    function itPublished(name, body) {
      if (applyFix) {
        vitestIt.skip(name, body);
        return;
      }
      it(name, body);
    }

    beforeAll(() => {
      if (process.env.PG_TESTS !== '1') {
        setupError = 'PG_TESTS=1 required';
        return;
      }
      if (applyFix && !resolveFixFile()) {
        setupError = 'falta GASTOS_P0_FIX_FILE / tdd-gastos-verify/p0-2-rls-fk-candidate.sql';
        return;
      }
      const mounted = mountGastosDatabase({ applyFix, fixtureGrants: true });
      pg = mounted.pg;
      setupError = mounted.setupError;
      privilegesBeforeFixtureGrants = mounted.privilegesBeforeFixtureGrants || {};
      policies = mounted.policies || [];
    });

    afterAll(() => {
      try {
        if (!setupError && pg) {
          expect(executedCases, 'minimum executed cases: no hook-induced skips').toBeGreaterThanOrEqual(1);
        }
      } finally {
        pg?.stop();
      }
    });

    beforeEach(() => {
      if (setupError || !pg) return;
      try {
        resetFixtures(pg);
      } catch (e) {
        setupError = `fixture reset failed: ${e.stderr || e.message}`;
      }
    });

    // ── montaje / rol ────────────────────────────────────────────────────────
    describe('P0-2 RLS', () => {
      it('montaje de migraciones publicadas (y fix opcional) sin error de setup', () => {
        expectSetup(setupError);
        assertAuthenticatedNoBypass(pg);
      });

      it('el modo replica solo vive en la transacción de siembra y acaba en origin', () => {
        seedWithReplicaInTransaction(pg, 'SELECT 1;');
        const role = lastPsqlField(pg.psql(
          `SELECT current_setting('session_replication_role');`,
          PSQL_TUPLE,
        ));
        expect(role).toBe('origin');
      });

      it('usuario B, authenticated y sin BYPASSRLS, no lee expense_entries de A', () => {
        expect(authenticatedSelectCount(pg, U_B, 'expense_entries', `WHERE id = '${ENTRY_A}'`)).toBe('0');
        expect(authenticatedSelectCount(pg, U_B, 'expense_entries', `WHERE user_id = '${U_A}'`)).toBe('0');
        expect(authenticatedSelectCount(pg, U_B, 'expense_entries', `WHERE id = '${ENTRY_B}'`)).toBe('1');
      });

      it('usuario B no inserta expense_entries de A (42501)', () => {
        const err = catchRun(() => runAsAuthenticatedExpectError(pg, U_B, `
          INSERT INTO public.expense_entries (user_id, type, category, amount, currency, entry_date)
          VALUES ('${U_A}', 'expense', 'other', 3, 'EUR', '2026-03-01');
        `));
        expectRlsWriteDenied(err, 'INSERT expense_entries ajeno');
        expect(isRlsPolicyViolation(err) || isRlsPolicySqlState42501(err)).toBe(true);
        expect(superCount(pg, `SELECT COUNT(*) FROM public.expense_entries WHERE user_id = '${U_A}' AND amount = 3;`)).toBe('0');
      });

      it('usuario B no actualiza ni borra expense_entries de A', () => {
        const updated = runAsAuthenticated(pg, U_B, `
          UPDATE public.expense_entries SET amount = 99 WHERE id = '${ENTRY_A}';
          SELECT amount::int FROM public.expense_entries WHERE id = '${ENTRY_A}';
        `);
        expect(updated === '0' || updated === '').toBe(true);
        expect(superCount(pg, `SELECT amount::int FROM public.expense_entries WHERE id = '${ENTRY_A}';`)).toBe('25');

        runAsAuthenticated(pg, U_B, `DELETE FROM public.expense_entries WHERE id = '${ENTRY_A}';`);
        expect(superCount(pg, `SELECT COUNT(*) FROM public.expense_entries WHERE id = '${ENTRY_A}';`)).toBe('1');
      });

      it('usuario B no lee, inserta, actualiza ni borra expense_projects de A', () => {
        expect(authenticatedSelectCount(pg, U_B, 'expense_projects', `WHERE id = '${PROJECT_A}'`)).toBe('0');
        const ins = catchRun(() => runAsAuthenticatedExpectError(pg, U_B, `
          INSERT INTO public.expense_projects (user_id, name) VALUES ('${U_A}', 'hijack');
        `));
        expectRlsWriteDenied(ins, 'INSERT expense_projects ajeno');
        runAsAuthenticated(pg, U_B, `UPDATE public.expense_projects SET name = 'x' WHERE id = '${PROJECT_A}';`);
        runAsAuthenticated(pg, U_B, `DELETE FROM public.expense_projects WHERE id = '${PROJECT_A}';`);
        expect(superCount(pg, `SELECT name FROM public.expense_projects WHERE id = '${PROJECT_A}';`)).toBe('Project A');
      });

      it('usuario B no lee, inserta, actualiza ni borra savings_goals de A', () => {
        expect(authenticatedSelectCount(pg, U_B, 'savings_goals', `WHERE id = '${GOAL_A}'`)).toBe('0');
        const ins = catchRun(() => runAsAuthenticatedExpectError(pg, U_B, `
          INSERT INTO public.savings_goals (user_id, name, target_amount, target_date)
          VALUES ('${U_A}', 'hijack', 10, '2027-01-01');
        `));
        expectRlsWriteDenied(ins, 'INSERT savings_goals ajeno');
        runAsAuthenticated(pg, U_B, `UPDATE public.savings_goals SET name = 'x' WHERE id = '${GOAL_A}';`);
        runAsAuthenticated(pg, U_B, `DELETE FROM public.savings_goals WHERE id = '${GOAL_A}';`);
        expect(superCount(pg, `SELECT name FROM public.savings_goals WHERE id = '${GOAL_A}';`)).toBe('Goal A');
      });

      it('en user_preferences cada usuario solo accede a lo suyo', () => {
        expect(authenticatedSelectCount(pg, U_B, 'user_preferences', `WHERE user_id = '${U_A}'`)).toBe('0');
        expect(authenticatedSelectCount(pg, U_B, 'user_preferences', `WHERE user_id = '${U_B}'`)).toBe('1');
        expect(authenticatedSelectCount(pg, U_A, 'user_preferences', `WHERE user_id = '${U_A}'`)).toBe('1');
        const ins = catchRun(() => runAsAuthenticatedExpectError(pg, U_B, `
          INSERT INTO public.user_preferences (user_id) VALUES ('${U_A}')
          ON CONFLICT (user_id) DO UPDATE SET updated_at = now();
        `));
        // ON CONFLICT update of A's row is not visible / check fails
        expect(ins, 'B no debe upsertar la fila de A').not.toBeNull();
      });

      it('anon no accede a expense_entries, expense_projects, savings_goals ni user_preferences', () => {
        for (const table of GASTOS_TABLES) {
          const err = catchRun(() => runAsAnonExpectError(pg, `SELECT COUNT(*) FROM public.${table};`));
          if (err) {
            expect(
              isTablePrivilegeDenied(err) || isRlsPolicySqlState42501(err),
              `anon SELECT ${table}: ${err?.stderr || err?.message}`,
            ).toBe(true);
          } else {
            expect(runAsAnon(pg, `SELECT COUNT(*)::int FROM public.${table};`)).toBe('0');
          }
          const ins = catchRun(() => runAsAnonExpectError(pg, table === 'user_preferences'
            ? `INSERT INTO public.user_preferences (user_id) VALUES ('${U_A}');`
            : table === 'savings_goals'
              ? `INSERT INTO public.savings_goals (user_id, name, target_amount, target_date) VALUES ('${U_A}', 'a', 1, '2027-01-01');`
              : table === 'expense_projects'
                ? `INSERT INTO public.expense_projects (user_id, name) VALUES ('${U_A}', 'a');`
                : `INSERT INTO public.expense_entries (user_id, type, category, amount, currency, entry_date) VALUES ('${U_A}', 'expense', 'other', 1, 'EUR', '2026-03-01');`));
          expect(ins, `anon INSERT ${table} debe denegarse`).not.toBeNull();
        }
      });

      it('control: B puede leer y escribir sus propias filas (si esto falla, es setup)', () => {
        expect(authenticatedSelectCount(pg, U_B, 'expense_entries', `WHERE id = '${ENTRY_B}'`)).toBe('1');
        expect(authenticatedSelectCount(pg, U_B, 'expense_projects', `WHERE id = '${PROJECT_B}'`)).toBe('1');
        expect(authenticatedSelectCount(pg, U_B, 'savings_goals', `WHERE id = '${GOAL_B}'`)).toBe('1');
        const amount = runAsAuthenticated(pg, U_B, `
          UPDATE public.expense_entries SET amount = 26 WHERE id = '${ENTRY_B}';
          SELECT amount::int FROM public.expense_entries WHERE id = '${ENTRY_B}';
        `);
        expect(amount).toBe('26');
        const newId = runAsAuthenticated(pg, U_B, `
          INSERT INTO public.expense_entries (user_id, type, category, amount, currency, entry_date)
          VALUES ('${U_B}', 'income', 'other', 7, 'EUR', '2026-03-02')
          RETURNING 1;
        `);
        expect(newId).toBe('1');
      });
    });

    // ── FK pertenencia ───────────────────────────────────────────────────────
    describe('P0-2 FK ajena', () => {
      it('INSERT de una entrada con project_id de otro usuario se rechaza', () => {
        const before = superCount(pg, `SELECT COUNT(*) FROM public.expense_entries;`);
        const err = catchRun(() => runAsAuthenticatedExpectError(pg, U_A, `
          INSERT INTO public.expense_entries (user_id, type, category, amount, currency, entry_date, project_id)
          VALUES ('${U_A}', 'expense', 'other', 4, 'EUR', '2026-04-01', '${PROJECT_B}');
        `));
        expectOwnershipDenied(err, 'INSERT project_id ajeno');
        expect(superCount(pg, `SELECT COUNT(*) FROM public.expense_entries;`)).toBe(before);
      });

      it('UPDATE de una entrada con project_id de otro usuario se rechaza', () => {
        const err = catchRun(() => runAsAuthenticatedExpectError(pg, U_A, `
          UPDATE public.expense_entries SET project_id = '${PROJECT_B}' WHERE id = '${ENTRY_A}';
        `));
        expectOwnershipDenied(err, 'UPDATE project_id ajeno');
        expect(superCount(pg, `SELECT COALESCE(project_id::text, '') FROM public.expense_entries WHERE id = '${ENTRY_A}';`)).toBe('');
      });

      it('INSERT/UPDATE de una entrada con recurring_source_id de otro usuario se rechaza', () => {
        const ins = catchRun(() => runAsAuthenticatedExpectError(pg, U_A, `
          INSERT INTO public.expense_entries (user_id, type, category, amount, currency, entry_date, recurring_source_id, source_month)
          VALUES ('${U_A}', 'expense', 'other', 4, 'EUR', '2026-04-01', '${TPL_B}', '2026-04');
        `));
        const upd = catchRun(() => runAsAuthenticatedExpectError(pg, U_A, `
          UPDATE public.expense_entries
             SET recurring_source_id = '${TPL_B}', source_month = '2026-05'
           WHERE id = '${ENTRY_A}';
        `));
        expectOwnershipDenied(ins, 'INSERT recurring_source_id ajeno');
        expectOwnershipDenied(upd, 'UPDATE recurring_source_id ajeno');
      });

      it('INSERT/UPDATE de un proyecto con goal_id de otro usuario se rechaza', () => {
        const ins = catchRun(() => runAsAuthenticatedExpectError(pg, U_A, `
          INSERT INTO public.expense_projects (user_id, name, goal_id)
          VALUES ('${U_A}', 'cruzado', '${GOAL_B}');
        `));
        const upd = catchRun(() => runAsAuthenticatedExpectError(pg, U_A, `
          UPDATE public.expense_projects SET goal_id = '${GOAL_B}' WHERE id = '${PROJECT_A}';
        `));
        expectOwnershipDenied(ins, 'INSERT goal_id ajeno');
        expectOwnershipDenied(upd, 'UPDATE goal_id ajeno');
        expect(superCount(pg, `SELECT goal_id::text FROM public.expense_projects WHERE id = '${PROJECT_A}';`)).toBe(GOAL_A);
      });

      it('las referencias propias se aceptan', () => {
        const proj = runAsAuthenticated(pg, U_A, `
          INSERT INTO public.expense_entries (user_id, type, category, amount, currency, entry_date, project_id)
          VALUES ('${U_A}', 'expense', 'other', 4, 'EUR', '2026-04-01', '${PROJECT_A}')
          RETURNING 1;
        `);
        expect(proj).toBe('1');
        const rec = runAsAuthenticated(pg, U_A, `
          INSERT INTO public.expense_entries (user_id, type, category, amount, currency, entry_date, recurring_source_id, source_month)
          VALUES ('${U_A}', 'expense', 'other', 4, 'EUR', '2026-04-01', '${TPL_A}', '2026-04')
          RETURNING 1;
        `);
        expect(rec).toBe('1');
        const goal = runAsAuthenticated(pg, U_A, `
          INSERT INTO public.expense_projects (user_id, name, goal_id)
          VALUES ('${U_A}', 'propio', '${GOAL_A}')
          RETURNING 1;
        `);
        expect(goal).toBe('1');
      });

      it('los NULL en project_id, goal_id y recurring_source_id se aceptan', () => {
        const entry = runAsAuthenticated(pg, U_A, `
          INSERT INTO public.expense_entries (user_id, type, category, amount, currency, entry_date, project_id, recurring_source_id)
          VALUES ('${U_A}', 'expense', 'other', 4, 'EUR', '2026-06-01', NULL, NULL)
          RETURNING 1;
        `);
        expect(entry).toBe('1');
        const proj = runAsAuthenticated(pg, U_A, `
          INSERT INTO public.expense_projects (user_id, name, goal_id)
          VALUES ('${U_A}', 'sin-sobre', NULL)
          RETURNING 1;
        `);
        expect(proj).toBe('1');
      });
    });

    // ── policies + GRANTs ────────────────────────────────────────────────────
    describe('P0-2 policies y GRANTs', () => {
      it('todas las policies de las tablas de gastos son TO authenticated (ni anon ni PUBLIC)', () => {
        expect(policies.length, 'deben existir policies en las cuatro tablas').toBeGreaterThan(0);
        const offenders = policies.filter((p) => {
          const roles = p.roles.map((r) => r.toLowerCase());
          return roles.includes('public') || roles.includes('anon') || !(roles.length === 1 && roles[0] === 'authenticated');
        });
        expect(offenders, 'policies con roles PUBLIC/anon o distintos de {authenticated}: ' + JSON.stringify(offenders)).toEqual([]);
      });

      itPublished('las migraciones publicadas declaran GRANT explícito TO authenticated en las tablas nuevas', () => {
        const missing = GASTOS_TABLES.filter((t) => publishedGrantMentions(t).length === 0);
        expect(
          missing,
          'faltan GRANT en migraciones publicadas para: ' + missing.join(', '),
        ).toEqual([]);
      });

      it('en el PG montado solo con migraciones publicadas, authenticated tiene privilegios explícitos (o el candidato los aporta)', () => {
        const needed = [];
        for (const table of GASTOS_TABLES) {
          for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
            if (!privilegesBeforeFixtureGrants[`${table}:authenticated:${priv}`]) {
              needed.push(`${table}:${priv}`);
            }
          }
        }
        expect(needed, 'authenticated debe tener SELECT/INSERT/UPDATE/DELETE (migración publicada o candidata): ' + needed.join(', ')).toEqual([]);
      });

      it('anon no tiene privilegios de tabla sobre expense_entries, expense_projects, savings_goals ni user_preferences (foto pre-fixture)', () => {
        const leaks = [];
        for (const table of GASTOS_TABLES) {
          for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
            if (privilegesBeforeFixtureGrants[`${table}:anon:${priv}`]) leaks.push(`${table}:${priv}`);
          }
        }
        expect(leaks, `anon no debe tener GRANTs: ${leaks.join(', ')}`).toEqual([]);
      });

      itPublished('migrationGrants cubre también las funciones nuevas relacionadas con preferencias/gastos', () => {
        const corpus = migrationSqlCorpus();
        const funcs = [];
        const grantExec = [];
        const fnRe = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.([a-zA-Z0-9_]+)/gi;
        const grantRe = /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.([a-zA-Z0-9_]+)/gi;
        for (const { file, sql } of corpus) {
          if (!/expense|savings|user_preferences|recurring/i.test(file + sql.slice(0, 200))) continue;
          let m;
          fnRe.lastIndex = 0;
          while ((m = fnRe.exec(sql))) funcs.push({ file, name: m[1] });
          grantRe.lastIndex = 0;
          while ((m = grantRe.exec(sql))) grantExec.push(m[1]);
        }
        expect(funcs.some((f) => f.name === 'guard_user_preferences_plan'), 'debe verse la función publicada guard_user_preferences_plan').toBe(true);
        const uncovered = funcs.filter((f) => !grantExec.includes(f.name));
        expect(
          uncovered,
          'migrationGrants: falta GRANT EXECUTE en migraciones para ' + uncovered.map((f) => `${f.file}:${f.name}`).join(', '),
        ).toEqual([]);
      });
    });
  });
}

registerSuite({
  title: 'P0-2 Gastos — implementación actual (developSecond)',
  applyFix: false,
});

const fixFile = resolveFixFile();
const describeProbe = runPg && fixFile ? describe : describe.skip;

describeProbe('P0-2 Gastos — sonda de regresión con migración candidata (solo verificación)', () => {
  registerSuite({
    title: 'con p0-2-rls-fk-candidate.sql',
    applyFix: true,
  });
});
