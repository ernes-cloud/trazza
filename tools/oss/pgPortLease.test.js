import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const { startDisposablePg } = vi.hoisted(() => ({ startDisposablePg: vi.fn() }));
vi.mock('../../server/lib/pg20261026.harness.js', () => ({ startDisposablePg }));
import { acquirePgPortLease, startIsolatedRlsPg } from './pgPortLease.js';

const directories = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trazza-port-lease-test-'));
  directories.push(dir);
  return dir;
}
afterEach(() => {
  vi.resetAllMocks();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
describe('embedded PG port leases (test infrastructure)', () => {
  it('same-process clusters get distinct ports; released slots can be reused', () => {
    const dir = tempDir();
    const a = acquirePgPortLease(dir);
    const b = acquirePgPortLease(dir);
    try {
      expect(a.port).toBeGreaterThanOrEqual(58000);
      expect(a.port).toBeLessThan(59000);
      expect(b.port).not.toBe(a.port);
      a.release();
      a.release();
      const c = acquirePgPortLease(dir);
      try { expect(c.port).toBe(a.port); } finally { c.release(); }
    } finally { a.release(); b.release(); }
  });
  it('another process cannot reuse a leased port, even with the same preferred slot', () => {
    const dir = tempDir();
    const moduleUrl = new URL('./pgPortLease.js', import.meta.url).href;
    const child = `import { acquirePgPortLease } from ${JSON.stringify(moduleUrl)};
      const lease = acquirePgPortLease(${JSON.stringify(dir)});
      console.log(lease.port); lease.release();`;
    // Occupy every slot except the last one: the child must respect all locks.
    for (let port = 58000; port < 58999; port += 1) fs.writeFileSync(path.join(dir, `${port}.lock`), 'occupied');
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', child], { encoding: 'utf8' }).trim()).toBe('58999');
  });
  it('fails closed on exhaustion instead of starting on a shared default port', () => {
    const dir = tempDir();
    for (let port = 58000; port < 59000; port += 1) fs.writeFileSync(path.join(dir, `${port}.lock`), 'occupied');
    expect(() => acquirePgPortLease(dir)).toThrow('No embedded PG test ports available');
  });
  it('starts independent clusters and releases their leases after stop', () => {
    const stops = [vi.fn(), vi.fn()];
    startDisposablePg.mockReturnValueOnce({ stop: stops[0] }).mockReturnValueOnce({ stop: stops[1] });
    const a = startIsolatedRlsPg();
    const b = startIsolatedRlsPg();
    try {
      expect(startDisposablePg.mock.calls[0][0]).not.toBe(startDisposablePg.mock.calls[1][0]);
    } finally { a.stop(); a.stop(); b.stop(); }
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(stops[1]).toHaveBeenCalledTimes(1);
  });
  it('releases a failed or unavailable startup lease', () => {
    startDisposablePg.mockImplementationOnce(() => { throw new Error('startup failure'); }).mockReturnValueOnce(null);
    expect(() => startIsolatedRlsPg()).toThrow('startup failure');
    expect(startIsolatedRlsPg()).toBeNull();
    expect(startDisposablePg.mock.calls[1][0]).toBe(startDisposablePg.mock.calls[0][0]);
  });
});
