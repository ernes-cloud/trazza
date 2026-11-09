import { pgDescribe } from './pgTestMode.js';
import { verifyCoreFixtureSchema, verifyCoreFixtureRows } from './pgFixtureContract.js';
/**
 * I-1 / TDD: inyección cross-tenant positions/transactions (broker AND portfolio).
 * D5 real: entry_price, broker_id y portfolio_id son NOT NULL; NULL falla con 23502.
 * Comportamiento seguro: 42501 en escrituras maliciosas / 0 filas en SELECT ajeno.
 * Acepta políticas AND en baseline o vía RLS_TEST_FIX_FILE (sin exigir OR vulnerable).
 *
 * PG_TESTS=1 · Postgres embebido local (unset PGHOST remoto; PG_BIN).
 */
import {
  describe, it as vitestIt, expect, beforeAll, afterAll, beforeEach,
} from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  mountOssRlsDatabase,
  U_A,
  U_B,
  isRlsPolicySqlState42501,
  isTablePrivilegeDenied,
  runAsAuthenticated,
  runAsAuthenticatedExpectError,
  seedAsSuperuser,
  findBaselineFiles,
} from './rlsOssPgSetup.js';

const describePg = pgDescribe(describe);

const ASSET_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BROKER_A = 'ba111111-1111-1111-1111-111111111111';
const BROKER_B = 'bb222222-2222-2222-2222-222222222222';
const PORTFOLIO_A = 'fa111111-1111-1111-1111-111111111111';
const PORTFOLIO_B = 'fb222222-2222-2222-2222-222222222222';
const POS_OWN_A = '0a111111-1111-1111-1111-111111111111';
const POS_CROSS = '0c111111-1111-1111-1111-111111111111';
const LEGIT_EXTRA_POS = '0d111111-1111-1111-1111-111111111111';
const LEGIT_TX = '12111111-1111-1111-1111-111111111111';

function assertSetup(setupError) {
  expect(setupError, setupError || 'montaje OK').toBeNull();
}

function expectRls42501(run) {
  let err;
  try {
    run();
    err = null;
  } catch (e) {
    err = e;
  }
  expect(err, 'se esperaba fallo de escritura, no éxito').not.toBeNull();
  expect(
    isRlsPolicySqlState42501(err),
    `INSERT/UPDATE debe ser SQLSTATE 42501 (VERBOSE), no permission denied genérico: ${err?.stderr || err?.message}`,
  ).toBe(true);
}

/** Restaura filas compartidas tras tests que mutan POS_OWN_A / POS_CROSS o insertan ruido. */
function resetCrossTenantFixtures(pg) {
  seedAsSuperuser(pg, `
    DELETE FROM public.transactions
    WHERE position_id IN (
      SELECT id FROM public.positions WHERE asset_id = '${ASSET_ID}'
    );

    DELETE FROM public.positions
    WHERE asset_id = '${ASSET_ID}'
      AND id NOT IN ('${POS_OWN_A}', '${POS_CROSS}');

    INSERT INTO public.positions (entry_price, id, asset_id, broker_id, portfolio_id, quantity)
    VALUES (10, '${POS_OWN_A}', '${ASSET_ID}', '${BROKER_A}', '${PORTFOLIO_A}', 1)
    ON CONFLICT (id) DO UPDATE SET
      broker_id = EXCLUDED.broker_id,
      portfolio_id = EXCLUDED.portfolio_id,
      quantity = EXCLUDED.quantity;

    UPDATE public.positions SET quantity = 7 WHERE id = '${POS_CROSS}';
  `);
}

function seedBaseDeps(pg) {
  seedAsSuperuser(pg, `
    INSERT INTO auth.users (id, email) VALUES
      ('${U_A}', 'a@example.com'),
      ('${U_B}', 'b@example.com')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.assets (id, ticker, company_name)
    VALUES ('${ASSET_ID}', 'TST', 'Test Co')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.brokers (id, user_id, name) VALUES
      ('${BROKER_A}', '${U_A}', 'Broker A'),
      ('${BROKER_B}', '${U_B}', 'Broker B')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.portfolios (id, user_id, name) VALUES
      ('${PORTFOLIO_A}', '${U_A}', 'PF A'),
      ('${PORTFOLIO_B}', '${U_B}', 'PF B')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.positions (entry_price, id, asset_id, broker_id, portfolio_id, quantity) VALUES
      (10, '${POS_OWN_A}', '${ASSET_ID}', '${BROKER_A}', '${PORTFOLIO_A}', 1)
    ON CONFLICT (id) DO NOTHING;

    -- Deliberately corrupt historical row; ONLY this seed bypasses triggers.
    BEGIN;
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.positions (entry_price, id, asset_id, broker_id, portfolio_id, quantity) VALUES
      (10, '${POS_CROSS}', '${ASSET_ID}', '${BROKER_A}', '${PORTFOLIO_B}', 7)
    ON CONFLICT (id) DO NOTHING;
    COMMIT;
    DO $$ BEGIN
      IF current_setting('session_replication_role') <> 'origin' THEN
        RAISE EXCEPTION 'fixture leaked replication mode';
      END IF;
    END $$;
  `);
}

