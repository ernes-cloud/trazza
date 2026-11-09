/**
 * In-memory log ring buffer + SSE subscriber management.
 * All server routes import addLog() to emit observable events.
 */

const MAX_ENTRIES = 500;
const entries     = [];
const subscribers = new Set();

let _seq = 0;

export function addLog(level, service, message, meta = null) {
  const entry = {
    id:      ++_seq,
    ts:      new Date().toISOString(),
    level,   // 'ok' | 'info' | 'warn' | 'error'
    service, // 'email' | 'ai' | 'import' | 'system' | 'auth'
    message,
    meta,
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();

  const dead = [];
  for (const res of subscribers) {
    try {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    } catch {
      dead.push(res);
    }
  }
  dead.forEach(r => subscribers.delete(r));
}

export function subscribe(res) {
  subscribers.add(res);
  return () => subscribers.delete(res);
}

export function getEntries() {
  return [...entries];
}

export function subscriberCount() {
  return subscribers.size;
}
