import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

/**
 * Presupuesto del chunk inicial de `/`: ≤ 120 KB gzip y sin arrastrar
 * @sentry/react, @supabase/supabase-js ni framer-motion de forma estática.
 * Lee dist/.vite/manifest.json (hay que generar el build con manifest).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const MANIFEST = path.join(DIST, '.vite', 'manifest.json');
const MAX_GZIP_BYTES = 120 * 1024;

const FORBIDDEN = ['@sentry/react', '@supabase/supabase-js', 'framer-motion'];

const hasDistArtifacts =
  fs.existsSync(DIST) &&
  fs.statSync(DIST).isDirectory() &&
  fs.existsSync(MANIFEST);

if (!hasDistArtifacts && !process.env.CI) {
  console.warn('dist/ no existe: ejecuta npm run build; test saltado en local');
}

function loadManifest() {
  if (!fs.existsSync(DIST) || !fs.statSync(DIST).isDirectory()) {
    throw new Error(
      'dist/ no existe en CI: el build (npm run build) debe correr antes de este test',
    );
  }
  if (!fs.existsSync(MANIFEST)) {
    throw new Error(
      'Falta dist/.vite/manifest.json en CI: habilita build.manifest en vite y ejecuta npm run build antes',
    );
  }
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}

function entryForIndex(manifest) {
  const entry = manifest['index.html'];
  if (!entry?.file) {
    throw new Error('dist/.vite/manifest.json no tiene entry index.html con file');
  }
  return entry;
}

/** Nodos del grafo estático del entry (el propio + imports transitivos del manifest). */
function staticGraph(manifest, entry) {
  const nodes = new Map();
  const queue = [['index.html', entry]];
  while (queue.length) {
    const [key, node] = queue.pop();
    if (!node?.file || nodes.has(node.file)) continue;
    nodes.set(node.file, { key, ...node });
    for (const k of node.imports || []) {
      if (manifest[k]) queue.push([k, manifest[k]]);
    }
  }
  return [...nodes.values()];
}

// Chunks de manualChunks (vite.config.js) + rutas de node_modules del manifest.
// Buscar el nombre del paquete en el JS minificado no sirve: el bundler no lo conserva.
const FORBIDDEN_MARKS = {
  '@sentry/react': [/vendor-sentry/, /node_modules\/@sentry\//],
  '@supabase/supabase-js': [/vendor-supabase/, /node_modules\/@supabase\//],
  'framer-motion': [/vendor-motion/, /node_modules\/framer-motion\//],
};

describe.skipIf(!hasDistArtifacts && !process.env.CI)('bundle budget de /', () => {
  it('el grafo estático de / pesa ≤ 120 KB gzip y no importa sentry/supabase/framer-motion', () => {
    const manifest = loadManifest();
    const entry = entryForIndex(manifest);
    const graph = staticGraph(manifest, entry);

    let gzipBytes = 0;
    for (const node of graph) {
      const abs = path.join(DIST, node.file);
      if (!fs.existsSync(abs)) throw new Error(`Falta ${node.file} en dist/`);
      gzipBytes += gzipSync(fs.readFileSync(abs)).length;
    }
    expect(
      gzipBytes,
      `grafo estático de / (${graph.map((n) => n.file).join(', ')}) pesa ${gzipBytes} B gzip (máx ${MAX_GZIP_BYTES})`,
    ).toBeLessThanOrEqual(MAX_GZIP_BYTES);

    for (const pkg of FORBIDDEN) {
      const offenders = graph.filter((n) =>
        FORBIDDEN_MARKS[pkg].some((re) => re.test(n.file) || re.test(n.key) || re.test(n.src || '')),
      );
      expect(offenders.map((n) => n.file), `el grafo estático de / no debe incluir ${pkg}`).toEqual([]);
    }
  });
});