describePg('RLS cross-tenant OSS — positions / transactions', () => {
  let pg;
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
    if (!findBaselineFiles()) {
      setupError = 'falta baseline';
      return;
    }
    const mounted = mountOssRlsDatabase();
    pg = mounted.pg;
    setupError = mounted.setupError;

    if (setupError || !pg) return;
    verifyCoreFixtureSchema(pg);
    seedBaseDeps(pg);
    verifyCoreFixtureRows(pg);
    } catch (e) { setupError = `fixture setup failed: ${e.stderr || e.message}`; }
  });

  afterAll(() => {
    try { expect(executedCases, 'minimum executed cases: no hook-induced skips').toBeGreaterThanOrEqual(37); }
    finally { pg?.stop(); }
  });

  beforeEach(() => {
    try {
    if (setupError || !pg) return;
    resetCrossTenantFixtures(pg);
    verifyCoreFixtureRows(pg);
    const active = pg.psql(`SELECT current_setting('session_replication_role') || '|' || COUNT(*)
      FROM pg_trigger WHERE tgrelid = 'public.positions'::regclass
      AND tgname = 'guard_positions_owner_coherence' AND NOT tgisinternal
      AND tgenabled IN ('O', 'A');`, ['-q', '-t', '-A']).trim();
    if (active !== 'origin|1') throw new Error(`RLS cases require active owner trigger: ${active}`);
    } catch (e) { setupError = `fixture reset failed: ${e.stderr || e.message}`; }
  });

  it('montaje baseline + migraciones (+ fix opcional)', () => {
    expect(findBaselineFiles()).not.toBeNull();
    assertSetup(setupError);
  });

  it('trigger ACTIVO rechaza un INSERT cruzado fuera de la siembra especial', () => {
    let error;
    try {
      seedAsSuperuser(pg, `INSERT INTO public.positions (entry_price, asset_id, broker_id, portfolio_id, quantity)
        VALUES (10, '${ASSET_ID}', '${BROKER_A}', '${PORTFOLIO_B}', 1);`, ['-q', '-v', 'VERBOSITY=verbose']);
    } catch (e) { error = e; }
    expect(error, 'trigger activo debe rechazar la fila cruzada').toBeTruthy();
    expect(String(error?.stderr || error?.message)).toMatch(/ERROR:\s+P0001:/);
    expect(pg.psql(`SELECT COUNT(*) FROM public.positions WHERE asset_id = '${ASSET_ID}';`,
      ['-q', '-t', '-A']).trim()).toBe('2');
  });

  function expectPositionDenied(run) {
    const before = pg.psql(`SELECT id, broker_id, portfolio_id FROM public.positions
      WHERE asset_id = '${ASSET_ID}' ORDER BY id;`, ['-q', '-t', '-A']).trim();
    let error;
    try { run(); } catch (e) { error = e; }
    expect(error, 'posición cruzada debe rechazarse por RLS o por trigger activo').toBeTruthy();
    expect(String(error?.stderr || error?.message)).toMatch(/ERROR:\s+(42501|23514|P0001):/);
    expect(pg.psql(`SELECT id, broker_id, portfolio_id FROM public.positions
      WHERE asset_id = '${ASSET_ID}' ORDER BY id;`, ['-q', '-t', '-A']).trim()).toBe(before);
  }

  it('usuario A no puede INSERT position broker A + cartera B (RLS 42501 o trigger activo)', () => {
    if (setupError) { assertSetup(setupError); return; }
    expectPositionDenied(() => runAsAuthenticatedExpectError(pg, U_A, `
      INSERT INTO public.positions (entry_price, asset_id, broker_id, portfolio_id, quantity)
      VALUES (10, '${ASSET_ID}', '${BROKER_A}', '${PORTFOLIO_B}', 1);
    `));
  });

  it('usuario A no puede INSERT position broker B + cartera A (RLS 42501 o trigger activo)', () => {
    if (setupError) { assertSetup(setupError); return; }
    expectPositionDenied(() => runAsAuthenticatedExpectError(pg, U_A, `
      INSERT INTO public.positions (entry_price, asset_id, broker_id, portfolio_id, quantity)
      VALUES (10, '${ASSET_ID}', '${BROKER_B}', '${PORTFOLIO_A}', 1);
    `));
  });

  it('usuario A no puede UPDATE su posición hacia cartera B (RLS 42501 o trigger activo)', () => {
    if (setupError) { assertSetup(setupError); return; }
    expectPositionDenied(() => runAsAuthenticatedExpectError(pg, U_A, `
      UPDATE public.positions SET portfolio_id = '${PORTFOLIO_B}' WHERE id = '${POS_OWN_A}';
    `));
  });

  it('usuario A no puede UPDATE su posición hacia broker B (RLS 42501 o trigger activo)', () => {
    if (setupError) { assertSetup(setupError); return; }
    expectPositionDenied(() => runAsAuthenticatedExpectError(pg, U_A, `
      UPDATE public.positions SET broker_id = '${BROKER_B}' WHERE id = '${POS_OWN_A}';
    `));
  });

  describe('RLS aislada — trigger de propietario desactivado SOLO en la transacción', () => {
    const cases = [
      ['INSERT broker A + cartera B', `INSERT INTO public.positions (entry_price, asset_id, broker_id, portfolio_id, quantity)
        VALUES (10, '${ASSET_ID}', '${BROKER_A}', '${PORTFOLIO_B}', 1);`],
      ['INSERT broker B + cartera A', `INSERT INTO public.positions (entry_price, asset_id, broker_id, portfolio_id, quantity)
        VALUES (10, '${ASSET_ID}', '${BROKER_B}', '${PORTFOLIO_A}', 1);`],
      ['UPDATE hacia cartera B', `UPDATE public.positions SET portfolio_id = '${PORTFOLIO_B}' WHERE id = '${POS_OWN_A}';`],
      ['UPDATE hacia broker B', `UPDATE public.positions SET broker_id = '${BROKER_B}' WHERE id = '${POS_OWN_A}';`],
    ];
    for (const [name, statement] of cases) {
      it(`RLS aislada exige 42501: ${name}`, () => {
        const before = pg.psql(`SELECT id, broker_id, portfolio_id FROM public.positions
          WHERE asset_id = '${ASSET_ID}' ORDER BY id;`, ['-q', '-t', '-A']).trim();
        let error;
        try {
          // psql uses a dedicated connection. On SQL error ON_ERROR_STOP exits
          // and PostgreSQL rolls back the DDL; on unexpected success ROLLBACK
          // below also restores the trigger and discards the malicious write.
          pg.psql(`
            BEGIN;
            ALTER TABLE public.positions DISABLE TRIGGER guard_positions_owner_coherence;
            DO $$ BEGIN
              IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.positions'::regclass
                AND tgname = 'guard_positions_owner_coherence' AND tgenabled = 'D') THEN
                RAISE EXCEPTION 'isolated test requires disabled owner trigger';
              END IF;
              PERFORM set_config('request.jwt.claim.sub', '${U_A}', true);
            END $$;
            SET LOCAL ROLE authenticated;
            DO $$ BEGIN
              IF current_user <> 'authenticated' OR EXISTS (
                SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
              ) THEN RAISE EXCEPTION 'isolated test must execute as authenticated without bypass'; END IF;
              IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.positions'::regclass AND relrowsecurity)
                THEN RAISE EXCEPTION 'isolated test requires enabled RLS'; END IF;
            END $$;
            ${statement}
            RESET ROLE;
            ROLLBACK;
          `, ['-q', '-v', 'VERBOSITY=verbose']);
        } catch (e) { error = e; }
        finally {
          expect(pg.psql(`SELECT tgenabled::text FROM pg_trigger
            WHERE tgrelid = 'public.positions'::regclass AND tgname = 'guard_positions_owner_coherence';`,
          ['-q', '-t', '-A']).trim(), 'el trigger debe volver a estar ACTIVO incluso tras 42501').toBe('O');
          expect(pg.psql(`SELECT id, broker_id, portfolio_id FROM public.positions
            WHERE asset_id = '${ASSET_ID}' ORDER BY id;`, ['-q', '-t', '-A']).trim()).toBe(before);
        }
        expect(error, 'RLS debe rechazar la escritura aunque el trigger esté desactivado').toBeTruthy();
        const state = String(error?.stderr || error?.message).match(/ERROR:\s+([0-9A-Z]{5}):/)?.[1];
        expect(state, 'SQLSTATE debe ser exactamente 42501, no un rechazo de trigger ni otro error').toBe('42501');
      });
    }
  });

  describe('fila cruzada sembrada como superuser (broker A, cartera B)', () => {
    it('usuario B no ve la posición cruzada (0 filas)', () => {
      if (setupError) { assertSetup(setupError); return; }
      const n = runAsAuthenticated(pg, U_B, `
        SELECT COUNT(*)::int FROM public.positions WHERE id = '${POS_CROSS}';
      `);
      expect(n, 'B no debe ver posición con broker ajeno aunque la cartera sea suya').toBe('0');
    });

    it('usuario B no puede UPDATE la posición cruzada (0 filas o 42501)', () => {
      if (setupError) { assertSetup(setupError); return; }
      try {
        runAsAuthenticated(pg, U_B, `
          UPDATE public.positions SET quantity = 99 WHERE id = '${POS_CROSS}';
        `);
      } catch (e) {
        if (!isRlsPolicySqlState42501(e) && !isTablePrivilegeDenied(e)) throw e;
      }
      const qty = pg.psql(
        `SELECT quantity::int FROM public.positions WHERE id = '${POS_CROSS}';`,
        ['-q', '-t', '-A'],
      ).trim();
      expect(qty, 'B no debe modificar la cruzada').toBe('7');
    });

    it('usuario B no puede DELETE la posición cruzada (sigue existiendo para superuser)', () => {
      if (setupError) { assertSetup(setupError); return; }
      try {
        runAsAuthenticatedExpectError(pg, U_B, `
          DELETE FROM public.positions WHERE id = '${POS_CROSS}';
        `);
      } catch (e) {
        if (!isRlsPolicySqlState42501(e) && !isTablePrivilegeDenied(e)) throw e;
      }
      const still = pg.psql(
        `SELECT COUNT(*)::int FROM public.positions WHERE id = '${POS_CROSS}';`,
        ['-q', '-t', '-A'],
      ).trim();
      expect(still, 'la fila cruzada debe seguir (B no borró)').toBe('1');
    });

    it('usuario A no puede INSERT transaction sobre la posición cruzada (42501)', () => {
      if (setupError) { assertSetup(setupError); return; }
      expectRls42501(() => runAsAuthenticatedExpectError(pg, U_A, `
        INSERT INTO public.transactions (price, total_amount, position_id, transaction_type, quantity, transaction_date)
        VALUES (10, 10, '${POS_CROSS}', 'BUY', 1, now());
      `));
    });
  });

  describe('esquema D5 real: owner refs NOT NULL (23502, no RLS)', () => {
    for (const column of ['broker_id', 'portfolio_id']) {
      for (const operation of ['INSERT', 'UPDATE']) {
        it(`${operation} ${column}=NULL viola NOT NULL (23502)`, () => {
          const broker = column === 'broker_id' ? 'NULL' : `'${BROKER_A}'`;
          const portfolio = column === 'portfolio_id' ? 'NULL' : `'${PORTFOLIO_A}'`;
          let error;
          try {
            const sql = operation === 'INSERT'
              ? `INSERT INTO public.positions (entry_price, asset_id, broker_id, portfolio_id, quantity)
                 VALUES (10, '${ASSET_ID}', ${broker}, ${portfolio}, 1);`
              : `UPDATE public.positions SET ${column} = NULL WHERE id = '${POS_OWN_A}';`;
            seedAsSuperuser(pg, sql, ['-q', '-v', 'VERBOSITY=verbose']);
          } catch (e) { error = e; }
          expect(error, 'debe fallar por NOT NULL, no omitirse ni aceptar NULL').toBeTruthy();
          expect(String(error?.stderr || error?.message)).toMatch(/ERROR:\s+23502:/);
          expect(pg.psql(`SELECT COUNT(*) FROM public.positions WHERE id = '${POS_OWN_A}'
            AND broker_id = '${BROKER_A}' AND portfolio_id = '${PORTFOLIO_A}';`, ['-q', '-t', '-A']).trim()).toBe('1');
        });
      }
    }
  });

  describe('controles legítimos usuario A', () => {
    it('INSERT position broker A + cartera A', () => {
      if (setupError) { assertSetup(setupError); return; }
      runAsAuthenticated(pg, U_A, `
        INSERT INTO public.positions (entry_price, id, asset_id, broker_id, portfolio_id, quantity)
        VALUES (10, '${LEGIT_EXTRA_POS}', '${ASSET_ID}', '${BROKER_A}', '${PORTFOLIO_A}', 5)
        ON CONFLICT (id) DO UPDATE SET quantity = 5;
      `);
      const n = runAsAuthenticated(pg, U_A, `SELECT COUNT(*)::int FROM public.positions WHERE id = '${LEGIT_EXTRA_POS}';`);
      expect(n).toBe('1');
    });

    it('UPDATE quantity en posición propia', () => {
      if (setupError) { assertSetup(setupError); return; }
      runAsAuthenticated(pg, U_A, `
        UPDATE public.positions SET quantity = 11 WHERE id = '${POS_OWN_A}';
      `);
      const q = runAsAuthenticated(pg, U_A, `
        SELECT quantity::int FROM public.positions WHERE id = '${POS_OWN_A}';
      `);
      expect(q).toBe('11');
    });

    it('INSERT transaction en posición propia alineada', () => {
      if (setupError) { assertSetup(setupError); return; }
      runAsAuthenticated(pg, U_A, `
        INSERT INTO public.transactions (price, total_amount, id, position_id, transaction_type, quantity, transaction_date)
        VALUES (10, 10, '${LEGIT_TX}', '${POS_OWN_A}', 'BUY', 1, now())
        ON CONFLICT (id) DO NOTHING;
      `);
      const n = runAsAuthenticated(pg, U_A, `
        SELECT COUNT(*)::int FROM public.transactions WHERE id = '${LEGIT_TX}';
      `);
      expect(n).toBe('1');
    });
  });


  describe('regresión: visibilidad AND y operaciones sobre transactions', () => {
    const POS_B = '0b222222-2222-2222-2222-222222222222';
    const TX_A = '33111111-1111-1111-1111-111111111111';
    const TX_CROSS = '33111111-1111-1111-1111-222222222222';

    function seedTransactions() {
      // Superuser crea incluso la fila inválida: no dependemos de un INSERT
      // autenticado que el propio fix debe rechazar. Cada beforeEach la limpia.
      seedAsSuperuser(pg, `
        INSERT INTO public.positions (entry_price, id, asset_id, broker_id, portfolio_id, quantity)
        VALUES (10, '${POS_B}', '${ASSET_ID}', '${BROKER_B}', '${PORTFOLIO_B}', 3);
        INSERT INTO public.transactions (price, total_amount, id, position_id, transaction_type, quantity, transaction_date)
        VALUES (10, 10, '${TX_A}', '${POS_OWN_A}', 'BUY', 4, now()),
               (10, 10, '${TX_CROSS}', '${POS_CROSS}', 'BUY', 6, now());
      `);
      expect(pg.psql(`SELECT COUNT(*) FROM public.transactions
        WHERE id IN ('${TX_A}', '${TX_CROSS}');`, ['-q', '-t', '-A']).trim()).toBe('2');
    }

    function expectHiddenMutation(user, id, operation) {
      // USING oculta la fila: 0 afectadas; 42501 también es rechazo seguro.
      // Nunca aceptamos un permission denied genérico como prueba de RLS.
      try {
        const sql = operation === 'UPDATE'
          ? `UPDATE public.transactions SET quantity = 99 WHERE id = '${id}' RETURNING id`
          : `DELETE FROM public.transactions WHERE id = '${id}' RETURNING id`;
        expect(runAsAuthenticated(pg, user,
          `WITH affected AS (${sql}) SELECT COUNT(*)::int FROM affected;`)).toBe('0');
      } catch (e) {
        if (!isRlsPolicySqlState42501(e)) throw e;
      }
      expect(pg.psql(`SELECT quantity::int FROM public.transactions WHERE id = '${id}';`,
        ['-q', '-t', '-A']).trim()).toBe(id === TX_A ? '4' : '6');
    }

    it('A tampoco ve la posición cruzada: AND exige broker Y cartera propios', () => {
      if (setupError) { assertSetup(setupError); return; }
      // Tener broker A no basta: portfolio B incumple la otra mitad de USING.
      expect(runAsAuthenticated(pg, U_A,
        `SELECT COUNT(*)::int FROM public.positions WHERE id = '${POS_CROSS}';`)).toBe('0');
    });

    it('B no ve transacciones de la posición propia de A', () => {
      if (setupError) { assertSetup(setupError); return; }
      seedTransactions();
      expect(runAsAuthenticated(pg, U_B,
        `SELECT COUNT(*)::int FROM public.transactions WHERE id = '${TX_A}';`)).toBe('0');
    });
    for (const operation of ['UPDATE', 'DELETE']) {
      it(`B no puede ${operation} transacciones de A`, () => {
        if (setupError) { assertSetup(setupError); return; }
        seedTransactions();
        expectHiddenMutation(U_B, TX_A, operation);
      });
    }

    for (const [label, target] of [['ajena', POS_B], ['cruzada', POS_CROSS]]) {
      it(`A no puede reasignar su transaction a posición ${label} (42501)`, () => {
        if (setupError) { assertSetup(setupError); return; }
        seedTransactions();
        // La fila original sí es visible: WITH CHECK debe rechazar el destino.
        expect(runAsAuthenticated(pg, U_A,
          `SELECT COUNT(*)::int FROM public.transactions WHERE id = '${TX_A}';`)).toBe('1');
        expectRls42501(() => runAsAuthenticatedExpectError(pg, U_A,
          `UPDATE public.transactions SET position_id = '${target}' WHERE id = '${TX_A}';`));
        expect(pg.psql(`SELECT position_id FROM public.transactions WHERE id = '${TX_A}';`,
          ['-q', '-t', '-A']).trim()).toBe(POS_OWN_A);
      });
    }

    for (const [label, user] of [['A', U_A], ['B', U_B]]) {
      it(`${label} no ve transacciones de la posición cruzada`, () => {
        if (setupError) { assertSetup(setupError); return; }
        seedTransactions();
        expect(runAsAuthenticated(pg, user,
          `SELECT COUNT(*)::int FROM public.transactions WHERE id = '${TX_CROSS}';`)).toBe('0');
      });
      for (const operation of ['UPDATE', 'DELETE']) {
        it(`${label} no puede ${operation} transacciones de la posición cruzada`, () => {
          if (setupError) { assertSetup(setupError); return; }
          seedTransactions();
          expectHiddenMutation(user, TX_CROSS, operation);
        });
      }
    }

    for (const operation of ['SELECT', 'UPDATE', 'DELETE']) {
      it(`control positivo: A puede ${operation} su transacción alineada`, () => {
        if (setupError) { assertSetup(setupError); return; }
        seedTransactions();
        const sql = operation === 'SELECT'
          ? `SELECT id FROM public.transactions WHERE id = '${TX_A}'`
          : operation === 'UPDATE'
            ? `UPDATE public.transactions SET quantity = 8 WHERE id = '${TX_A}' RETURNING id`
            : `DELETE FROM public.transactions WHERE id = '${TX_A}' RETURNING id`;
        expect(runAsAuthenticated(pg, U_A,
          `WITH affected AS (${sql}) SELECT COUNT(*)::int FROM affected;`)).toBe('1');
        const expected = operation === 'DELETE' ? '' : operation === 'UPDATE' ? '8' : '4';
        expect(pg.psql(`SELECT quantity::int FROM public.transactions WHERE id = '${TX_A}';`,
          ['-q', '-t', '-A']).trim()).toBe(expected);
      });
    }
  });

  it('setup obligatorio: sin semilla de usuarios el caso INSERT cruzado no debe pasar trivialmente', () => {
    if (setupError) { assertSetup(setupError); return; }
    const n = pg.psql(
      `SELECT COUNT(*)::int FROM auth.users WHERE id IN ('${U_A}', '${U_B}');`,
      ['-q', '-t', '-A'],
    ).trim();
    expect(n, 'auth.users debe tener A y B — si es 0 el resto del archivo es falso verde').toBe('2');
  });
});

/** Ruta sugerida del fix de revisión (no se aplica por defecto). */
export const SUGGESTED_FIX_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../prod-rls-positions-transactions-fix.sql',
);
