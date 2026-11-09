/**
 * N1v2 m1 — unhandledRejection logs via console.error + addLog and never process.exit.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));

const addLog = vi.hoisted(() => vi.fn());
vi.mock('./lib/logBuffer.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, addLog };
});

import { onUnhandledRejection } from './app.js';

describe('unhandledRejection.impl', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('app.js registra process.on(unhandledRejection) sin process.exit en el handler', () => {
    const src = fs.readFileSync(path.join(SERVER_DIR, 'app.js'), 'utf8');
    expect(src).toMatch(/process\.on\(\s*['"]unhandledRejection['"]/);
    expect(src).toMatch(/addLog\s*\(/);
    const start = Math.max(
      src.indexOf('function onUnhandledRejection'),
      src.indexOf('onUnhandledRejection'),
    );
    const block = src.slice(start, start + 400);
    expect(block).not.toMatch(/process\.exit\s*\(/);
  });

  it('onUnhandledRejection llama console.error + addLog y no process.exit', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    onUnhandledRejection(new Error('boom-m1-test'));

    expect(errSpy).toHaveBeenCalled();
    expect(addLog).toHaveBeenCalledWith(
      'error',
      'system',
      expect.stringContaining('unhandledRejection: boom-m1-test'),
    );
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});
