import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const INDEX_JS = path.join(SERVER_DIR, 'index.js');

function reserveEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : null;
      server.close((err) => {
        if (err) return reject(err);
        if (!port) return reject(new Error('failed to reserve port'));
        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function killChild(child) {
  if (!child || child.killed || child.exitCode != null) return;
  await new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, 1500);
  });
}

describe('indexScheduleCrons.impl — startup calls scheduleCrons()', () => {
  it('logs DISABLE_CRONS warning on boot (proves scheduleCrons() executed)', async () => {
    const port = await reserveEphemeralPort();
    const child = spawn(process.execPath, [INDEX_JS], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        PORT: String(port),
        DISABLE_CRONS: '1',
        SUPABASE_URL: 'http://127.0.0.1:9',
        VITE_SUPABASE_URL: 'http://127.0.0.1:9',
        SUPABASE_SERVICE_ROLE_KEY: 'eyJdummy.service.role',
        VITE_SUPABASE_ANON_KEY: 'eyJdummy.anon.key',
        GROQ_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let combined = '';
    child.stdout.on('data', (d) => { combined += d.toString(); });
    child.stderr.on('data', (d) => { combined += d.toString(); });

    try {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(combined).toContain(`Listening on http://localhost:${port}`);
      expect(combined).toContain('DISABLE_CRONS=1');
      expect(combined).toContain('NOT scheduled');
    } finally {
      await killChild(child);
    }
  }, 10000);
});
