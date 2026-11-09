#!/usr/bin/env node
// npm run mutants — pruebas de mutación de las reglas que más cuesta ver romperse
// (regla de los dos meses, informe fiscal, deploy/deploy-vps.sh). Lista en ./mutants.mjs.
//
//   node tools/mutants/run-mutants.mjs            todos
//   node tools/mutants/run-mutants.mjs <id>...    solo esos
//   node tools/mutants/run-mutants.mjs --list     lista los ids
//
// Por cada mutante: sustituye `from` por `to` (tiene que aparecer EXACTAMENTE una vez),
// lanza vitest sobre sus tests y restaura el fichero. «killed» = algún test en rojo con el
// mutante; «SURVIVED» = pasan, así que ningún test protege esa regla; «ERROR» = vitest sale
// mal sin ningún test en rojo (no cuenta como killed). Ver ./classify.mjs.
// Sale con 1 si alguno no es killed, si un `from` no se encuentra (o es ambiguo) o si los
// tests ya fallan SIN mutar (línea base en rojo: un «killed» no significaría nada).
//
// El árbol queda como estaba, también si se corta: el original se restaura en el finally de
// cada mutante y además se guarda en disco antes de mutar.
// Si un corte duro (SIGKILL) deja un fichero mutado, la siguiente ejecución lo restaura al arrancar.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyRun } from './classify.mjs';
import { MUTANTS } from './mutants.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SANDBOX_ROOT = path.join(os.tmpdir(), 'trazza-mutants');
const RUN_PID_FILE = '.runner.pid';

let sandboxDir = null;
const abs = (rel) => path.join(sandboxDir || REPO, rel);

let active = null; // { file, original }
let runningVitest = null; // ChildProcess

function restoreActive() {
  if (!active) return;
  fs.writeFileSync(abs(active.file), active.original);
  active = null;
}

function stopRunningVitest(sig = 'SIGTERM') {
  if (!runningVitest || runningVitest.exitCode != null || runningVitest.signalCode != null) return;
  try {
    if (runningVitest.pid) process.kill(-runningVitest.pid, sig);
    else runningVitest.kill(sig);
  } catch {
    try {
      runningVitest.kill(sig);
    } catch {
      /* noop */
    }
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanupOldRuns() {
  fs.mkdirSync(SANDBOX_ROOT, { recursive: true });
  for (const entry of fs.readdirSync(SANDBOX_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('run-')) continue;
    const runDir = path.join(SANDBOX_ROOT, entry.name);
    const pidPath = path.join(runDir, RUN_PID_FILE);
    let keep = false;
    try {
      const pidRaw = fs.readFileSync(pidPath, 'utf8').trim();
      keep = isPidAlive(Number.parseInt(pidRaw, 10));
    } catch {
      keep = false;
    }
    if (!keep) fs.rmSync(runDir, { recursive: true, force: true });
  }
}

function setupSandbox() {
  if (sandboxDir) return sandboxDir;
  cleanupOldRuns();
  sandboxDir = fs.mkdtempSync(path.join(SANDBOX_ROOT, 'run-'));
  fs.cpSync(REPO, sandboxDir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(REPO, src);
      if (!rel) return true;
      const top = rel.split(path.sep)[0];
      return top !== '.git' && top !== 'node_modules' && top !== 'dist' && top !== 'coverage';
    },
  });
  fs.writeFileSync(path.join(sandboxDir, RUN_PID_FILE), `${process.pid}\n`);
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(sandboxDir, 'node_modules'), 'dir');
  return sandboxDir;
}

function cleanupSandbox() {
  if (!sandboxDir) return;
  fs.rmSync(sandboxDir, { recursive: true, force: true });
  sandboxDir = null;
}

function setupSignalHandlers() {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      stopRunningVitest(sig);
      restoreActive();
      console.error(`\n[mutants] ${sig}: fichero restaurado, corto`);
      process.exit(130);
    });
  }
  process.on('exit', () => restoreActive());
  process.on('uncaughtException', (err) => {
    stopRunningVitest('SIGTERM');
    restoreActive();
    console.error('[mutants] uncaughtException:', err?.message || err);
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    stopRunningVitest('SIGTERM');
    restoreActive();
    console.error('[mutants] unhandledRejection:', err?.message || err);
    process.exit(1);
  });
}

