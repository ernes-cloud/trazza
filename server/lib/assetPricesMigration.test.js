import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRICE_COLLAPSE_RATIO } from '../../src/services/priceGuard.js';

/**
 * A1 (auditoría 7f2c915d): el precio de la tabla compartida `assets` solo lo
 * escribe el server. Aquí no hay Postgres: se comprueba la migración como
 * texto y que ningún fichero del cliente vuelva a llamar a la RPC de precio.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/20261026000100_asset_market_data_service_role.sql'), 'utf8',
);
const sql = MIGRATION.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

const PRICE_SIG = 'public.update_asset_market_data(uuid, numeric, text, text, text, text, text, text)';
const META_SIG = 'public.update_asset_metadata(uuid, text, text, text, text, text, text)';

/** Cuerpo `$$ … $$` de la función `name`. */
function body(name) {
  const start = sql.indexOf(`FUNCTION public.${name}(`);
  expect(start).toBeGreaterThan(-1);
  const open = sql.indexOf('$$', start);
  const close = sql.indexOf('$$', open + 2);
  return { header: sql.slice(start, open), body: sql.slice(open + 2, close) };
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(jsx?|mjs)$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : [];
  });
}

describe('migración 20261026: update_asset_market_data solo para service role', () => {
  it('DROP sin IF EXISTS; search_path vacío; tablas calificadas public.*', () => {
    expect(sql).toMatch(/DROP FUNCTION public\.update_asset_market_data\(/);
    expect(sql).not.toMatch(/DROP FUNCTION IF EXISTS public\.update_asset_market_data/);
    const { header, body: b } = body('update_asset_market_data');
    expect(header).toMatch(/SET search_path = ''/);
    expect(b).toMatch(/FROM public\.assets/);
    expect(b).toMatch(/UPDATE public\.assets/);
    const meta = body('update_asset_metadata');
    expect(meta.header).toMatch(/SET search_path = ''/);
    expect(meta.body).toMatch(/FROM public\.positions/);
    expect(meta.body).toMatch(/FROM public\.brokers/);
    expect(meta.body).toMatch(/FROM public\.portfolios/);
  });

  it('retira EXECUTE a PUBLIC, anon y authenticated y se lo da a service_role', () => {
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${PRICE_SIG} FROM PUBLIC, anon, authenticated;`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${PRICE_SIG} TO service_role;`);
    const grants = sql.match(new RegExp(`GRANT[^;]*${PRICE_SIG.replace(/[()]/g, '\\$&')}[^;]*;`, 'g')) || [];
    expect(grants.every((g) => !/authenticated|anon|PUBLIC/.test(g))).toBe(true);
  });

  it('es SECURITY INVOKER: si alguien la vuelve a abrir, RLS sigue frenando el UPDATE', () => {
    expect(body('update_asset_market_data').header).toMatch(/SECURITY INVOKER/);
  });

  it('valida el precio dentro de la función: NaN, ≤ 0, tope y desplome con el umbral del cliente', () => {
    const b = body('update_asset_market_data').body;
    expect(b).toMatch(/p_current_price <> 'NaN'::numeric/);
    expect(b).toMatch(/p_current_price > 0/);
    expect(b).toMatch(/p_current_price < 1e9/);
    const ratio = b.match(/p_current_price >= v_stored \* ([\d.]+)/);
    expect(ratio).not.toBeNull();
    expect(Number(ratio[1])).toBe(PRICE_COLLAPSE_RATIO);
    // el precio solo se aplica cuando pasó la validación
    expect(b).toMatch(/current_price = CASE WHEN v_apply_price THEN p_current_price ELSE a\.current_price END/);
  });
});

describe('migración 20261026: update_asset_metadata para el cliente', () => {
  it('no recibe precio y solo toca activos que el usuario tiene en una posición', () => {
    const { header, body: b } = body('update_asset_metadata');
    expect(header).not.toMatch(/p_current_price/);
    expect(b).not.toMatch(/current_price/);
    expect(b).toMatch(/auth\.uid\(\) IS NULL/);
    expect(b).toMatch(/b\.user_id = auth\.uid\(\)/);
    expect(b).toMatch(/pf\.user_id = auth\.uid\(\)/);
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${META_SIG} FROM PUBLIC, anon;`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${META_SIG} TO authenticated;`);
  });
});

describe('el cliente no escribe el precio de assets', () => {
  it('ningún fichero de src/ ni api/ llama a update_asset_market_data (antirregresión JWT)', () => {
    // usePositions / CarteraPage / Dashboard (useDashboardData) escribían el
    // precio con el JWT del usuario; si alguien reintroduce la RPC, este test
    // falla. El único escritor legítimo es server/lib/assetPrices.js.
    const offenders = [...walk(path.join(ROOT, 'src')), ...(fs.existsSync(path.join(ROOT, 'api')) ? walk(path.join(ROOT, 'api')) : [])]
      .filter((f) => /rpc\(\s*['"]update_asset_market_data['"]/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('usePositions, CarteraPage y Dashboard no mencionan update_asset_market_data', () => {
    const watched = [
      'src/hooks/usePositions.js',
      'src/pages/CarteraPage.jsx',
      'src/pages/Dashboard.jsx',
      'src/hooks/useDashboardData.js',
    ].map((rel) => path.join(ROOT, rel));
    for (const f of watched) {
      if (!fs.existsSync(f)) continue;
      expect(fs.readFileSync(f, 'utf8')).not.toMatch(/update_asset_market_data/);
    }
  });
});
