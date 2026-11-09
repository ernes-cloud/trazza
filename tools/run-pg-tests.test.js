import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const source = fileURLToPath(new URL('./run-pg-tests.mjs', import.meta.url));
const roots = [];
function sandbox({ files = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trazza-test-pg-runner-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'tools'));
  fs.copyFileSync(source, path.join(root, 'tools/run-pg-tests.mjs'));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  for (const name of ['initdb', 'postgres', 'pg_ctl', 'psql']) fs.writeFileSync(path.join(bin, name), '# fake executable for preflight only\n', { mode: 0o700 });
  fs.mkdirSync(path.join(root, 'node_modules/vitest'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/vitest/vitest.mjs'),
    'console.log(JSON.stringify({ args: process.argv.slice(2), pg: process.env.PG_TESTS })); process.exit(Number(process.env.FAKE_VITEST_EXIT || 0));');
  fs.writeFileSync(path.join(root, 'node_modules/never.pg.test.js'), '');
  if (files) {
    fs.writeFileSync(path.join(root, 'tools/a.pg.test.js'), '');
    fs.writeFileSync(path.join(root, 'tools/b.test.js'), '');
  }
  return { root, bin };
}
function run(root, extra = {}) {
  const env = { ...process.env }; delete env.PG_BIN; delete env.PG_TESTS;
  return spawnSync(process.execPath, [path.join(root, 'tools/run-pg-tests.mjs')], { encoding: 'utf8', env: { ...env, ...extra } });
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
describe('test:pg launcher preflight and scope', () => {
  it('missing PG_BIN fails clearly before invoking Vitest', () => {
    const { root } = sandbox(); const result = run(root);
    expect(result.status).toBe(1); expect(result.stderr).toContain('falta PG_BIN');
    expect(result.stdout).not.toContain('"args"');
  });
  it('invalid binaries fail clearly', () => {
    const { root, bin } = sandbox(); fs.unlinkSync(path.join(bin, 'initdb'));
    const result = run(root, { PG_BIN: bin });
    expect(result.status).toBe(1); expect(result.stderr).toContain('falta el ejecutable initdb');
  });
  it('sets PG_TESTS=1 and selects only *.pg.test.js with bounded workers', () => {
    const { root, bin } = sandbox(); const result = run(root, { PG_BIN: bin });
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim().split('\n').at(-1));
    expect(payload).toEqual({ args: ['run', 'tools/a.pg.test.js', '--minWorkers=1', '--maxWorkers=2'], pg: '1' });
  });
  it('no PG files fails instead of running the general suite', () => {
    const { root, bin } = sandbox({ files: false }); const result = run(root, { PG_BIN: bin });
    expect(result.status).toBe(1); expect(result.stderr).toContain('no se encontraron ficheros *.pg.test.js');
  });
  it('preserves a failing Vitest exit code', () => {
    const { root, bin } = sandbox(); const result = run(root, { PG_BIN: bin, FAKE_VITEST_EXIT: '7' });
    expect(result.status).toBe(7);
  });
});
