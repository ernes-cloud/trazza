#!/usr/bin/env node
/**
 * `npm run build:deploy`: el ÚNICO build que se publica (SERVIDOR.md → b y el
 * procedimiento local).
 *
 *   - Ejecuta `npm run build` (prebuild, build y postbuild), mostrando su salida y
 *     capturando stdout+stderr.
 *   - Pasa tools/checkBuild.mjs. Si algo falla, dice por qué y sale con 1; solo si
 *     todo pasa imprime «BUILD OK» y sale con 0.
 *
 * Sin las credenciales públicas de Supabase en el .env (p. ej. un build en casa sin
 * ellas) puede fallar generate-seo/prerender según la config del entorno.
 */
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkBuild } from './checkBuild.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

/**
 * Marcador de «este dist/ salió de build:deploy y pasó checkBuild»: dist/.build-deploy-ok.
 * deploy/deploy-vps.sh c0 lo exige (y que hash e index_sha256 cuadren con HEAD y con el
 * dist/index.html actual), así que un `npm run build` a pelo nunca se publica: vite vacía
 * dist/ y el marcador desaparece. No se publica (empieza por punto: c0 solo copia assets/,
 * c2 lo excluye y nginx da 404 a los ficheros con punto).
 */
export const MARKER = '.build-deploy-ok';

function defaultGitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'desconocido';
  }
}

const sha256 = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'falta');

/** `npm run build` en ROOT: reenvía la salida en vivo y la devuelve entera. */
function defaultRunBuild(env) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'build'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdout.on('data', (b) => { chunks.push(b); process.stdout.write(b); });
    child.stderr.on('data', (b) => { chunks.push(b); process.stderr.write(b); });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code: code ?? `señal ${signal}`, output: Buffer.concat(chunks).toString('utf8') }));
  });
}

export async function runBuildDeploy({
  env = process.env, runBuild = defaultRunBuild, distDir = DIST, logger = console, exit = process.exit,
  gitHead = defaultGitHead, now = () => new Date(),
} = {}) {
  // Un marcador viejo nunca puede sobrevivir a un build que falla.
  fs.rmSync(path.join(distDir, MARKER), { force: true });
  let res;
  try {
    res = await runBuild({ ...env });
  } catch (e) {
    logger.error(`[build:deploy] FALLA: no se pudo lanzar "npm run build" (${e.message})`);
    return exit(1);
  }
  const r = checkBuild({ exitCode: res.code, output: res.output, distDir, minPosts: 0 });
  if (!r.ok) {
    for (const p of r.problems) logger.error(`[build:deploy] FALLA: ${p}`);
    logger.error('[build:deploy] este dist/ NO se publica');
    return exit(1);
  }
  if (r.pages) {
    logger.log(`[build:deploy] prerender ${r.pages.done}/${r.pages.total}`);
  }
  fs.writeFileSync(path.join(distDir, MARKER), `hash=${gitHead()}\nfecha=${now().toISOString()}\n`
    + `index_sha256=${sha256(path.join(distDir, 'index.html'))}\n`);
  logger.log(`[build:deploy] marcador ${MARKER} escrito`);
  logger.log('BUILD OK');
  return exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBuildDeploy();
}
