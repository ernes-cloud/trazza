/** Explicit opt-in only. Setup errors with PG_TESTS=1 remain assertion failures.
 * Atomic marker emits one warning across isolated Vitest forks/threads per run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMainThread } from 'node:worker_threads';
export const PG_OMITTED_MESSAGE = 'PG tests omitidos: define PG_TESTS=1';
export function pgDescribe(describe) {
  if (process.env.PG_TESTS === '1') return describe;
  const runnerPid = isMainThread ? process.ppid : process.pid;
  const marker = path.join(os.tmpdir(), `trazza-pg-omitted-${runnerPid}.warned`);
  try {
    const fd = fs.openSync(marker, 'wx', 0o600);
    fs.closeSync(fd);
    console.warn(PG_OMITTED_MESSAGE);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return (title, body) => describe.skip(`${PG_OMITTED_MESSAGE} — ${title}`, body);
}
