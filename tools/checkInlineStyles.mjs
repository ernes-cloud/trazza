#!/usr/bin/env node
/**
 * Falla si algún HTML de dist/ lleva `style="…"` o `<style>` (CSP sin
 * 'unsafe-inline' en style-src). Lo usa `npm run build` (postbuild) Y
 * `npm run build:deploy` (vía checkBuild): un `npm run build` a pelo también
 * tiene que romper si el prerender deja estilos inline.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { htmlWithInlineStyles } from './checkBuild.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

export function checkInlineStyles(distDir = DIST, logger = console) {
  const styled = htmlWithInlineStyles(distDir);
  if (!styled.length) return { ok: true, styled };
  logger.error(`[checkInlineStyles] ${styled.length} HTML con estilos inline (la CSP no los aplica): ${styled.slice(0, 8).join(', ')}`);
  return { ok: false, styled };
}

export function runCli({ distDir = DIST, logger = console, exit = process.exit } = {}) {
  const r = checkInlineStyles(distDir, logger);
  return exit(r.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
