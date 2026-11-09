import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runBuildDeploy, MARKER } from './buildDeploy.mjs';

/*
 * `npm run build:deploy` OSS: sin blog. El build real se inyecta. Contrato:
 * no fuerza REQUIRE_BLOG ni BLOG_MIN_POSTS; «BUILD OK» solo si checkBuild pasa.
 */

let dist;
beforeEach(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'build-deploy-'));
  fs.mkdirSync(path.join(dist, 'blog', 'uno'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'blog', 'uno', 'index.html'), '<h1>x</h1>');
});
afterEach(() => fs.rmSync(dist, { recursive: true, force: true }));

const OK_OUT = '[generate-seo] 15 páginas + 1 artículos + 404.html\n[prerender] 17/17 páginas prerenderizadas\n';

async function run({ env = {}, code = 0, output = OK_OUT } = {}) {
  const runBuild = vi.fn(async () => ({ code, output }));
  const exit = vi.fn((c) => c);
  const logger = { log: vi.fn(), error: vi.fn() };
  const gitHead = () => 'a'.repeat(40);
  const now = () => new Date('2026-10-18T16:00:00Z');
  await runBuildDeploy({ env, runBuild, distDir: dist, logger, exit, gitHead, now });
  const out = [...logger.log.mock.calls, ...logger.error.mock.calls].flat().join('\n');
  return { runBuild, exit, logger, out };
}

describe('tools/buildDeploy', () => {
  it('no fuerza REQUIRE_BLOG ni BLOG_MIN_POSTS (blog fuera de OSS)', async () => {
    const { runBuild } = await run({ env: { PATH: '/bin' } });
    expect(runBuild).toHaveBeenCalledTimes(1);
    const envPassed = runBuild.mock.calls[0][0];
    expect(envPassed.PATH).toBe('/bin');
    expect(envPassed.REQUIRE_BLOG, 'OSS no debe fijar REQUIRE_BLOG').toBeUndefined();
    expect(envPassed.BLOG_MIN_POSTS, 'OSS no debe fijar BLOG_MIN_POSTS').toBeUndefined();
  });

  it('todo bien: imprime «BUILD OK» y sale con 0', async () => {
    const r = await run();
    expect(r.exit).toHaveBeenCalledWith(0);
    expect(r.logger.log.mock.calls.flat()).toContain('BUILD OK');
  });

  it('fetch failed: el build sale con 1 → exit 1 y sin BUILD OK', async () => {
    const r = await run({ code: 1, output: '[generate-seo] no se pudieron leer metadatos (fetch failed)\n' });
    expect(r.exit).toHaveBeenCalledWith(1);
    expect(r.out).toMatch(/salió con 1/);
    expect(r.out).not.toMatch(/BUILD OK/);
  });

  it('el build sale con 0 pero hay un AVISO o un X/Y que no cuadra → exit 1 y dice por qué', async () => {
    const r = await run({ output: `${OK_OUT.replace('17/17', '15/17')}[prerender] AVISO: sin prerender: /contact (error)\n` });
    expect(r.exit).toHaveBeenCalledWith(1);
    expect(r.out).toMatch(/AVISO/);
    expect(r.out).toMatch(/15\/17/);
    expect(r.out).not.toMatch(/BUILD OK/);
  });

  it('si el build no se puede lanzar (spawn falla), exit 1', async () => {
    const exit = vi.fn((c) => c);
    const logger = { log: vi.fn(), error: vi.fn() };
    await runBuildDeploy({ env: {}, runBuild: async () => { throw new Error('spawn npm ENOENT'); }, distDir: dist, logger, exit });
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error.mock.calls.flat().join('\n')).toMatch(/ENOENT/);
  });
});

describe('tools/buildDeploy · marcador dist/.build-deploy-ok (6.ª revisión, punto g)', () => {
  const marker = () => path.join(dist, MARKER);

  it('BUILD OK escribe el marcador con el hash de HEAD, la fecha y el sha256 de dist/index.html', async () => {
    fs.writeFileSync(path.join(dist, 'index.html'), '<html>portada</html>');
    const { exit } = await run();
    expect(exit).toHaveBeenCalledWith(0);
    const sha = crypto.createHash('sha256').update('<html>portada</html>').digest('hex');
    expect(fs.readFileSync(marker(), 'utf8')).toBe(`hash=${'a'.repeat(40)}\nfecha=2026-10-18T16:00:00.000Z\nindex_sha256=${sha}\n`);
  });

  it('un build que falla no deja marcador, y borra el que hubiera de antes', async () => {
    fs.writeFileSync(marker(), 'hash=viejo\n');
    const { exit } = await run({ code: 1 });
    expect(exit).toHaveBeenCalledWith(1);
    expect(fs.existsSync(marker())).toBe(false);
  });

  it('checkBuild en rojo (AVISO) tampoco deja marcador', async () => {
    fs.writeFileSync(marker(), 'hash=viejo\n');
    await run({ output: `${OK_OUT}[generate-seo] AVISO: algo\n` });
    expect(fs.existsSync(marker())).toBe(false);
  });
});
