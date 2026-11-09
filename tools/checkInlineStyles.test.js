import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkInlineStyles, runCli } from './checkInlineStyles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('checkInlineStyles (postbuild de npm run build)', () => {
  it('ok sin estilos inline', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><body><p class="x">ok</p></body></html>');
    expect(checkInlineStyles(dir, { error() {} }).ok).toBe(true);
  });

  it('falla el build si queda un style="…"', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-'));
    fs.mkdirSync(path.join(dir, 'guias'));
    fs.writeFileSync(path.join(dir, 'guias', 'index.html'), '<p style="color:red">x</p>');
    const exit = vi.fn();
    runCli({ distDir: dir, logger: { error() {} }, exit });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("falla también con style='…' (comilla simple)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cis-'));
    fs.writeFileSync(path.join(dir, 'index.html'), "<p style='color:red'>x</p>");
    expect(checkInlineStyles(dir, { error() {} }).ok).toBe(false);
  });
});

describe('postbuild llama a checkInlineStyles', () => {
  it('package.json postbuild incluye checkInlineStyles.mjs', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.postbuild).toMatch(/checkInlineStyles\.mjs/);
  });
});
