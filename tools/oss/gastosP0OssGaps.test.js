/**
 * Huecos detectados al verificar la entrega oss-gastos-p0-1 (3ada2f73).
 * Contratos de producto: el export debe construir, y el cron de Gastos
 * no debe aceptar intervalos inválidos que provoquen un bucle caliente.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '../..');
const EXPORT_SCRIPT = path.join(ROOT, 'tools/oss/export-oss.mjs');
const MIN_SAFE_INTERVAL_MS = 60_000;
const MAX_SAFE_INTERVAL_MS = 2_147_483_647; // 2^31-1: Node setInterval clampa por encima a 1 ms

let exportDir = null;
const tmpDirs = [];

function mkTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function readExportOrRoot(rel) {
  const fromExport = exportDir ? path.join(exportDir, rel) : null;
  if (fromExport && fs.existsSync(fromExport)) return fs.readFileSync(fromExport, 'utf8');
  const fromRoot = path.join(ROOT, rel);
  if (fs.existsSync(fromRoot)) return fs.readFileSync(fromRoot, 'utf8');
  return null;
}

beforeAll(() => {
  if (!fs.existsSync(EXPORT_SCRIPT)) return;
  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    exportDir = ROOT;
    return;
  }
  const hashesFile = path.join(mkTmp('oss-p01-gaps-hashes-'), 'hashes.txt');
  fs.writeFileSync(hashesFile, '');
  exportDir = mkTmp('oss-p01-gaps-export-');
  const r = spawnSync(process.execPath, [EXPORT_SCRIPT, exportDir, '--hashes', hashesFile], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, OSS_FORBIDDEN_HASHES_FILE: hashesFile },
  });
  if (r.status !== 0) {
    exportDir = null;
  }
}, 180_000);

afterAll(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('P0-1 hueco — ExpensesPage del export debe resolver usePortfolioInvested', () => {
  it('el export incluye src/pages/ExpensesPage.jsx', () => {
    const page = path.join(exportDir || ROOT, 'src/pages/ExpensesPage.jsx');
    expect(fs.existsSync(page), 'falta src/pages/ExpensesPage.jsx en el export').toBe(true);
  });

  it('ExpensesPage.jsx no importa un hook ausente (usePortfolioInvested)', () => {
    const root = exportDir || ROOT;
    const page = path.join(root, 'src/pages/ExpensesPage.jsx');
    expect(fs.existsSync(page), 'falta src/pages/ExpensesPage.jsx').toBe(true);
    const src = fs.existsSync(page) ? fs.readFileSync(page, 'utf8') : '';
    const importsHook = /usePortfolioInvested/.test(src);
    const hookJs = path.join(root, 'src/hooks/usePortfolioInvested.js');
    const hookJsx = path.join(root, 'src/hooks/usePortfolioInvested.jsx');
    const present = fs.existsSync(hookJs) || fs.existsSync(hookJsx);
    expect(
      !importsHook || present,
      'src/pages/ExpensesPage.jsx importa usePortfolioInvested pero el hook no está en el export (el build de Vite falla)',
    ).toBe(true);
  });
});

describe('P0-1 hueco — intervalo de cron recurring-end acotado', () => {
  it('no se pasa Number(EXPENSES_RECURRING_END_INTERVAL_MS) || fallback crudo a setInterval', () => {
    const src = readExportOrRoot('server/jobs/notificationCron.js');
    expect(src, 'falta server/jobs/notificationCron.js en el export').toBeTruthy();
    const raw = /setInterval\(\s*runRecurringEnd\s*,\s*Number\(\s*process\.env\.EXPENSES_RECURRING_END_INTERVAL_MS\s*\)\s*\|\|/;
    expect(
      raw.test(src || ''),
      'setInterval(runRecurringEnd, Number(process.env.EXPENSES_RECURRING_END_INTERVAL_MS) || …) acepta 1 y valores negativos (bucle caliente). Hace falta validar Number.isFinite y un mínimo seguro',
    ).toBe(false);
  });

  it('el cron de recurring-end valida intervalos no finitos, ≤0 y por debajo de un mínimo seguro', () => {
    const src = readExportOrRoot('server/jobs/notificationCron.js') || '';
    expect(src, 'falta server/jobs/notificationCron.js').toBeTruthy();
    const hasFiniteCheck = /Number\.isFinite\s*\(/.test(src);
    const hasMin = new RegExp(String(MIN_SAFE_INTERVAL_MS)).test(src)
      || /Math\.max\s*\(/.test(src)
      || /MIN_.*(INTERVAL|MS)/.test(src);
    expect(
      hasFiniteCheck && hasMin,
      `server/jobs/notificationCron.js debe rechazar o acotar NaN, 0, negativos y valores < ${MIN_SAFE_INTERVAL_MS} ms`,
    ).toBe(true);
  });

  it('el cron de recurring-end rechaza o acota intervalos por encima de 2^31-1 (setInterval los trata como 1 ms)', () => {
    const src = readExportOrRoot('server/jobs/notificationCron.js') || '';
    expect(src, 'falta server/jobs/notificationCron.js').toBeTruthy();
    const hasMax = new RegExp(String(MAX_SAFE_INTERVAL_MS)).test(src)
      || /0x7fffffff/i.test(src)
      || /MAX_(SAFE_)?(RECURRING_END_)?(INTERVAL|MS)/.test(src)
      || /n\s*>\s*0x7fffffff/i.test(src);
    expect(
      hasMax,
      `server/jobs/notificationCron.js: recurringEndIntervalMs no acota valores > ${MAX_SAFE_INTERVAL_MS}; Node setInterval los convierte a 1 ms (bucle caliente). Hace falta un máximo seguro`,
    ).toBe(true);
  });
});