async function vitest(tests) {
  const env = { ...process.env, NO_COLOR: '1' };
  // Los tests de migración PG solo corren con PG_TESTS=1; sin esto el mutante
  // asset-meta-* (y los de force/ensure) se saltarían y contarían como SURVIVED.
  if (tests.some((t) => /pg20261026|migration\.test/.test(t))) {
    env.PG_TESTS = '1';
  }
  const guardScript = [
    `parent=${process.pid}`,
    'setsid npx vitest run "$@" & child=$!',
    '(while kill -0 "$parent" 2>/dev/null; do sleep 0.2; done; kill -TERM -- "-$child" 2>/dev/null) & watcher=$!',
    'wait "$child"; code=$?',
    'kill "$watcher" 2>/dev/null',
    'wait "$watcher" 2>/dev/null',
    'exit "$code"',
  ].join('; ');
  const cp = spawn('bash', ['-lc', guardScript, '--', ...tests], {
    cwd: sandboxDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  runningVitest = cp;
  let stdout = '';
  let stderr = '';
  cp.stdout?.setEncoding('utf8');
  cp.stderr?.setEncoding('utf8');
  cp.stdout?.on('data', (d) => { stdout += d; });
  cp.stderr?.on('data', (d) => { stderr += d; });

  const done = await new Promise((resolve) => {
    cp.on('close', (code, signal) => resolve({ code, signal }));
    cp.on('error', () => resolve({ code: null, signal: null }));
  });
  runningVitest = null;
  // eslint-disable-next-line no-control-regex -- quita los códigos de color ANSI
  const out = `${stdout}${stderr}`.replace(/\u001b\[[0-9;]*m/g, '');
  const summary = (out.match(/^\s*Tests\s+.*$/m) || ['(sin resumen)'])[0].trim();
  return { code: done.code, signal: done.signal, out, summary, testsFailed: /Tests\s+\d+ failed/.test(out) };
}

const occurrences = (text, needle) => text.split(needle).length - 1;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    for (const m of MUTANTS) console.log(`${m.id}\t${m.file}\t${m.why}`);
    return 0;
  }
  setupSandbox();

  const ids = new Set(MUTANTS.map((m) => m.id));
  if (ids.size !== MUTANTS.length) { console.error('[mutants] ids repetidos en mutants.mjs'); return 1; }
  const unknown = args.filter((a) => !ids.has(a));
  if (unknown.length) { console.error(`[mutants] ids desconocidos: ${unknown.join(', ')}`); return 1; }
  const selected = args.length ? MUTANTS.filter((m) => args.includes(m.id)) : MUTANTS;

  // Línea base: sin mutar, los tests de cada grupo tienen que pasar.
  const groups = [...new Set(selected.map((m) => m.tests.join(' ')))];
  for (const g of groups) {
    const base = await vitest(g.split(' '));
    if (classifyRun(base) === 'INTERRUMPIDO') {
      console.error(`[mutants] INTERRUMPIDO en la línea base (${g}): corto`);
      return 130;
    }
    if (base.code !== 0) {
      console.error(`[mutants] LÍNEA BASE EN ROJO (${g}): ${base.summary}\n${base.out.slice(-3000)}`);
      return 1;
    }
    console.log(`[mutants] línea base en verde: ${g} — ${base.summary}`);
  }

  const results = [];
  for (const m of selected) {
    const original = fs.readFileSync(abs(m.file), 'utf8');
    const n = occurrences(original, m.from);
    if (n !== 1) {
      results.push({ m, status: n === 0 ? 'NO ENCONTRADO' : `AMBIGUO (${n})`, ok: false });
      console.log(`${n === 0 ? 'NO ENCONTRADO' : `AMBIGUO (${n})`}  ${m.id}  (${m.file})`);
      continue;
    }
    active = { file: m.file, original };
    let r;
    try {
      fs.writeFileSync(abs(m.file), original.replace(m.from, () => m.to));
      r = await vitest(m.tests);
    } finally {
      restoreActive();
    }
    if (fs.readFileSync(abs(m.file), 'utf8') !== original) throw new Error(`no se pudo restaurar ${m.file}`);
    const status = classifyRun(r);
    if (status === 'INTERRUMPIDO') {
      // Ctrl-C o un kill a mitad: el hijo muere y spawnSync vuelve (los manejadores de señal
      // no corren durante una llamada síncrona). El fichero ya está restaurado por el finally.
      console.error(`[mutants] INTERRUMPIDO en ${m.id} (vitest: ${r.signal ? `señal ${r.signal}` : 'sin status'}): ${m.file} restaurado, corto sin resumen`);
      return 130;
    }
    results.push({ m, status, ok: status === 'killed' });
    const note = status === 'ERROR' ? ' (los tests no llegaron a correr: error, no un assert)'
      : status === 'SURVIVED' ? `\n          sin test que proteja: ${m.why}` : '';
    console.log(`${status.padEnd(8)}  ${m.id}  — ${r.summary}${note}`);
  }

  const bad = results.filter((x) => !x.ok);
  const killed = results.filter((x) => x.status === 'killed').length;
  console.log(`\n[mutants] ${killed}/${results.length} killed${bad.length ? `; FALLAN: ${bad.map((x) => `${x.m.id} (${x.status})`).join(', ')}` : ''}`);
  return bad.length ? 1 : 0;
}

let code = 1;
setupSignalHandlers();
try {
  code = await main();
} finally {
  stopRunningVitest('SIGTERM');
  restoreActive();
  cleanupSandbox();
}
process.exit(code);
