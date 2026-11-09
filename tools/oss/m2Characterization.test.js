import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Caracterización T1 OSS: lista literal de los ficheros de test añadidos en
 * el diff 5f64b485..c71dfe32 (obtenida con
 * `git diff --name-only --diff-filter=A 5f64b485..c71dfe32 | grep -E "\.test\.(js|jsx)$"`).
 * Deben seguir existiendo y pasando tras la fusión de c71dfe32 sobre 5f64b485.
 *
 * Además de existir, cada fichero:
 *   - no debe contener describe/it/test .skip/.todo/.only (un caso "saltado"
 *     en silencio no es un test vivo: la fusión podría dejarlo ahí para que
 *     "exista" sin ejercitarse nunca);
 *   - debe tener, como mínimo, el nº de casos (it/test/it.each/test.each)
 *     que tiene HOY (MIN_TESTS, literal por fichero) — la fusión no puede
 *     encogerlo.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// relPath → MIN_TESTS (nº actual de it(/test(/it.each(/test.each( en el fichero).
const M2_TEST_FILES = {
  'server/jobs/notificationCron.filter.test.js': 1,
  'server/lib/cashRuleParity.test.js': 1,
  'server/routes/sharePortfolio.filter.test.js': 1,
  'src/components/SharePortfolioModal.test.jsx': 1,
  'src/hooks/useManualEntries.cash.test.js': 4,
  'src/hooks/useManualEntries.cash.v2.test.js': 16,
  'src/lib/cashIdentity.m2.test.js': 10,
  'src/lib/cashIdentity.r12.test.js': 3,
  'src/lib/cashIdentity.test.js': 9,
  'src/services/import/existingAssets.cashRefs.test.js': 10,
  'src/services/import/importPlanner.cash.test.js': 3,
  'src/services/import/importPlanner.cashCurrencyNull.test.js': 1,
};

// Cuenta solo casos "vivos": it(/test( y sus variantes .each(, nunca
// .skip/.todo/.only (esas se detectan y prohíben aparte).
const TEST_CASE_RE = /\b(it|test)(\.each)?\s*[(`]/g;
const SKIPPED_RE = /\b(describe|it|test)\.(skip|todo|only)\b/g;

function countTestCases(content) {
  return (content.match(TEST_CASE_RE) || []).length;
}

function findSkippedMarkers(content) {
  return [...content.matchAll(SKIPPED_RE)].map((m) => m[0]);
}

describe('caracterización M2 OSS (5f64b485..c71dfe32): tests añadidos siguen existiendo, vivos y sin encoger', () => {
  for (const [relPath, MIN_TESTS] of Object.entries(M2_TEST_FILES)) {
    it(`existe, sin .skip/.todo/.only y con >= ${MIN_TESTS} caso(s): ${relPath}`, () => {
      const abs = path.join(ROOT, relPath);
      expect(fs.existsSync(abs), `falta test M2 ${relPath}`).toBe(true);
      const content = fs.readFileSync(abs, 'utf8');

      expect(/\b(it|test)(\.(each|skip|only|todo))?[(`]/.test(content), `falta test M2 ${relPath}`).toBe(true);

      const skipped = findSkippedMarkers(content);
      expect(skipped, `${relPath} contiene describe/it/test .skip/.todo/.only: ${skipped.join(', ')}`).toEqual([]);

      const count = countTestCases(content);
      expect(count, `${relPath} tiene ${count} caso(s) vivo(s), por debajo del mínimo (${MIN_TESTS})`).toBeGreaterThanOrEqual(MIN_TESTS);
    });
  }
});
