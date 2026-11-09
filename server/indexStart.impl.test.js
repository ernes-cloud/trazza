/**
 * N1v2 I3 — index.js always listens (no isDirectRun), symlink + cwd=server.
 * Uses an ephemeral free port per test run to avoid collisions.
 *
 * Para TDD: asyncSafety / asyncHandler.guard pueden hacer fallback a importar
 * index.js; con arranque siempre eso haría listen. Hoy prefieren app.js — si
 * algún día el fallback se ejecuta, hay que ajustar esos tests (no los editamos).
 */
import { describe, it, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(SERVER_DIR);
const INDEX_JS = path.join(SERVER_DIR, 'index.js');

async function reserveEphemeralPort() {
  const probe = http.createServer();
  await new Promise((resolve, reject) => {
    probe.listen(0, '127.0.0.1', resolve);
    probe.on('error', reject);
  });
  const addr = probe.address();
  const port = addr && typeof addr === 'object' ? addr.port : null;
  await new Promise((resolve, reject) => probe.close((err) => (err ? reject(err) : resolve())));
  if (!port) throw new Error('failed to reserve ephemeral port');
  return port;
}

function baseEnvForPort(port) {
  return {
    ...process.env,
    PORT: String(port),
    DISABLE_CRONS: '1',
    SUPABASE_URL: 'http://127.0.0.1:9',
    VITE_SUPABASE_URL: 'http://127.0.0.1:9',
    SUPABASE_SERVICE_ROLE_KEY: 'eyJdummy.service.role',
    VITE_SUPABASE_ANON_KEY: 'eyJdummy.anon.key',
    GROQ_API_KEY: '',
  };
}

function waitHealth(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 500 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve(true);
        if (Date.now() > deadline) return reject(new Error(`health status ${res.statusCode}`));
        setTimeout(tryOnce, 100);
      });
      req.on('error', () => {
        if (Date.now() > deadline) return reject(new Error('health timeout'));
        setTimeout(tryOnce, 100);
      });
      req.on('timeout', () => {
        req.destroy();
        if (Date.now() > deadline) return reject(new Error('health timeout'));
        setTimeout(tryOnce, 100);
      });
    };
    tryOnce();
  });
}

function killChild(child) {
  if (!child || child.killed || child.exitCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, 1500);
  });
}

async function spawnAndHealth({ args, cwd, port }) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: baseEnvForPort(port),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.stdout.on('data', () => {});
  try {
    await waitHealth(port);
    return { child, stderr };
  } catch (e) {
    await killChild(child);
    throw new Error(`${e.message}; stderr=${stderr.slice(0, 500)}`);
  }
}

describe('indexStart.impl — always listens', () => {
  let child;

  afterEach(async () => {
    await killChild(child);
    child = null;
  });

  it('node server/index.js → /health 200', async () => {
    const port = await reserveEphemeralPort();
    ({ child } = await spawnAndHealth({
      args: [INDEX_JS],
      cwd: REPO_ROOT,
      port,
    }));
  }, 15000);

  it('node index.js con cwd=server/ → /health 200', async () => {
    const port = await reserveEphemeralPort();
    ({ child } = await spawnAndHealth({
      args: ['index.js'],
      cwd: SERVER_DIR,
      port,
    }));
  }, 15000);

  it('node vía symlink → /health 200 (antes isDirectRun salía 0)', async () => {
    const port = await reserveEphemeralPort();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'n1v2-idx-'));
    const link = path.join(tmp, 'index.js');
    fs.symlinkSync(INDEX_JS, link);
    try {
      ({ child } = await spawnAndHealth({
        args: [link],
        cwd: SERVER_DIR,
        port,
      }));
    } finally {
      await killChild(child);
      child = null;
      try { fs.unlinkSync(link); } catch { /* ignore */ }
      try { fs.rmdirSync(tmp); } catch { /* ignore */ }
    }
  }, 15000);
});
