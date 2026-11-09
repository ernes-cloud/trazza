/** C1 lint, no DB. Require a signature-specific authenticated EXECUTE after
 * each CREATE/REPLACE. A later REVOKE wins; DROP ends that function's lifetime.
 * Explicit opt-out immediately above CREATE: -- grant-exempt: service_role
 * Trigger functions (RETURNS trigger/event_trigger) are intrinsically excluded;
 * -- grant-exempt: trigger is also documented but must match that return type.
 * Service-only status is NEVER guessed from a missing/revoked client grant:
 * annotate it explicitly, otherwise a mistaken REVOKE would be a false green.
 */
import fs from 'node:fs';
import path from 'node:path';

function lex(sql) {
  const result = [];
  const re = /--[^\n]*|\/\*[\s\S]*?\*\/|\$[A-Za-z_0-9]*\$|'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][\w$]*|\d+|[^\s]/gy;
  let offset = 0;
  while (offset < sql.length) {
    if (/\s/.test(sql[offset])) { offset += 1; continue; }
    re.lastIndex = offset;
    const m = re.exec(sql);
    if (!m) throw new Error(`Unparsed SQL at ${offset}`);
    let raw = m[0];
    if (/^\$[\w]*\$$/.test(raw)) {
      const end = sql.indexOf(raw, re.lastIndex);
      if (end < 0) throw new Error('Unterminated dollar-quoted SQL');
      raw = sql.slice(offset, end + raw.length);
    }
    result.push({ raw, offset, comment: /^(--|\/\*)/.test(raw),
      literal: raw.startsWith("'") || raw.startsWith('$'),
      value: raw.startsWith('"') ? raw.slice(1, -1).replaceAll('""', '"') : raw.toLowerCase() });
    offset += raw.length;
  }
  return result;
}
const val = (t) => t?.value;
const is = (t, word) => !t?.literal && !t?.raw.startsWith('"') && val(t) === word;
function split(tokens) {
  const parts = [[]]; let depth = 0;
  for (const token of tokens) {
    if (val(token) === ',' && depth === 0) parts.push([]);
    else { parts.at(-1).push(token); if (val(token) === '(' || val(token) === '[') depth += 1;
      if (val(token) === ')' || val(token) === ']') depth -= 1; }
  }
  return parts.filter((p) => p.length);
}
function ident(t) {
  const value = val(t);
  return /^[a-z_][a-z_0-9$]*$/.test(value) ? value : `"${value.replaceAll('"', '""')}"`;
}
const typeStarts = new Set(('bigint bigserial bit boolean bool box bytea char character cidr circle date decimal double float float4 float8 inet int int2 int4 int8 integer interval json jsonb line lseg macaddr money numeric oid path pg_catalog point polygon real record serial smallint smallserial text time timestamp timestamptz timetz tsquery tsvector uuid varchar void xml').split(' '));
function typeName(tokens, declaration) {
  let ts = [...tokens];
  const defaultAt = ts.findIndex((t) => is(t, 'default') || val(t) === '=');
  if (defaultAt >= 0) ts = ts.slice(0, defaultAt);
  if (is(ts[0], 'out')) return null;
  if (['in', 'inout', 'variadic'].some((m) => is(ts[0], m))) ts.shift();
  if (declaration && ts.length > 1 && !['.', '[', '('].includes(val(ts[1])) && (ts[0].raw.startsWith('"') || !typeStarts.has(val(ts[0])) || typeStarts.has(val(ts[1])))) ts.shift();
  // Type modifiers do not participate in a PostgreSQL function identity.
  let depth = 0;
  ts = ts.filter((t) => { if (val(t) === '(') { depth += 1; return false; }
    if (val(t) === ')') { depth -= 1; return false; } return depth === 0; });
  let name = ts.map((t) => t.raw.startsWith('"') ? ident(t) : val(t)).join(' ')
    .replace(/\s*([.\[\]])\s*/g, '$1').replace(/^pg_catalog\./, '');
  const array = name.endsWith('[]') ? '[]' : '';
  if (array) name = name.slice(0, -2);
  const aliases = { int: 'integer', int4: 'integer', int8: 'bigint', int2: 'smallint',
    bool: 'boolean', decimal: 'numeric', float8: 'double precision', float4: 'real',
    varchar: 'character varying', char: 'character', timestamptz: 'timestamp with time zone',
    timestamp: 'timestamp without time zone', timetz: 'time with time zone', time: 'time without time zone' };
  return (aliases[name] || name) + array;
}
function signature(ts, index, declaration = false) {
  let i = index;
  const first = ts[i++];
  if (!first) throw new Error('Missing function name');
  let schema = 'public'; let name = ident(first);
  if (val(ts[i]) === '.') { schema = val(first); i += 1; name = ident(ts[i++]); }
  if (val(ts[i++]) !== '(') throw new Error(`Missing signature for ${name}`);
  const start = i; let depth = 1;
  while (i < ts.length && depth) { if (val(ts[i]) === '(') depth += 1;
    if (val(ts[i]) === ')') depth -= 1; i += 1; }
  if (depth) throw new Error(`Unclosed signature for ${name}`);
  const types = split(ts.slice(start, i - 1)).map((a) => typeName(a, declaration)).filter((a) => a !== null);
  return { key: `${schema === 'public' ? 'public' : ident(first)}.${name}(${types.join(', ')})`, schema, next: i };
}

