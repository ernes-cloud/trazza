/** Test-only port leases: independent embedded clusters, no shared DB state.
 * Atomic files coordinate vitest workers AND concurrent checkouts on this box.
 * 58000..58999 avoids the legacy harness range (55433..56432).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDisposablePg } from '../../server/lib/pg20261026.harness.js';

export function acquirePgPortLease(directory = path.join(os.tmpdir(), 'trazza-rls-pg-port-leases')) {
  fs.mkdirSync(directory, { recursive: true });
  for (let offset = 0; offset < 1000; offset += 1) {
    const port = 58000 + ((process.pid + offset) % 1000);
    const file = path.join(directory, `${port}.lock`);
    let fd;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Never steal an active lease (or an empty file still being initialized).
      // Orphan leases cost one slot; no unsafe stale-lock deletion race.
      continue;
    }
    try {
      fs.writeFileSync(fd, String(process.pid));
    } catch (error) {
      fs.closeSync(fd);
      fs.unlinkSync(file);
      throw error;
    }
    fs.closeSync(fd);
    let released = false;
    return {
      port,
      release() {
        if (released) return;
        fs.unlinkSync(file);
        released = true;
      },
    };
  }
  throw new Error(`No embedded PG test ports available in ${directory}`);
}

export function startIsolatedRlsPg() {
  const lease = acquirePgPortLease();
  let pg;
  try {
    pg = startDisposablePg(lease.port);
  } catch (error) {
    lease.release();
    throw error;
  }
  if (!pg) { lease.release(); return pg; }
  const stop = pg.stop.bind(pg);
  let stopped = false;
  pg.stop = () => {
    if (stopped) return;
    stop(); // If stopping fails, keep the lease rather than reusing a live port.
    lease.release();
    stopped = true;
  };
  return pg;
}
