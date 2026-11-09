/**
 * Prueba REAL de las migraciones 20261026–028 contra Postgres.
 * Solo corre con PG_TESTS=1 (job CI `pg-migrations` o local con /tmp/pg16-extract).
 * Sin esa variable: describe.skip — no arranca PG ni falla por falta de psql.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  startTestPg, STUB_SQL, MIGRATIONS,
} from './pg20261026.harness.js';

const runPg = process.env.PG_TESTS === '1';
const describePg = runPg ? describe : describe.skip;

describePg('migraciones 20261026–028 en Postgres real', () => {
  let pg;
  const u1 = '11111111-1111-1111-1111-111111111111';
  const u2 = '22222222-2222-2222-2222-222222222222';
  let assetOwned;
  let assetOther;

  beforeAll(() => {
    pg = startTestPg();
    if (!pg) throw new Error('no se pudo conectar/arrancar Postgres (PGHOST o /tmp/pg16-extract)');
    pg.psql(STUB_SQL);
    pg.psqlFile(MIGRATIONS.asset);
    pg.psqlFile(MIGRATIONS.ticker);
    pg.psqlFile(MIGRATIONS.assetsInsert); // FASE 1: ensure_asset + UNIQUE (policy INSERT sigue)
    pg.psqlFile(MIGRATIONS.forceAssetPrice);
    pg.psqlFile(MIGRATIONS.emailSendsRevoke);
    pg.psqlFile(MIGRATIONS.assetsInsertRevoke); // FASE 2: DROP POLICY + REVOKE

    // Semilla: u1 tiene posición sobre assetOwned; assetOther es de u2.
    assetOwned = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    assetOther = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    pg.psql(`
      INSERT INTO assets (id, ticker, company_name, current_price) VALUES
        ('${assetOwned}', 'OWN', 'Owned', 100),
        ('${assetOther}', 'OTH', 'Other', 50);
      INSERT INTO brokers (id, user_id, name) VALUES
        ('b1111111-1111-1111-1111-111111111111', '${u1}', 'B1'),
        ('b2222222-2222-2222-2222-222222222222', '${u2}', 'B2');
      INSERT INTO positions (asset_id, broker_id, quantity) VALUES
        ('${assetOwned}', 'b1111111-1111-1111-1111-111111111111', 1),
        ('${assetOther}', 'b2222222-2222-2222-2222-222222222222', 1);
    `);
  });

  afterAll(() => { pg?.stop(); });

  // Reaplica la FASE 1 tras `setupSql` en UNA transacción que nunca se confirma
  // (psql -c no admite `\\i`; con ON_ERROR_STOP la sesión se cierra y PG hace rollback).
  const phase1InTx = (setupSql) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tzz-phase1-'));
    const file = path.join(dir, 'tx.sql');
    fs.writeFileSync(file, `${setupSql}\n\\i ${MIGRATIONS.assetsInsert}\nROLLBACK;\n`);
    try {
      return pg.psqlFile(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it('update_asset_market_data: EXECUTE solo service_role (no authenticated ni anon)', () => {
    const out = pg.psql(`
      SELECT
        has_function_privilege('authenticated', 'public.update_asset_market_data(uuid, numeric, text, text, text, text, text, text)', 'execute') AS auth_exec,
        has_function_privilege('anon', 'public.update_asset_market_data(uuid, numeric, text, text, text, text, text, text)', 'execute') AS anon_exec,
        has_function_privilege('service_role', 'public.update_asset_market_data(uuid, numeric, text, text, text, text, text, text)', 'execute') AS svc_exec;
    `);
    expect(out).toMatch(/f\s+\|\s+f\s+\|\s+t/);
  });

  it('update_asset_market_data: el guard del 15 % rechaza un desplome y acepta tras NULL', () => {
    // service_role BYPASSRLS; SET ROLE still sees privileges of the role
    const rejected = pg.psql(`
      SET ROLE service_role;
      SELECT public.update_asset_market_data('${assetOwned}'::uuid, 10);
      RESET ROLE;
      SELECT current_price FROM assets WHERE id = '${assetOwned}';
    `);
    // 10 < 100*0.15 → f, precio sigue 100 (psql imprime t/f alineado)
    expect(rejected).toMatch(/^\s*f\s*$/m);
    expect(rejected).toMatch(/\b100\b/);

    const ok = pg.psql(`
      SET ROLE service_role;
      UPDATE assets SET current_price = NULL WHERE id = '${assetOwned}';
      SELECT public.update_asset_market_data('${assetOwned}'::uuid, 10);
      RESET ROLE;
      SELECT current_price FROM assets WHERE id = '${assetOwned}';
    `);
    expect(ok).toMatch(/^\s*t\s*$/m);
    expect(ok).toMatch(/\b10\b/);
    // restaura para el resto
    pg.psql(`UPDATE assets SET current_price = 100 WHERE id = '${assetOwned}';`);
  });

  it('update_asset_metadata: EXECUTE authenticated; dueño privilegiado; ACL en pg_depend/pg_proc', () => {
    const grants = pg.psql(`
      SELECT has_function_privilege('authenticated', 'public.update_asset_metadata(uuid, text, text, text, text, text, text)', 'execute') AS ok,
             has_function_privilege('anon', 'public.update_asset_metadata(uuid, text, text, text, text, text, text)', 'execute') AS anon_no;
    `);
    expect(grants).toMatch(/t\s+\|\s+f/);

    // SECURITY DEFINER tiene que ser del superusuario del cluster (si no, corre
    // con los privilegios de un rol débil). pg_depend registra el vínculo del
    // GRANT EXECUTE hacia el rol authenticated (refclass = pg_authid).
    const owner = pg.psql(`
      SELECT r.rolsuper
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.proname = 'update_asset_metadata';
    `);
    expect(owner).toMatch(/\bt\b/);

    // ACL real en proacl (GRANT EXECUTE): contar filas de aclexplode, no casar
    // con "(1 row)" de psql ni con pg_depend (GRANT a roles no deja dep a pg_authid).
    const aclCount = pg.psql(`
      SELECT COUNT(*)::int
      FROM pg_proc p,
           LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      WHERE p.proname = 'update_asset_metadata'
        AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'authenticated')
        AND a.privilege_type = 'EXECUTE';
    `, ['-t', '-A']).trim();
    expect(aclCount).toBe('1');
  });

  it('update_asset_metadata: solo toca activos con posición propia (mata true OR EXISTS)', () => {
    // Como u1: puede renombrar el suyo (CASH-like placeholder: company_name = isin null → name null applies when CASH or null)
    pg.psql(`
      SELECT set_config('request.jwt.claim.sub', '${u1}', false);
      SELECT public.update_asset_metadata('${assetOwned}'::uuid, NULL, 'ISINOWN', 'Tech', NULL, NULL, NULL);
      SELECT set_config('request.jwt.claim.sub', '', true);
    `);
    const owned = pg.psql(`SELECT isin, sector FROM assets WHERE id = '${assetOwned}';`);
    expect(owned).toMatch(/ISINOWN/);
    expect(owned).toMatch(/Tech/);

    // Como u1: NO puede tocar el de u2
    pg.psql(`
      SELECT set_config('request.jwt.claim.sub', '${u1}', false);
      SELECT public.update_asset_metadata('${assetOther}'::uuid, NULL, 'HACKED', 'Evil', NULL, NULL, NULL);
      SELECT set_config('request.jwt.claim.sub', '', true);
    `);
    const other = pg.psql(`SELECT isin, sector FROM assets WHERE id = '${assetOther}';`);
    expect(other).not.toMatch(/HACKED/);
    expect(other).not.toMatch(/Evil/);
  });

  it('ticker_mappings: authenticated pierde INSERT/UPDATE; anon pierde SELECT; service_role conserva escritura', () => {
    const priv = pg.psql(`
      SELECT
        has_table_privilege('authenticated', 'public.ticker_mappings', 'insert') AS a_ins,
        has_table_privilege('authenticated', 'public.ticker_mappings', 'update') AS a_upd,
        has_table_privilege('authenticated', 'public.ticker_mappings', 'select') AS a_sel,
        has_table_privilege('anon', 'public.ticker_mappings', 'select') AS anon_sel,
        has_table_privilege('service_role', 'public.ticker_mappings', 'insert') AS s_ins;
    `);
    expect(priv).toMatch(/f\s+\|\s+f\s+\|\s+t\s+\|\s+f\s+\|\s+t/);

    const policies = pg.psql(`
      SELECT policyname, cmd FROM pg_policies WHERE tablename = 'ticker_mappings' ORDER BY policyname;
    `);
    expect(policies).toMatch(/ticker_mappings_select/);
    expect(policies).not.toMatch(/ticker_mappings_insert/);
    expect(policies).not.toMatch(/ticker_mappings_update/);
  });

  it('assets: authenticated pierde INSERT/UPDATE/REFERENCES/TRIGGER; anon pierde SELECT; solo SELECT policy', () => {
    const priv = pg.psql(`
      SELECT
        has_table_privilege('authenticated', 'public.assets', 'insert') AS a_ins,
        has_table_privilege('authenticated', 'public.assets', 'update') AS a_upd,
        has_table_privilege('authenticated', 'public.assets', 'references') AS a_ref,
        has_table_privilege('authenticated', 'public.assets', 'select') AS a_sel,
        has_table_privilege('anon', 'public.assets', 'select') AS anon_sel,
        has_table_privilege('service_role', 'public.assets', 'insert') AS s_ins;
    `);
    expect(priv).toMatch(/f\s+\|\s+f\s+\|\s+f\s+\|\s+t\s+\|\s+f\s+\|\s+t/);

    const policies = pg.psql(`
      SELECT policyname, cmd FROM pg_policies WHERE tablename = 'assets' ORDER BY policyname;
    `);
    expect(policies).toMatch(/assets_select_authenticated/);
    expect(policies).not.toMatch(/assets_insert/);
  });

  it('FASE 1 dejó UNIQUE(ticker); FASE 2 ya se aplicó en beforeAll', () => {
    const idx = pg.psql(`
      SELECT COUNT(*)::int FROM pg_indexes
      WHERE tablename = 'assets' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%ticker%';
    `, ['-t', '-A']).trim();
    expect(Number(idx)).toBeGreaterThanOrEqual(1);
  });

  it('FASE 1: assets_ticker_key y assets_ticker_norm_key son UNIQUE de verdad (pg_index.indisunique)', () => {
    const out = pg.psql(`
      SELECT c.relname, i.indisunique, i.indisvalid
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = 'public.assets'::regclass
        AND c.relname IN ('assets_ticker_key', 'assets_ticker_norm_key')
      ORDER BY c.relname;
    `, ['-t', '-A']).trim();
    expect(out.split('\n')).toEqual([
      'assets_ticker_key|t|t',
      'assets_ticker_norm_key|t|t',
    ]);
    const def = pg.psql(
      `SELECT pg_get_indexdef('public.assets_ticker_norm_key'::regclass);`,
      ['-t', '-A'],
    ).trim();
    expect(def).toMatch(/lower\(btrim\(ticker\)\)/);
  });

  it('FASE 1: un assets_ticker_key NO único hace fallar la migración (no basta el nombre)', () => {
    let msg = '';
    try {
      phase1InTx(`
        BEGIN;
        DROP INDEX public.assets_ticker_key;
        CREATE INDEX assets_ticker_key ON public.assets (ticker);
      `);
    } catch (e) {
      msg = String(e.stderr || e.message);
    }
    expect(msg).toMatch(/UNIQUE/);
    const still = pg.psql(`
      SELECT i.indisunique FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'assets_ticker_key';
    `, ['-t', '-A']).trim();
    expect(still).toBe('t');
  });

  it('FASE 1: tickers duplicados bajo lower(btrim) → RAISE claro antes de crear el índice', () => {
    let msg = '';
    try {
      phase1InTx(`
        BEGIN;
        DROP INDEX public.assets_ticker_norm_key;
        INSERT INTO public.assets (ticker, company_name) VALUES (' DUPX ', 'a'), ('dupx', 'b');
      `);
    } catch (e) {
      msg = String(e.stderr || e.message);
    }
    expect(msg).toMatch(/duplicados/);
    expect(msg).toMatch(/dupx/);
    const left = pg.psql(
      `SELECT COUNT(*)::int FROM assets WHERE lower(btrim(ticker)) = 'dupx';`,
      ['-t', '-A'],
    ).trim();
    expect(left).toBe('0');
  });

  it('ensure_asset: existente con ISIN/divisa inválidos → devuelve su id sin validar (existente primero)', () => {
    const id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    pg.psql(`
      INSERT INTO public.assets (id, ticker, company_name, currency, current_price)
      VALUES ('${id}', 'LEGACYX', 'Legacy', 'EUR', 7);
    `);
    const out = pg.psql(`
      SET ROLE service_role;
      SELECT public.ensure_asset('legacyx', 'HACKED', 'Stock', 'e', 'NOTANISIN');
      RESET ROLE;
    `, ['-t', '-A']).trim().split('\n').filter((l) => /^[0-9a-f-]{36}$/i.test(l))[0];
    expect(out).toBe(id);
    const meta = pg.psql(`SELECT company_name, currency, isin IS NULL FROM assets WHERE id = '${id}';`, ['-t', '-A']).trim();
    expect(meta).toBe('Legacy|EUR|t');
  });

  it('ensure_asset: el primero que inserta AAPL se queda; no sobrescribe precio/nombre; EXECUTE solo service_role', () => {
    const grants = pg.psql(`
      SELECT
        has_function_privilege('authenticated', 'public.ensure_asset(text, text, text, text, text)', 'execute') AS a_exec,
        has_function_privilege('anon', 'public.ensure_asset(text, text, text, text, text)', 'execute') AS anon_exec,
        has_function_privilege('service_role', 'public.ensure_asset(text, text, text, text, text)', 'execute') AS s_exec;
    `);
    expect(grants).toMatch(/f\s+\|\s+f\s+\|\s+t/);

    const first = pg.psql(`
      SET ROLE service_role;
      SELECT public.ensure_asset('AAPL', 'Apple Inc', 'Stock', 'USD', 'US0378331005');
      RESET ROLE;
      SELECT company_name, currency, current_price IS NULL AS price_null FROM assets WHERE ticker = 'AAPL';
    `);
    expect(first).toMatch(/Apple Inc/);
    expect(first).toMatch(/USD/);
    expect(first).toMatch(/t/); // price_null

    // Segundo insert con otros metadatos: ON CONFLICT DO NOTHING → no cambia.
    pg.psql(`
      SET ROLE service_role;
      UPDATE assets SET current_price = 190 WHERE ticker = 'AAPL';
      SELECT public.ensure_asset('AAPL', 'HACKED', 'ETF', 'EUR', 'XX0000000000');
      RESET ROLE;
    `);
    const after = pg.psql(`
      SELECT company_name, currency, asset_class, isin, current_price FROM assets WHERE ticker = 'AAPL';
    `);
    expect(after).toMatch(/Apple Inc/);
    expect(after).toMatch(/USD/);
    expect(after).toMatch(/Stock/);
    expect(after).toMatch(/US0378331005/);
    expect(after).toMatch(/\b190\b/);
    expect(after).not.toMatch(/HACKED/);
  });

  it('ensure_asset: alta sin company_name ni currency → ticker + USD (no 23502)', () => {
    const out = pg.psql(`
      SET ROLE service_role;
      SELECT public.ensure_asset('NEWNUL', NULL, 'Stock', NULL, NULL);
      RESET ROLE;
      SELECT company_name, currency, current_price IS NULL AS price_null, isin IS NULL AS isin_null
      FROM assets WHERE ticker = 'NEWNUL';
    `);
    expect(out).toMatch(/NEWNUL/);
    expect(out).toMatch(/USD/);
    expect(out).toMatch(/t\s+\|\s+t/); // price_null | isin_null
  });

  it('ensure_asset: CASH_* e isin CASH_*/USDT con precio 1; ticker DeGiro con espacios', () => {
    const out = pg.psql(`
      SET ROLE service_role;
      SELECT public.ensure_asset('CASH_EUR (EUR)', 'Cash EUR', 'Stock', 'EUR', 'CASH_EUR');
      SELECT public.ensure_asset('USDT', 'Tether', 'Cash', 'USDT', 'CASH_USDT');
      SELECT public.ensure_asset('CASH_CHF', NULL, 'Cash', 'CHF', 'CASH_CHF');
      RESET ROLE;
      SELECT ticker, current_price, asset_class, currency, isin FROM assets
      WHERE ticker IN ('CASH_EUR (EUR)', 'USDT', 'CASH_CHF') ORDER BY ticker;
    `);
    expect(out).toMatch(/CASH_CHF/);
    expect(out).toMatch(/CASH_EUR \(EUR\)/);
    expect(out).toMatch(/USDT/);
    // Tres filas con precio 1
    const prices = pg.psql(`
      SELECT current_price::text FROM assets
      WHERE ticker IN ('CASH_EUR (EUR)', 'USDT', 'CASH_CHF') ORDER BY ticker;
    `, ['-t', '-A']);
    expect(prices.trim().split('\n')).toEqual(['1', '1', '1']);
  });

  it('ensure_asset: ticker existente con espacios/()[]/&/ o minúsculas → id sin insertar', () => {
    const weird = 'ISHARES CORE (ACC) S&P/500 [EUR]';
    const lower = 'mixedCaseTicker';
    pg.psql(`
      INSERT INTO public.assets (ticker, company_name, currency, current_price)
      VALUES
        ('${weird}', 'iShares Core', 'EUR', 12.5),
        ('${lower}', 'Lower Co', 'USD', 3.0);
    `);
    const before = pg.psql(
      `SELECT COUNT(*)::int FROM assets WHERE ticker IN ('${weird}', '${lower}');`,
      ['-t', '-A'],
    ).trim();
    expect(before).toBe('2');

    const out = pg.psql(`
      SET ROLE service_role;
      SELECT public.ensure_asset('${weird}', 'HACKED', 'ETF', 'USD', 'US0378331005') AS id_weird;
      SELECT public.ensure_asset('${lower}', 'HACKED2', 'Stock', 'EUR', NULL) AS id_lower;
      RESET ROLE;
      SELECT a.ticker, a.company_name, a.current_price::text
      FROM assets a WHERE a.ticker IN ('${weird}', '${lower}') ORDER BY a.ticker;
    `);
    // Mismos metadatos (no sobrescribe) y sin filas nuevas.
    expect(out).toMatch(/iShares Core/);
    expect(out).toMatch(/Lower Co/);
    expect(out).toMatch(/12\.5/);
    expect(out).toMatch(/\b3\b|\b3\.0\b/);
    expect(out).not.toMatch(/HACKED/);
    const after = pg.psql(
      `SELECT COUNT(*)::int FROM assets WHERE ticker IN ('${weird}', '${lower}');`,
      ['-t', '-A'],
    ).trim();
    expect(after).toBe('2');

    // Ids estables: segunda llamada = misma uuid.
    const id1 = pg.psql(`
      SET ROLE service_role;
      SELECT public.ensure_asset('${weird}', NULL, NULL, NULL, NULL);
      RESET ROLE;
    `, ['-t', '-A']).trim().split('\n').filter((l) => /^[0-9a-f-]{36}$/i.test(l))[0];
    const id2 = pg.psql(`
      SET ROLE service_role;
      SELECT public.ensure_asset('${weird}', NULL, NULL, NULL, NULL);
      RESET ROLE;
    `, ['-t', '-A']).trim().split('\n').filter((l) => /^[0-9a-f-]{36}$/i.test(l))[0];
    expect(id1).toBeTruthy();
    expect(id1).toBe(id2);
  });

  it('ensure_asset: ticker guardado con espacios o query en minúsculas → id existente sin insertar', () => {
    // Prod: algunos tickers llevan espacios alrededor; query btrim + lower(btrim) los reencuentra.
    // UUIDs propios (cccccccc… lo usa el test de force_log).
    const paddedId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const upperId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    pg.psql(`
      INSERT INTO public.assets (id, ticker, company_name, currency, current_price)
      VALUES
        ('${paddedId}', ' PADDED ', 'Padded Co', 'USD', 9.0),
        ('${upperId}', 'UPPERCASE', 'Upper Co', 'EUR', 4.0);
    `);
    const countBefore = pg.psql(
      `SELECT COUNT(*)::int FROM assets;`,
      ['-t', '-A'],
    ).trim();

    const idPadded = pg.psql(`
      SET ROLE service_role;
      SELECT public.ensure_asset('PADDED', 'HACKED', 'ETF', 'USD', NULL);
      RESET ROLE;
    `, ['-t', '-A']).trim().split('\n').filter((l) => /^[0-9a-f-]{36}$/i.test(l))[0];
    expect(idPadded).toBe(paddedId);

    const idLower = pg.psql(`
      SET ROLE service_role;
      SELECT public.ensure_asset('uppercase', 'HACKED2', 'Stock', 'EUR', NULL);
      RESET ROLE;
    `, ['-t', '-A']).trim().split('\n').filter((l) => /^[0-9a-f-]{36}$/i.test(l))[0];
    expect(idLower).toBe(upperId);

    const countAfter = pg.psql(
      `SELECT COUNT(*)::int FROM assets;`,
      ['-t', '-A'],
    ).trim();
    expect(countAfter).toBe(countBefore);

    // Metadatos intactos (no sobrescribe).
    const meta = pg.psql(`
      SELECT company_name, current_price::text FROM assets
      WHERE id IN ('${paddedId}', '${upperId}') ORDER BY ticker;
    `);
    expect(meta).toMatch(/Padded Co/);
    expect(meta).toMatch(/Upper Co/);
    expect(meta).not.toMatch(/HACKED/);
  });

  it('ensure_asset: ticker o ISIN inválido en alta nueva → RAISE', () => {
    // Altas nuevas: solo ≤120 y sin cntrl (r17b). '!' ya es válido.
    let badTicker = false;
    try {
      pg.psql(`
        SET ROLE service_role;
        SELECT public.ensure_asset('bad' || chr(10) || 'line', 'X', 'Stock', 'USD', NULL);
        RESET ROLE;
      `);
    } catch {
      badTicker = true;
    }
    expect(badTicker).toBe(true);

    let tooLong = false;
    try {
      pg.psql(`
        SET ROLE service_role;
        SELECT public.ensure_asset('${'x'.repeat(121)}', 'X', 'Stock', 'USD', NULL);
        RESET ROLE;
      `);
    } catch {
      tooLong = true;
    }
    expect(tooLong).toBe(true);

    let badIsin = false;
    try {
      pg.psql(`
        SET ROLE service_role;
        SELECT public.ensure_asset('OKTICK', 'Ok', 'Stock', 'USD', 'NOTANISIN');
        RESET ROLE;
      `);
    } catch {
      badIsin = true;
    }
    expect(badIsin).toBe(true);
    const none = pg.psql(
      `SELECT COUNT(*)::int FROM assets WHERE ticker IN ('bad', 'OKTICK') OR char_length(ticker) > 120;`,
      ['-t', '-A'],
    ).trim();
    expect(none).toBe('0');
  });

  it('asset_price_force_log: FK ON DELETE SET NULL + índice en asset_id', () => {
    const fk = pg.psql(`
      SELECT confdeltype
      FROM pg_constraint
      WHERE conname = 'asset_price_force_log_asset_id_fkey';
    `, ['-t', '-A']).trim();
    // 'n' = SET NULL en pg_constraint.confdeltype
    expect(fk).toBe('n');

    const idx = pg.psql(`
      SELECT COUNT(*)::int FROM pg_indexes
      WHERE tablename = 'asset_price_force_log' AND indexdef ILIKE '%asset_id%';
    `, ['-t', '-A']).trim();
    expect(Number(idx)).toBeGreaterThanOrEqual(1);

    // Borrar el activo deja la fila de auditoría con asset_id NULL
    const doomed = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    pg.psql(`
      INSERT INTO assets (id, ticker, company_name, current_price) VALUES
        ('${doomed}', 'DOOM', 'Doomed', 42);
      SET ROLE service_role;
      SELECT public.force_asset_price('${doomed}'::uuid, 5, 'pre-delete', '${u1}'::uuid);
      RESET ROLE;
      DELETE FROM assets WHERE id = '${doomed}';
    `);
    const orphan = pg.psql(`
      SELECT asset_id IS NULL AS nul, reason FROM asset_price_force_log WHERE reason = 'pre-delete';
    `);
    expect(orphan).toMatch(/t/);
    expect(orphan).toMatch(/pre-delete/);
  });

  it('email_sends: anon/authenticated sin privilegios; service_role conserva ALL', () => {
    const priv = pg.psql(`
      SELECT
        has_table_privilege('anon', 'public.email_sends', 'select') AS anon_sel,
        has_table_privilege('anon', 'public.email_sends', 'truncate') AS anon_trunc,
        has_table_privilege('authenticated', 'public.email_sends', 'insert') AS auth_ins,
        has_table_privilege('authenticated', 'public.email_sends', 'truncate') AS auth_trunc,
        has_table_privilege('service_role', 'public.email_sends', 'insert') AS svc_ins;
    `);
    expect(priv).toMatch(/f\s+\|\s+f\s+\|\s+f\s+\|\s+f\s+\|\s+t/);
  });

  it('force_asset_price: atómico (sin NULL intermedio), reason obligatorio, audita y EXECUTE solo service_role', () => {
    const grants = pg.psql(`
      SELECT
        has_function_privilege('authenticated', 'public.force_asset_price(uuid, numeric, text, uuid)', 'execute') AS a_exec,
        has_function_privilege('service_role', 'public.force_asset_price(uuid, numeric, text, uuid)', 'execute') AS s_exec;
    `);
    expect(grants).toMatch(/f\s+\|\s+t/);

    // reason vacío → excepción
    let raised = false;
    try {
      pg.psql(`
        SET ROLE service_role;
        SELECT public.force_asset_price('${assetOwned}'::uuid, 10, '', '${u1}'::uuid);
        RESET ROLE;
      `);
    } catch {
      raised = true;
    }
    expect(raised).toBe(true);
    // Precio intacto tras el fallo
    const still = pg.psql(`SELECT current_price FROM assets WHERE id = '${assetOwned}';`, ['-t', '-A']).trim();
    expect(still).toBe('100');

    const ok = pg.psql(`
      SET ROLE service_role;
      SELECT public.force_asset_price('${assetOwned}'::uuid, 10, 'split 10:1 real', '${u1}'::uuid);
      RESET ROLE;
      SELECT current_price FROM assets WHERE id = '${assetOwned}';
      SELECT previous_price, new_price, reason FROM asset_price_force_log WHERE asset_id = '${assetOwned}';
    `);
    expect(ok).toMatch(/^\s*t\s*$/m);
    expect(ok).toMatch(/\b10\b/);
    expect(ok).toMatch(/split 10:1 real/);
    expect(ok).toMatch(/\b100\b/); // previous_price

    // anon/authenticated sin privilegios sobre el log
    const logPriv = pg.psql(`
      SELECT
        has_table_privilege('anon', 'public.asset_price_force_log', 'select') AS anon_sel,
        has_table_privilege('authenticated', 'public.asset_price_force_log', 'insert') AS auth_ins,
        has_table_privilege('service_role', 'public.asset_price_force_log', 'insert') AS svc_ins;
    `);
    expect(logPriv).toMatch(/f\s+\|\s+f\s+\|\s+t/);

    pg.psql(`UPDATE assets SET current_price = 100 WHERE id = '${assetOwned}';`);
  });

  it('ficheros de migración presentes', () => {
    expect(fs.existsSync(MIGRATIONS.asset)).toBe(true);
    expect(fs.existsSync(MIGRATIONS.ticker)).toBe(true);
    expect(fs.existsSync(MIGRATIONS.assetsInsert)).toBe(true);
    expect(fs.existsSync(MIGRATIONS.assetsInsertRevoke)).toBe(true);
    expect(fs.existsSync(MIGRATIONS.emailSendsRevoke)).toBe(true);
    expect(fs.existsSync(MIGRATIONS.forceAssetPrice)).toBe(true);
  });
});
