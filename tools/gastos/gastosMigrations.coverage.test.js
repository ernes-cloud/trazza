/**
 * Contrato del setup P0-2: la semilla no cambia, y una migración de Gastos
 * posterior (p. ej. 20261111000100_expense_ownership_rls_grants.sql) no puede
 * quedar fuera de lo que applyPublishedGastosMigrations aplica.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GASTOS_MIGRATION_SEEDS,
  GASTOS_MIGRATIONS,
  lastGastosMigrationSeed,
  listGastosMigrationFilenames,
} from './gastosPgSetup.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations');

/** Independiente del helper del setup: no reutilizar isGastosMigrationFilename. */
const GASTOS_POSTERIOR_RE = /expense|savings_goals|savings_initial|recurring_end_alerts|user_preferences|core_tables_rls/;

describe('setup de migraciones de Gastos', () => {
  it('conserva la semilla (orden y conjunto) para no cambiar las bases ya existentes', () => {
    expect(listGastosMigrationFilenames().slice(0, GASTOS_MIGRATION_SEEDS.length))
      .toEqual(GASTOS_MIGRATION_SEEDS);
    expect(lastGastosMigrationSeed()).toBe('20260912_user_preferences_privacy_onboarding.sql');
  });

  it('falla si hay en supabase/migrations una migración de Gastos posterior no aplicada por el setup', () => {
    const onDisk = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const lastSeed = lastGastosMigrationSeed();
    const posterior = onDisk.filter((f) => f > lastSeed && GASTOS_POSTERIOR_RE.test(f));
    const applied = new Set(listGastosMigrationFilenames());
    const missing = posterior.filter((f) => !applied.has(f));
    expect(
      missing,
      `el setup no aplica migraciones de Gastos posteriores a ${lastSeed}: ${missing.join(', ')}`,
    ).toEqual([]);
    // Lo que se aplica es exactamente esa lista (rutas bajo supabase/migrations).
    expect(GASTOS_MIGRATIONS.map((p) => path.basename(p))).toEqual(listGastosMigrationFilenames());
  });
});
