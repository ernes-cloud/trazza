import { describe, it, expect, vi } from 'vitest';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { onUnhandledRejection } from './app.js';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const INDEX_JS = path.join(SERVER_DIR, 'index.js');

async function occupyPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('failed to reserve port');
  return { server, port: addr.port };
}

describe('process handlers (I-2)', () => {
  it('onUnhandledRejection logs and does not exit the process', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});

    onUnhandledRejection(new Error('synthetic-unhandled-rejection'));

    expect(errorSpy).toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('EADDRINUSE on listen exits with code 1', async () => {
    const { server, port } = await occupyPort();
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
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      const exit = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* noop */ }
          reject(new Error('child did not exit after EADDRINUSE'));
        }, 7000);
        child.once('exit', (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      });

      expect(exit).toEqual({ code: 1, signal: null });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, 10000);
});
