/**
 * Las migraciones nuevas (prefijo ≥ 20261026) usan versión de 14 dígitos
 * única — la CLI de Supabase toma el prefijo numérico como PK de
 * schema_migrations; dos ficheros 20261026_* chocan al hacer push.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'supabase/migrations');

/** Prefijo numérico antes del primer `_`. */
function versionOf(filename) {
  const m = filename.match(/^(\d+)_/);
  return m ? m[1] : null;
}

describe('versiones de migración (schema_migrations)', () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

  /** Lote r15/r16 en adelante: fecha YYYYMMDD ≥ 20261026 (las previas usan 8 dígitos a menudo duplicados). */
  const neu = files.filter((f) => {
    const v = versionOf(f);
    return v && v.slice(0, 8) >= '20261026';
  });

  it('entre las nuevas (≥ 20261026): 14 dígitos exactos y sin versiones duplicadas', () => {
    expect(neu.length).toBeGreaterThanOrEqual(5);
    const seen = new Map();
    for (const f of neu) {
      const v = versionOf(f);
      expect(v, f).toMatch(/^\d{14}$/);
      expect(seen.has(v), `versión duplicada ${v}: ${seen.get(v)} y ${f}`).toBe(false);
      seen.set(v, f);
    }
    expect(neu).toEqual(expect.arrayContaining([
      '20261026000100_asset_market_data_service_role.sql',
      '20261026000200_ticker_mappings_server_only.sql',
      '20261027000100_assets_insert_server_only.sql',
      '20261028000100_force_asset_price.sql',
      '20261028000200_email_sends_revoke.sql',
      // FASE 2 revoke: ≥ 20261029000300 (000100/000200 reservadas a rebotes).
      '20261029000300_assets_insert_revoke.sql',
    ]));
    expect(neu.some((f) => f.startsWith('20261027000200_'))).toBe(false);
    // Orden lexicográfico = orden de aplicación (versión numérica).
    const versions = neu.map((f) => versionOf(f));
    expect(versions).toEqual([...versions].sort());
    // FASE 2 va DESPUÉS de force/email (28000*).
    expect(versionOf('20261029000300_assets_insert_revoke.sql')
      > versionOf('20261028000200_email_sends_revoke.sql')).toBe(true);
  });
});
