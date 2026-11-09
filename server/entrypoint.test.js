/**
 * I3 — el entrypoint real debe arrancar con `node index` (cwd=server) y también
 * vía symlink. Hoy isDirectRun compara path.resolve(argv[1]) con import.meta.url
 * resuelto: `node index` (sin .js) y symlinks fallan en silencio (exit 0 sin listen).
 *
 * Nunca usa puertos 3000/4000 — listen(0) en un helper para obtener puerto libre.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const WAIT_MS = 8000;

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on('error', reject);
  });
}

function waitForListening(child, port, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr });
    };

    const onData = (buf, target) => {
      const chunk = buf.toString();
      if (target === 'out') stdout += chunk;
      else stderr += chunk;
      if (/Listening/i.test(stdout) || /Listening/i.test(stderr)) {
        finish({ started: true, reason: 'stdout-Listening' });
      }
    };
    child.stdout?.on('data', (b) => onData(b, 'out'));
    child.stderr?.on('data', (b) => onData(b, 'err'));

    child.on('exit', (code, signal) => {
      finish({ started: false, reason: 'exited', code, signal });
    });

    const poll = setInterval(() => {
      const probe = net.connect({ host: '127.0.0.1', port }, () => {
        probe.end();
        finish({ started: true, reason: 'port-accepts' });
      });
      probe.on('error', () => {});
    }, 150);

    const timer = setTimeout(() => {
      finish({ started: false, reason: 'timeout' });
    }, timeoutMs);
  });
}

function killChild(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // ignore
  }
  const t = setTimeout(() => {
    try {
      if (child.exitCode === null) child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }, 500);
  // no unref needed in tests; afterEach awaits briefly
  void t;
}

describe('entrypoint — node index / symlink arranca', () => {
  /** @type {import('node:child_process').ChildProcess[]} */
  const children = [];
  /** @type {string[]} */
  const tempDirs = [];

  afterEach(async () => {
    for (const child of children.splice(0)) {
      killChild(child);
      await new Promise((r) => setTimeout(r, 200));
      killChild(child);
    }
    for (const dir of tempDirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  async function spawnServer({ cwd, args, envExtra = {} }) {
    const port = await freePort();
    expect([3000, 4000]).not.toContain(port);

    const env = {
      ...process.env,
      PORT: String(port),
      DISABLE_CRONS: '1',
      SUPABASE_URL: '',
      VITE_SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      GROQ_API_KEY: '',
      ...envExtra,
    };

    const child = spawn('node', args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    const result = await waitForListening(child, port, WAIT_MS);
    return { child, port, ...result };
  }

  it('arranca con cwd=server y args ["index"] (Listening o puerto acepta)', async () => {
    const result = await spawnServer({ cwd: SERVER_DIR, args: ['index'] });
    expect(
      result.started,
      `server no arrancó (reason=${result.reason}, code=${result.code}, signal=${result.signal}). stdout=${result.stdout.slice(0, 400)} stderr=${result.stderr.slice(0, 400)}`,
    ).toBe(true);
    expect(
      result.code === 0 && !result.started,
      'no debe salir con exit 0 sin escuchar',
    ).toBe(false);
  });

  it('arranca vía symlink a server/index.js', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trazza-entrypoint-'));
    tempDirs.push(tmp);
    const linkJs = path.join(tmp, 'index.js');
    fs.symlinkSync(path.join(SERVER_DIR, 'index.js'), linkJs);

    // Dependencias relativas (./app.js, ./loadEnv.js, …) viven junto al real index;
    // Node resuelve import.meta/realpath, pero argv[1] es el path del symlink.
    const result = await spawnServer({ cwd: tmp, args: [linkJs] });
    expect(
      result.started,
      `symlink entry no arrancó (reason=${result.reason}, code=${result.code}). stdout=${result.stdout.slice(0, 400)} stderr=${result.stderr.slice(0, 400)}`,
    ).toBe(true);
  });

  it('arranca vía symlink del directorio server (node index)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trazza-entrypoint-dir-'));
    tempDirs.push(tmp);
    const linkDir = path.join(tmp, 'server');
    fs.symlinkSync(SERVER_DIR, linkDir);

    const result = await spawnServer({ cwd: linkDir, args: ['index'] });
    expect(
      result.started,
      `symlink-dir + node index no arrancó (reason=${result.reason}, code=${result.code}). stdout=${result.stdout.slice(0, 400)} stderr=${result.stderr.slice(0, 400)}`,
    ).toBe(true);
  });
});
