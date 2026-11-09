/** Only embedded *.pg.test.js suites. No fallback to a remote DB or full suite. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = process.env.PG_BIN;
function fail(message) { console.error(`test:pg: ${message}`); process.exit(1); }
if (!bin) fail('falta PG_BIN. Define PG_BIN=/ruta/a/postgresql/bin (initdb, postgres, pg_ctl y psql).');
for (const executable of ['initdb', 'postgres', 'pg_ctl']) {
  try { fs.accessSync(path.join(bin, executable), fs.constants.X_OK); }
  catch { fail(`PG_BIN no válido: falta el ejecutable ${executable}.`); }
}
// Match the existing embedded harness: psql may come from the system client.
const clients = [bin, '/usr/lib/postgresql/16/bin', '/usr/bin'];
if (!clients.some((directory) => {
  try { fs.accessSync(path.join(directory, 'psql'), fs.constants.X_OK); return true; }
  catch { return false; }
})) fail('falta psql: instálalo localmente o inclúyelo en PG_BIN.');
const excluded = new Set(['node_modules', '.git', 'dist', 'coverage', '.vite']);
function discover(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory() && !excluded.has(entry.name)) return discover(full);
    return entry.isFile() && entry.name.endsWith('.pg.test.js') ? [path.relative(root, full)] : [];
  });
}
const tests = discover(root).sort();
if (!tests.length) fail('no se encontraron ficheros *.pg.test.js; no se ejecutará la suite general.');
console.log(`test:pg: PG_TESTS=1; ${tests.length} ficheros *.pg.test.js; minWorkers=1, maxWorkers=2`);
const result = spawnSync(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'),
  'run', ...tests, '--minWorkers=1', '--maxWorkers=2'], {
  cwd: root, env: { ...process.env, PG_TESTS: '1' }, stdio: 'inherit',
});
if (result.error) fail(`no se pudo iniciar Vitest: ${result.error.message}`);
process.exit(result.status ?? 1);