export function auditMigrationGrants(directory) {
  const active = new Map();
  const files = fs.readdirSync(directory).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(directory, file), 'utf8');
    const tokens = lex(sql); let statement = [];
    const processStatement = () => {
      const all = statement; statement = [];
      const ts = all.filter((t) => !t.comment);
      if (!ts.length) return;
      if (is(ts[0], 'create')) {
        let i = is(ts[1], 'or') && is(ts[2], 'replace') ? 3 : 1;
        if (!is(ts[i], 'function')) return;
        const sig = signature(ts, i + 1, true);
        if (sig.schema !== 'public') return;
        const returns = ts.findIndex((t, n) => n >= sig.next && is(t, 'returns'));
        const trigger = returns >= 0 && ['trigger', 'event_trigger'].includes(val(ts[returns + 1]));
        const lineStart = sql.lastIndexOf('\n', ts[0].offset - 1);
        const previousStart = sql.lastIndexOf('\n', lineStart - 1);
        const adjacent = sql.slice(previousStart + 1, ts[0].offset);
        const marker = adjacent.match(/--\s*grant-exempt:\s*(trigger|service_role)\s*(?:--[^\n]*)?(?:\r?\n\s*)?$/i)?.[1]?.toLowerCase();
        if (marker === 'trigger' && !trigger) throw new Error(`${file}: ${sig.key}: invalid trigger exemption`);
        active.set(sig.key, { file, signature: sig.key, exempt: trigger || marker === 'service_role', granted: false });
        return;
      }
      if (is(ts[0], 'drop') && is(ts[1], 'function')) {
        let i = is(ts[2], 'if') ? 4 : 2;
        while (i < ts.length && !['cascade', 'restrict'].includes(val(ts[i]))) {
          const sig = signature(ts, i); active.delete(sig.key); i = sig.next;
          if (val(ts[i]) !== ',') break; i += 1;
        }
        return;
      }
      const grant = is(ts[0], 'grant'); const revoke = is(ts[0], 'revoke');
      if (!grant && !revoke) return;
      if (revoke && is(ts[1], 'grant') && is(ts[2], 'option')) return;
      const on = ts.findIndex((t) => is(t, 'on'));
      if (on < 0 || !ts.slice(1, on).some((t) => is(t, 'execute') || is(t, 'all'))) return;
      const roleAt = ts.findIndex((t, n) => n > on && is(t, grant ? 'to' : 'from'));
      if (roleAt < 0 || !ts.slice(roleAt + 1).some((t) => val(t) === 'authenticated')) return;
      if (is(ts[on + 1], 'all') && is(ts[on + 2], 'functions')) {
        // Broad GRANT is not the explicit per-function C1 contract; broad REVOKE invalidates it.
        if (revoke && ts.slice(on + 3, roleAt).some((t) => val(t) === 'public')) {
          for (const f of active.values()) f.granted = false;
        }
        return;
      }
      if (!is(ts[on + 1], 'function')) return;
      let i = on + 2;
      while (i < roleAt) {
        const sig = signature(ts, i);
        const f = active.get(sig.key);
        if (f) f.granted = grant;
        i = sig.next; if (val(ts[i]) !== ',') break; i += 1;
      }
    };
    for (const token of tokens) {
      if (!token.literal && val(token) === ';') processStatement(); else statement.push(token);
    }
    processStatement();
  }
  return [...active.values()].filter((f) => !f.exempt && !f.granted)
    .map((f) => `${f.file}: ${f.signature} — missing authenticated EXECUTE or adjacent -- grant-exempt: service_role`);
}
