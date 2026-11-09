import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  isManifestName, extractRefs, referencedClosure, loadManifests,
  recordManifest, planClean, applyClean, runCli,
} from './cleanAssets.mjs';

/*
 * Simulación del despliegue de SERVIDOR.md en un directorio temporal:
 *   c0 → assets nuevos sin --delete; c1 → app.html y 404.html; c2 → resto de HTML
 *   con --delete (salvo assets/); e) → curl en verde; record → manifiesto.
 * Cada build falso: un index.html que carga entry.js y style.css; entry.js hace
 * import() de un chunk lazy (por "./" y por "assets/" como el __vite__mapDeps real);
 * ese chunk importa estáticamente un vendor; el CSS carga una fuente por url().
 */

let tmp;
let webroot;
let manifests;
let n = 0;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-assets-'));
  webroot = path.join(tmp, 'www');
  manifests = path.join(tmp, 'manifests');
  fs.mkdirSync(path.join(webroot, 'assets'), { recursive: true });
  fs.mkdirSync(manifests);
  n = 0;
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function makeBuild() {
  n += 1;
  const h = String(n).repeat(8).slice(0, 8);
  const id = `2026101${n}-12000${n}-abcdef${n}`;
  const dist = path.join(tmp, `dist-${n}`);
  const a = path.join(dist, 'assets');
  fs.mkdirSync(path.join(dist, 'blog', 'post'), { recursive: true });
  fs.mkdirSync(a);
  const names = {
    entry: `index-${h}.js`, css: `index-${h}.css`, lazy: `Page-${h}.js`,
    vendor: `vendor-${h}.js`, font: `inter-${h}.woff2`, blogOnly: `BlogPost-${h}.js`,
  };
  fs.writeFileSync(path.join(a, names.entry),
    `const m=()=>import("./${names.lazy}");const d=["assets/${names.lazy}","assets/${names.vendor}"];`);
  fs.writeFileSync(path.join(a, names.lazy), `import{v}from"./${names.vendor}";export default v;`);
  fs.writeFileSync(path.join(a, names.vendor), 'export const v=1;');
  fs.writeFileSync(path.join(a, names.css), `@font-face{src:url(/assets/${names.font}) format("woff2")}`);
  fs.writeFileSync(path.join(a, names.font), 'FONT');
  fs.writeFileSync(path.join(a, names.blogOnly), 'export const b=2;');
  const html = (extra = '') => `<!doctype html><html><head><script type="module" src="/assets/${names.entry}"></script>`
    + `<link rel="stylesheet" href="/assets/${names.css}">${extra}</head><body><div id="root"></div></body></html>`;
  fs.writeFileSync(path.join(dist, 'index.html'), html());
  fs.writeFileSync(path.join(dist, 'app.html'), html());
  fs.writeFileSync(path.join(dist, '404.html'), html());
  fs.writeFileSync(path.join(dist, 'blog', 'post', 'index.html'), html(`<link rel="modulepreload" href="/assets/${names.blogOnly}">`));
  fs.writeFileSync(path.join(dist, 'robots.txt'), 'User-agent: *');
  return { dist, id, names, all: Object.values(names) };
}

/**
 * Build con un chunk de 2.º nivel que SOLO se alcanza por el cierre transitivo:
 * index.html → entry.js → import() de lazy.js → import de deep.js. Nadie más nombra
 * deep.js (ni el HTML ni el entry), así que sin seguir lazy.js no se encuentra.
 */
function makeDeepBuild() {
  n += 1;
  const h = `d${String(n).repeat(7).slice(0, 7)}`;
  const dist = path.join(tmp, `dist-deep-${n}`);
  const a = path.join(dist, 'assets');
  fs.mkdirSync(a, { recursive: true });
  const names = { entry: `entry-${h}.js`, lazy: `lazy-${h}.js`, deep: `deep-${h}.js` };
  fs.writeFileSync(path.join(a, names.entry), `const m=()=>import("./${names.lazy}");`);
  fs.writeFileSync(path.join(a, names.lazy), `import{d}from"./${names.deep}";export default d;`);
  fs.writeFileSync(path.join(a, names.deep), 'export const d=1;');
  const html = `<!doctype html><html><head><script type="module" src="/assets/${names.entry}"></script></head><body></body></html>`;
  for (const f of ['index.html', 'app.html', '404.html']) fs.writeFileSync(path.join(dist, f), html);
  return { dist, names, all: Object.values(names) };
}

const copyDir = (src, dst) => fs.cpSync(src, dst, { recursive: true });

/** c0: assets sin --delete. */
function c0(b) { copyDir(path.join(b.dist, 'assets'), path.join(webroot, 'assets')); }
/** c1 + c2: HTML y demás con --delete, sin tocar assets/. */
function c2(b) {
  for (const e of fs.readdirSync(webroot)) if (e !== 'assets') fs.rmSync(path.join(webroot, e), { recursive: true });
  for (const e of fs.readdirSync(b.dist)) if (e !== 'assets') copyDir(path.join(b.dist, e), path.join(webroot, e));
}
function deploy(b) {
  c0(b);
  c2(b);
  const r = recordManifest({ distDir: b.dist, webroot, manifestsDir: manifests, id: b.id });
  expect(r.ok, r.reason).toBe(true);
}

const assetsNow = () => new Set(fs.readdirSync(path.join(webroot, 'assets')));
/** Lo que usa el HTML publicado: nunca se puede borrar. */
function publishedInUse(b) { return b.all; }
function expectPublishedIntact(b) {
  const now = assetsNow();
  for (const name of publishedInUse(b)) expect(now.has(name), `borró ${name}, que usa el HTML publicado`).toBe(true);
}

describe('isManifestName', () => {
  it('solo cuenta ficheros con el patrón <fecha>-<hora>-<hash>.txt', () => {
    expect(isManifestName('20261018-120000-abc1234.txt')).toBe(true);
    expect(isManifestName('20261018-120000-0123456789abcdef0123456789abcdef01234567.txt')).toBe(true);
    for (const bad of ['llms.txt', 'robots.txt', '20261018-120000-abc12.txt', '20261018-120000-ABC1234.txt',
      '.20261018-120000-abc1234.txt.tmp', '20261018-120000-abc1234.txt.bak', 'x20261018-120000-abc1234.txt']) {
      expect(isManifestName(bad), bad).toBe(false);
    }
  });
});

describe('extractRefs', () => {
  const known = new Set(['a-1.js', 'b-2.js', 'c-3.css', 'f-4.woff2', 'g-5.js', 'h-6.svg']);
  it('encuentra /assets/x, assets/x, ./x y url() (con y sin comillas)', () => {
    const txt = '<script src="/assets/a-1.js"></script> import("./b-2.js") ["assets/c-3.css"] '
      + 'url(/assets/f-4.woff2) url("./h-6.svg") from"./g-5.js"';
    expect([...extractRefs(txt, known)].sort()).toEqual(['a-1.js', 'b-2.js', 'c-3.css', 'f-4.woff2', 'g-5.js', 'h-6.svg']);
  });
  it('ignora lo que no existe en assets/', () => {
    expect([...extractRefs('import("./nope.js") "/assets/zz.js"', known)]).toEqual([]);
  });
});

describe('referencedClosure', () => {
  it('sigue HTML → entry → import() → vendor, y CSS → url(), en todos los .html (recursivo)', () => {
    const b = makeBuild();
    deploy(b);
    const { refs } = referencedClosure(webroot);
    expect([...refs].sort()).toEqual([...b.all].sort());
  });

  it('es transitivo: index.html → entry → import() lazy → import deep (2.º nivel)', () => {
    const x = makeDeepBuild();
    copyDir(path.join(x.dist, 'assets'), path.join(webroot, 'assets'));
    fs.copyFileSync(path.join(x.dist, 'index.html'), path.join(webroot, 'index.html'));
    const { refs, indexRefs } = referencedClosure(webroot);
    expect([...refs].sort()).toEqual([...x.all].sort());
    expect(indexRefs.has(x.names.deep)).toBe(true);
  });
});

describe('recordManifest', () => {
  it('escribe el manifiesto (lista ordenada de dist/assets) sin dejar temporales', () => {
    const b = makeBuild();
    c0(b); c2(b);
    const r = recordManifest({ distDir: b.dist, webroot, manifestsDir: manifests, id: b.id });
    expect(r.ok).toBe(true);
    expect(fs.readdirSync(manifests)).toEqual([`${b.id}.txt`]);
    expect(fs.readFileSync(path.join(manifests, `${b.id}.txt`), 'utf8').trim().split('\n')).toEqual([...b.all].sort());
  });

  it('rechaza un build que NO es el publicado (no cubre lo que carga el index.html del webroot)', () => {
    const b1 = makeBuild(); deploy(b1);
    const b2 = makeBuild(); c0(b2); // abortado tras c0: el HTML publicado sigue siendo b1
    const r = recordManifest({ distDir: b2.dist, webroot, manifestsDir: manifests, id: b2.id });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/index\.html/);
    expect(fs.readdirSync(manifests)).toEqual([`${b1.id}.txt`]);
  });

  it('rechaza si algún asset de dist no está en webroot/assets (no se hizo c0)', () => {
    const b1 = makeBuild();
    c2(b1);
    const r = recordManifest({ distDir: b1.dist, webroot, manifestsDir: manifests, id: b1.id });
    expect(r.ok).toBe(false);
    expect(fs.readdirSync(manifests)).toEqual([]);
  });

  it('rechaza si dist/assets tiene un asset que no está en webroot/assets (c0 incompleto), aunque el index esté cubierto', () => {
    const b = makeBuild();
    c0(b); c2(b);
    // Un chunk del build que no llegó al webroot: el index.html publicado no lo carga, así
    // que solo lo detecta la comprobación «todo dist/assets está en webroot/assets».
    fs.writeFileSync(path.join(b.dist, 'assets', 'Missing-99999999.js'), 'export{}');
    const r = recordManifest({ distDir: b.dist, webroot, manifestsDir: manifests, id: b.id });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no están en webroot\/assets/);
    expect(r.reason).toContain('Missing-99999999.js');
    expect(fs.readdirSync(manifests)).toEqual([]);
  });

  it('rechaza dist/assets vacío, un id con otro formato y sobrescribir un manifiesto', () => {
    const b = makeBuild(); deploy(b);
    expect(recordManifest({ distDir: b.dist, webroot, manifestsDir: manifests, id: 'llms' }).ok).toBe(false);
    expect(recordManifest({ distDir: b.dist, webroot, manifestsDir: manifests, id: b.id }).ok).toBe(false);
    const empty = path.join(tmp, 'empty-dist');
    fs.mkdirSync(path.join(empty, 'assets'), { recursive: true });
    expect(recordManifest({ distDir: empty, webroot, manifestsDir: manifests, id: '20261020-000000-fffffff' }).ok).toBe(false);
  });
});

describe('planClean / applyClean: simulación de despliegues', () => {
  it('1 despliegue: con keep=2 aborta sin borrar nada', () => {
    const b1 = makeBuild(); deploy(b1);
    const before = assetsNow();
    const p = planClean({ webroot, manifestsDir: manifests, keep: 2 });
    expect(p.ok).toBe(false);
    expect(p.reason).toMatch(/manifiestos válidos/);
    expect(assetsNow()).toEqual(before);
  });

  it('2 despliegues: conserva los dos builds y no borra nada (más los restos de antes del plan, que sí se borran)', () => {
    fs.writeFileSync(path.join(webroot, 'assets', 'old-legacy.js'), 'old');
    const b1 = makeBuild(); deploy(b1);
    const b2 = makeBuild(); deploy(b2);
    const p = planClean({ webroot, manifestsDir: manifests, keep: 2 });
    expect(p.ok, p.reason).toBe(true);
    expect(p.remove).toEqual(['old-legacy.js']);
    applyClean({ webroot, remove: p.remove });
    expectPublishedIntact(b2);
    for (const name of b1.all) expect(assetsNow().has(name)).toBe(true); // pestañas abiertas con b1
  });

  it('3 despliegues: borra solo los chunks del primero', () => {
    const b1 = makeBuild(); deploy(b1);
    const b2 = makeBuild(); deploy(b2);
    const b3 = makeBuild(); deploy(b3);
    const p = planClean({ webroot, manifestsDir: manifests, keep: 2 });
    expect(p.ok, p.reason).toBe(true);
    expect(p.remove).toEqual([...b1.all].sort());
    applyClean({ webroot, remove: p.remove });
    expectPublishedIntact(b3);
    for (const name of b2.all) expect(assetsNow().has(name)).toBe(true);
  });

  it('manifiesto vacío: no cuenta como válido (y con keep=2 aborta)', () => {
    const b1 = makeBuild(); deploy(b1);
    const b2 = makeBuild(); deploy(b2);
    fs.writeFileSync(path.join(manifests, `${b1.id}.txt`), '');
    const p = planClean({ webroot, manifestsDir: manifests, keep: 2 });
    expect(p.ok).toBe(false);
    expect(p.invalid.map((m) => m.file)).toContain(`${b1.id}.txt`);
  });

  it('manifiesto truncado a mitad de nombre: no es válido; si es el último, aborta', () => {
    const b1 = makeBuild(); deploy(b1);
    const b2 = makeBuild(); deploy(b2);
    const file = path.join(manifests, `${b2.id}.txt`);
    const txt = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, txt.slice(0, txt.length - 8));
    const before = assetsNow();
    const p = planClean({ webroot, manifestsDir: manifests, keep: 1 });
    // El último válido es el de b1, que no cubre el index.html publicado (b2).
    expect(p.ok).toBe(false);
    expect(p.reason).toMatch(/index\.html/);
    expect(assetsNow()).toEqual(before);
  });

  it('dos despliegues abortados tras c0 (sin manifiesto): se borran sus chunks, nunca los del HTML publicado', () => {
    const b1 = makeBuild(); deploy(b1);
    const b2 = makeBuild(); deploy(b2);
    const x1 = makeBuild(); c0(x1);
    const x2 = makeBuild(); c0(x2);
    const p = planClean({ webroot, manifestsDir: manifests, keep: 2 });
    expect(p.ok, p.reason).toBe(true);
    expect(p.remove).toEqual([...x1.all, ...x2.all].sort());
    applyClean({ webroot, remove: p.remove });
    expectPublishedIntact(b2);
  });

  it('despliegue abortado tras c1 (app.html/404.html nuevos, sin manifiesto): lo que cargan se conserva', () => {
    const b1 = makeBuild(); deploy(b1);
    const b2 = makeBuild(); deploy(b2);
    const x = makeBuild(); c0(x);
    fs.copyFileSync(path.join(x.dist, 'app.html'), path.join(webroot, 'app.html'));
    const p = planClean({ webroot, manifestsDir: manifests, keep: 2 });
    expect(p.ok, p.reason).toBe(true);
    const removed = new Set(p.remove);
    for (const name of [x.names.entry, x.names.css, x.names.lazy, x.names.vendor, x.names.font]) {
      expect(removed.has(name), name).toBe(false);
    }
    applyClean({ webroot, remove: p.remove });
    expectPublishedIntact(b2);
  });

  it('manifiesto escrito a mano de un build NO publicado: aborta (el más reciente no cubre el index.html)', () => {
    const b1 = makeBuild(); deploy(b1);
    const b2 = makeBuild(); deploy(b2);
    const x = makeBuild(); c0(x);
    fs.writeFileSync(path.join(manifests, `${x.id}.txt`), `${[...x.all].sort().join('\n')}\n`);
    const before = assetsNow();
    const p = planClean({ webroot, manifestsDir: manifests, keep: 2 });
    expect(p.ok).toBe(false);
    expect(p.reason).toMatch(/index\.html/);
    expect(assetsNow()).toEqual(before);
  });

  it('llms.txt y robots.txt en el directorio de manifiestos no cuentan', () => {
    const b1 = makeBuild(); deploy(b1);
    fs.writeFileSync(path.join(manifests, 'llms.txt'), 'index-11111111.js\n');
    fs.writeFileSync(path.join(manifests, 'robots.txt'), 'User-agent: *\n');
    const p = planClean({ webroot, manifestsDir: manifests, keep: 2 });
    expect(p.ok).toBe(false); // solo hay 1 manifiesto de verdad
    expect(p.reason).toMatch(/1 manifiestos válidos/);
  });

  it('sin index.html en el webroot aborta', () => {
    const b1 = makeBuild(); deploy(b1);
    const b2 = makeBuild(); deploy(b2);
    fs.rmSync(path.join(webroot, 'index.html'));
    const p = planClean({ webroot, manifestsDir: manifests, keep: 2 });
    expect(p.ok).toBe(false);
    expect(p.reason).toMatch(/index\.html/);
  });

  // Redespliegue del mismo commit (reintento, re-publicación): record lo acepta con un id
  // nuevo, así que los dos manifiestos más recientes describen el MISMO build. keep cuenta
  // builds DISTINTOS: si no, el anterior se borraría y sus pestañas abiertas darían 404.
  const REDEPLOY_ID = '20261099-120000-abcdef9';

  it('redespliegue del mismo build (A, B, B con id nuevo): se conservan A y B', () => {
    const a = makeBuild(); deploy(a);
    const b = makeBuild(); deploy(b);
    c0(b); c2(b);
    const r = recordManifest({ distDir: b.dist, webroot, manifestsDir: manifests, id: REDEPLOY_ID });
    expect(r.ok, r.reason).toBe(true);
    const p = planClean({ webroot, manifestsDir: manifests, keep: 2 });
    expect(p.ok, p.reason).toBe(true);
    expect(p.remove).toEqual([]);
    applyClean({ webroot, remove: p.remove });
    for (const name of [...a.all, ...b.all]) expect(assetsNow().has(name), name).toBe(true);
  });

  it('redespliegue con el manifiesto duplicado en CRLF, en otro orden y con espacios finales: se DEDUPLICA (no se descarta)', () => {
    const a = makeBuild(); deploy(a);
    const b = makeBuild(); deploy(b);
    fs.writeFileSync(path.join(manifests, `${REDEPLOY_ID}.txt`), `${[...b.all].sort().reverse().map((x) => `${x} `).join('\r\n')}\r\n`);
    const p = planClean({ webroot, manifestsDir: manifests, keep: 2 });
    expect(p.ok, p.reason).toBe(true);
    // Válido y deduplicado: si el CRLF o los espacios lo hicieran inválido, el resultado
    // sería el mismo por otro motivo (5.ª revisión, hallazgo 6, mutación D3).
    expect(p.invalid).toEqual([]);
    expect(p.manifests).toEqual([`${a.id}.txt`, `${REDEPLOY_ID}.txt`]);
    expect(p.remove).toEqual([]);
    applyClean({ webroot, remove: p.remove });
    for (const name of [...a.all, ...b.all]) expect(assetsNow().has(name), name).toBe(true);
  });

  it('redespliegue: el más reciente de los duplicados es el que cuenta', () => {
    const a = makeBuild(); deploy(a);
    const b = makeBuild(); deploy(b);
    c0(b); c2(b);
    expect(recordManifest({ distDir: b.dist, webroot, manifestsDir: manifests, id: REDEPLOY_ID }).ok).toBe(true);
    const p = planClean({ webroot, manifestsDir: manifests, keep: 2 });
    expect(p.manifests).toEqual([`${a.id}.txt`, `${REDEPLOY_ID}.txt`]);
  });

  it('dos manifiestos del mismo build y nada más: menos de keep builds distintos, aborta sin borrar', () => {
    fs.writeFileSync(path.join(webroot, 'assets', 'old-legacy.js'), 'old');
    const a = makeBuild(); deploy(a);
    c0(a); c2(a);
    expect(recordManifest({ distDir: a.dist, webroot, manifestsDir: manifests, id: REDEPLOY_ID }).ok).toBe(true);
    const before = assetsNow();
    const p = planClean({ webroot, manifestsDir: manifests, keep: 2 });
    expect(p.ok).toBe(false);
    expect(p.reason).toMatch(/1 builds? distintos?/);
    expect(p.remove).toEqual([]);
    expect(assetsNow()).toEqual(before);
  });

  it('un nombre raro en assets/ (con espacio): aborta ANTES de calcular nada y lo nombra', () => {
    const b1 = makeBuild(); deploy(b1);
    const b2 = makeBuild(); deploy(b2);
    const b3 = makeBuild(); deploy(b3);
    fs.writeFileSync(path.join(webroot, 'assets', 'aaa junk.js'), 'x');
    fs.writeFileSync(path.join(webroot, 'assets', 'zzz$raro.js'), 'x');
    const p = planClean({ webroot, manifestsDir: manifests, keep: 2 });
    expect(p.ok).toBe(false);
    expect(p.reason).toMatch(/2 nombre\(s\) que no son/);
    expect(p.reason).toContain('aaa junk.js');
    expect(p.reason).toContain('zzz$raro.js');
    expect(p.remove).toEqual([]);
  });

  it('applyClean: un nombre inválido entre válidos lanza y NO borra ninguno', () => {
    const b1 = makeBuild(); deploy(b1);
    const before = assetsNow();
    const remove = [b1.names.blogOnly, '../www/index.html', b1.names.vendor];
    expect(() => applyClean({ webroot, remove })).toThrow(/nombre inesperado/);
    expect(assetsNow()).toEqual(before);
    expect(fs.existsSync(path.join(webroot, 'index.html'))).toBe(true);
  });

  // 5.ª revisión, hallazgo 2: los nombres se validan todos ANTES, pero un fallo del
  // sistema de ficheros a mitad (un candidato que pasa a ser un directorio, EIO…) deja
  // borrados los anteriores. Lo honesto es parar en ese fichero y decir cuántos se
  // borraron, en cuál falló y cuántos ya no estaban.
  it('applyClean: un DIRECTORIO con el nombre de un candidato posterior para ahí, sin borrarlo, y dice cuántos borró', () => {
    const b1 = makeBuild(); deploy(b1);
    const b2 = makeBuild(); deploy(b2);
    const b3 = makeBuild(); deploy(b3);
    const p = planClean({ webroot, manifestsDir: manifests, keep: 2 });
    expect(p.ok, p.reason).toBe(true);
    const remove = p.remove;
    expect(remove.length).toBeGreaterThanOrEqual(4);
    const k = 2; // se borran los 2 primeros y falla en el 3.º
    const victim = remove[k];
    fs.rmSync(path.join(webroot, 'assets', victim));
    fs.mkdirSync(path.join(webroot, 'assets', victim));
    fs.writeFileSync(path.join(webroot, 'assets', victim, 'dentro.txt'), 'x');

    let err;
    try { applyClean({ webroot, remove }); } catch (e) { err = e; }
    expect(err, 'tenía que lanzar').toBeTruthy();
    expect(err.progress).toMatchObject({ removed: k, missing: 0, failedAt: victim, total: remove.length });
    expect(err.progress.error).toMatch(/EISDIR|EPERM|directory/i);
    expect(err.message).toMatch(new RegExp(`borrados ${k} de ${remove.length}.*falló en ${victim.replace(/\./g, '\\.')}`));
    // El directorio sigue ahí, con lo que tenía dentro; los anteriores se borraron y los posteriores no.
    expect(fs.statSync(path.join(webroot, 'assets', victim)).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(webroot, 'assets', victim, 'dentro.txt'))).toBe(true);
    for (const x of remove.slice(0, k)) expect(assetsNow().has(x), x).toBe(false);
    for (const x of remove.slice(k + 1)) expect(assetsNow().has(x), x).toBe(true);
    expectPublishedIntact(b3);
  });

  it('applyClean: un candidato que desaparece entre plan y apply va a missing y NO cuenta como borrado', () => {
    const b1 = makeBuild(); deploy(b1);
    const b2 = makeBuild(); deploy(b2);
    const b3 = makeBuild(); deploy(b3);
    const p = planClean({ webroot, manifestsDir: manifests, keep: 2 });
    expect(p.ok, p.reason).toBe(true);
    fs.rmSync(path.join(webroot, 'assets', p.remove[1]));
    const r = applyClean({ webroot, remove: p.remove });
    expect(r).toEqual({ removed: p.remove.length - 1, missing: 1, total: p.remove.length, failedAt: null, error: null });
    for (const x of p.remove) expect(assetsNow().has(x), x).toBe(false);
  });

  it('cierre transitivo SIN red de seguridad: el chunk de 2.º nivel de un despliegue abortado tras c1 se conserva', () => {
    const b1 = makeBuild(); deploy(b1);
    const b2 = makeBuild(); deploy(b2);
    const x = makeDeepBuild();
    copyDir(path.join(x.dist, 'assets'), path.join(webroot, 'assets'));
    fs.copyFileSync(path.join(x.dist, 'app.html'), path.join(webroot, 'app.html'));
    // Sin la red: lo único que puede salvar deep.js es haber seguido lazy.js.
    const p = planClean({ webroot, manifestsDir: manifests, keep: 2, safetyNet: false });
    expect(p.ok, p.reason).toBe(true);
    expect(p.keep).toContain(x.names.deep);
    expect(p.remove).not.toContain(x.names.deep);
    expect(p.remove).toEqual([]);
  });

  it('un manifiesto con nombres que ya no están en assets/ se ignora (invalid) y no cuenta como versión', () => {
    const b1 = makeBuild(); deploy(b1);
    const b2 = makeBuild(); deploy(b2);
    const b3 = makeBuild(); deploy(b3);
    applyClean({ webroot, remove: planClean({ webroot, manifestsDir: manifests, keep: 2 }).remove }); // se va b1
    fs.rmSync(path.join(manifests, `${b2.id}.txt`)); // queda b1 (ya limpiado) y b3
    const before = assetsNow();
    const p = planClean({ webroot, manifestsDir: manifests, keep: 2 });
    expect(p.invalid.map((m) => m.file)).toEqual([`${b1.id}.txt`]);
    expect(p.invalid[0].reason).toMatch(/ya no están en assets/);
    expect(p.ok).toBe(false);
    expect(p.reason).toMatch(/1 manifiestos válidos/);
    expect(p.remove).toEqual([]);
    expect(assetsNow()).toEqual(before);
  });

  it('red de seguridad: si un candidato aparece como cadena en lo conservado, aborta', () => {
    const b1 = makeBuild(); deploy(b1);
    const b2 = makeBuild(); deploy(b2);
    const b3 = makeBuild(); deploy(b3);
    // Una referencia que la extracción no sigue (un nombre suelto, sin ./ ni assets/).
    fs.appendFileSync(path.join(webroot, 'assets', b3.names.vendor), `;const s="${b1.names.blogOnly}";`);
    const p = planClean({ webroot, manifestsDir: manifests, keep: 2 });
    expect(p.ok).toBe(false);
    expect(p.reason).toMatch(/red de seguridad/);
    expect(p.reason).toContain(b1.names.blogOnly);
    expect(p.remove).toEqual([]); // un plan abortado nunca lleva nada que borrar
  });
});

describe('symlinks en el webroot fuera de assets/: abortan, ni se siguen ni se ignoran', () => {
  // Un HTML detrás de un symlink no se veía (d.isDirectory()/isFile() son false para un
  // enlace), así que lo que cargaba se borraba. Ante la duda, se aborta y se nombra.
  const setup = () => {
    const b1 = makeBuild(); deploy(b1);
    const b2 = makeBuild(); deploy(b2);
    const b3 = makeBuild(); c0(b3); c2(b3); // publicado, sin record todavía
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'page.html'), `<script src="/assets/${b1.names.blogOnly}"></script>`);
    return { b1, b2, b3, outside };
  };

  it.each([
    ['fichero', (o) => fs.symlinkSync(path.join(o, 'page.html'), path.join(webroot, 'enlace.html')), 'enlace.html'],
    ['directorio', (o) => fs.symlinkSync(o, path.join(webroot, 'blog', 'enlazado'), 'dir'), path.join('blog', 'enlazado')],
  ])('symlink a %s: planClean y record abortan nombrándolo, sin borrar ni escribir', (_kind, link, shown) => {
    const { b3, outside } = setup();
    link(outside);
    const assetsBefore = [...assetsNow()].sort();
    const manBefore = fs.readdirSync(manifests).sort();

    const p = planClean({ webroot, manifestsDir: manifests, keep: 2 });
    expect(p.ok).toBe(false);
    expect(p.reason).toMatch(/symlink/);
    expect(p.reason).toContain(shown);
    expect(p.remove).toEqual([]);

    const r = recordManifest({ distDir: b3.dist, webroot, manifestsDir: manifests, id: b3.id });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/symlink/);
    expect(r.reason).toContain(shown);

    expect([...assetsNow()].sort()).toEqual(assetsBefore);
    expect(fs.readdirSync(manifests).sort()).toEqual(manBefore);
  });
});

describe('dentro de assets/: lo que no sea un fichero regular aborta (5.ª revisión, hallazgo 5)', () => {
  const ls = () => fs.readdirSync(path.join(webroot, 'assets')).sort();
  const cli = (argv) => runCli(argv, { exit: (c) => c, logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } });

  it('chunk VIVO sustituido por un symlink: clean y record abortan, lo nombran y no se borra ni escribe nada', () => {
    const b1 = makeBuild(); deploy(b1);
    const b2 = makeBuild(); deploy(b2);
    const b3 = makeBuild(); deploy(b3); // b1 sobra: sin la comprobación, habría candidatos
    const live = path.join(webroot, 'assets', b3.names.lazy);
    const target = path.join(tmp, 'fuera-lazy.js');
    fs.copyFileSync(live, target);
    fs.rmSync(live);
    fs.symlinkSync(target, live);
    const before = ls();
    const manBefore = fs.readdirSync(manifests).sort();

    const p = planClean({ webroot, manifestsDir: manifests, keep: 2 });
    expect(p.ok).toBe(false);
    expect(p.reason).toMatch(/no son ficheros regulares/);
    expect(p.reason).toContain(`${b3.names.lazy} (symlink)`);
    expect(p.remove).toEqual([]);
    expect(cli(['clean', '--webroot', webroot, '--manifests', manifests, '--apply'])).toBe(1);

    const r = recordManifest({ distDir: b3.dist, webroot, manifestsDir: manifests, id: '20261098-120000-abcdef8' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no son ficheros regulares/);

    expect(ls()).toEqual(before);
    expect(fs.readdirSync(manifests).sort()).toEqual(manBefore);
  });

  it('una FIFO dentro de assets/ también aborta (ni directorio ni symlink: «otro»)', () => {
    const b1 = makeBuild(); deploy(b1);
    const b2 = makeBuild(); deploy(b2);
    const b3 = makeBuild(); deploy(b3);
    execFileSync('mkfifo', [path.join(webroot, 'assets', 'cola-1234abcd.js')]);
    const before = ls();
    const p = planClean({ webroot, manifestsDir: manifests, keep: 2 });
    expect(p.ok).toBe(false);
    expect(p.reason).toContain('cola-1234abcd.js (otro)');
    expect(p.remove).toEqual([]);
    expect(cli(['clean', '--webroot', webroot, '--manifests', manifests, '--apply'])).toBe(1);
    const r = recordManifest({ distDir: b3.dist, webroot, manifestsDir: manifests, id: '20261097-120000-abcdef7' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('cola-1234abcd.js (otro)');
    expect(ls()).toEqual(before);
  });

  it('un directorio dentro de assets/ también aborta', () => {
    const b1 = makeBuild(); deploy(b1);
    const b2 = makeBuild(); deploy(b2);
    const b3 = makeBuild(); deploy(b3);
    fs.mkdirSync(path.join(webroot, 'assets', 'sub'));
    const before = ls();
    const p = planClean({ webroot, manifestsDir: manifests, keep: 2 });
    expect(p.ok).toBe(false);
    expect(p.reason).toContain('sub (directorio)');
    expect(cli(['clean', '--webroot', webroot, '--manifests', manifests, '--apply'])).toBe(1);
    expect(ls()).toEqual(before);
  });
});

describe('runCli', () => {
  const run = (argv) => {
    const exit = vi.fn((c) => c);
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const code = runCli(argv, { exit, logger });
    return { code, exit, logger, out: [...logger.log.mock.calls, ...logger.error.mock.calls].flat().join('\n') };
  };

  it('sin subcomando o sin argumentos obligatorios: exit ≠ 0', () => {
    expect(run([]).code).not.toBe(0);
    expect(run(['clean', '--webroot', webroot]).code).not.toBe(0);
    expect(run(['record', '--dist', 'x', '--webroot', webroot, '--manifests', manifests]).code).not.toBe(0);
    expect(run(['clean', '--webroot', webroot, '--manifests', manifests, '--keep', '0']).code).not.toBe(0);
  });

  it('rutas relativas: exit ≠ 0 (siempre absolutas, nunca cd)', () => {
    expect(run(['clean', '--webroot', 'www', '--manifests', manifests]).code).not.toBe(0);
  });

  it('directorio inexistente: exit ≠ 0 sin borrar nada', () => {
    const b1 = makeBuild(); deploy(b1);
    const b2 = makeBuild(); deploy(b2);
    const before = assetsNow();
    expect(run(['clean', '--webroot', webroot, '--manifests', path.join(tmp, 'no-existe'), '--apply']).code).not.toBe(0);
    expect(run(['clean', '--webroot', path.join(tmp, 'no-existe'), '--manifests', manifests, '--apply']).code).not.toBe(0);
    expect(assetsNow()).toEqual(before);
  });

  it('dry-run lista y no borra; --apply borra lo mismo que listó', () => {
    const b1 = makeBuild(); deploy(b1);
    const b2 = makeBuild(); deploy(b2);
    const b3 = makeBuild(); deploy(b3);
    const dry = run(['clean', '--webroot', webroot, '--manifests', manifests]);
    expect(dry.code).toBe(0);
    for (const name of b1.all) {
      expect(assetsNow().has(name)).toBe(true);
      expect(dry.out).toContain(name);
    }
    expect(dry.out).toMatch(/dry-run/i);
    expect(dry.out).toMatch(new RegExp(`${b1.all.length} se borrar`));

    const applied = run(['clean', '--webroot', webroot, '--manifests', manifests, '--apply']);
    expect(applied.code).toBe(0);
    for (const name of b1.all) expect(assetsNow().has(name)).toBe(false);
    expectPublishedIntact(b3);
    for (const name of b2.all) expect(assetsNow().has(name)).toBe(true);
  });

  it('record por CLI escribe el manifiesto; un build no publicado sale con ≠ 0', () => {
    const b1 = makeBuild(); c0(b1); c2(b1);
    expect(run(['record', '--dist', b1.dist, '--webroot', webroot, '--manifests', manifests, '--id', b1.id]).code).toBe(0);
    const x = makeBuild(); c0(x);
    expect(run(['record', '--dist', x.dist, '--webroot', webroot, '--manifests', manifests, '--id', x.id]).code).not.toBe(0);
    expect(loadManifests(manifests, assetsNow()).valid.map((m) => m.file)).toEqual([`${b1.id}.txt`]);
  });

  it('clean --apply con "aaa junk.js" no referenciado en assets/: exit ≠ 0 y no borra NINGÚN fichero', () => {
    const b1 = makeBuild(); deploy(b1);
    const b2 = makeBuild(); deploy(b2);
    const b3 = makeBuild(); deploy(b3); // los chunks de b1 serían candidatos
    fs.writeFileSync(path.join(webroot, 'assets', 'aaa junk.js'), 'x');
    const before = [...assetsNow()].sort();
    const r = run(['clean', '--webroot', webroot, '--manifests', manifests, '--apply']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('aaa junk.js');
    expect([...assetsNow()].sort()).toEqual(before);
  });

  it('clean --apply con un plan que aborta (1 solo manifiesto, con restos borrables): exit 1 y el listado completo no cambia', () => {
    fs.writeFileSync(path.join(webroot, 'assets', 'old-legacy.js'), 'old');
    const b1 = makeBuild(); deploy(b1);
    const x = makeBuild(); c0(x); // abortado tras c0: candidatos si no se abortara
    const before = [...assetsNow()].sort();
    const r = run(['clean', '--webroot', webroot, '--manifests', manifests, '--apply']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/ABORTADO/);
    expect(r.out).not.toMatch(/borrados/);
    expect([...assetsNow()].sort()).toEqual(before);
  });

  it('clean --apply que aborta en la red de seguridad: exit 1 y el listado completo no cambia', () => {
    const b1 = makeBuild(); deploy(b1);
    const b2 = makeBuild(); deploy(b2);
    const b3 = makeBuild(); deploy(b3);
    fs.appendFileSync(path.join(webroot, 'assets', b3.names.vendor), `;const s="${b1.names.blogOnly}";`);
    const before = [...assetsNow()].sort();
    const r = run(['clean', '--webroot', webroot, '--manifests', manifests, '--apply']);
    expect(r.code).toBe(1);
    expect([...assetsNow()].sort()).toEqual(before);
  });

  it('rutas relativas que SÍ existen desde el cwd: clean --apply y record abortan con 1 sin borrar ni escribir', () => {
    const b1 = makeBuild(); deploy(b1);
    const b2 = makeBuild(); deploy(b2);
    const b3 = makeBuild(); c0(b3); c2(b3); // publicado, sin record: record SÍ lo aceptaría con rutas absolutas
    const relWww = path.relative(process.cwd(), webroot);
    const relMan = path.relative(process.cwd(), manifests);
    const relDist = path.relative(process.cwd(), b3.dist);
    expect(fs.existsSync(relWww) && fs.existsSync(relMan) && fs.existsSync(relDist)).toBe(true);
    const assetsBefore = [...assetsNow()].sort();
    const manBefore = fs.readdirSync(manifests).sort();

    expect(run(['clean', '--webroot', relWww, '--manifests', manifests, '--apply']).code).toBe(1);
    expect(run(['clean', '--webroot', webroot, '--manifests', relMan, '--apply']).code).toBe(1);
    expect(run(['record', '--dist', relDist, '--webroot', webroot, '--manifests', manifests, '--id', '20261098-120000-abcdef8']).code).toBe(1);
    expect(run(['record', '--dist', b3.dist, '--webroot', relWww, '--manifests', manifests, '--id', '20261098-120000-abcdef8']).code).toBe(1);
    expect(run(['record', '--dist', b3.dist, '--webroot', webroot, '--manifests', relMan, '--id', '20261098-120000-abcdef8']).code).toBe(1);

    expect([...assetsNow()].sort()).toEqual(assetsBefore);
    expect(fs.readdirSync(manifests).sort()).toEqual(manBefore);
    // Control: con rutas absolutas, ese mismo record sí se escribe.
    expect(run(['record', '--dist', b3.dist, '--webroot', webroot, '--manifests', manifests, '--id', '20261098-120000-abcdef8']).code).toBe(0);
  });

  /** runCli con un hook: `mutate` corre cuando la CLI ya listó el plan y antes de borrar. */
  const runWithHook = (argv, mutate) => {
    const exit = vi.fn((c) => c);
    const lines = [];
    let done = false;
    const logger = {
      log: (...a) => {
        const l = a.join(' ');
        lines.push(l);
        if (!done && /se borrarían/.test(l)) { done = true; mutate(); }
      },
      warn: (...a) => lines.push(a.join(' ')),
      error: (...a) => lines.push(a.join(' ')),
    };
    const code = runCli(argv, { exit, logger });
    return { code, out: lines.join('\n') };
  };

  it('clean --apply con un directorio a mitad de lista: exit 1 y «FALLO A MITAD: borrados k de N…», nunca «ABORTADO» a secas', () => {
    const b1 = makeBuild(); deploy(b1);
    const b2 = makeBuild(); deploy(b2);
    const b3 = makeBuild(); deploy(b3);
    const remove = planClean({ webroot, manifestsDir: manifests, keep: 2 }).remove;
    const victim = remove[3];
    const r = runWithHook(['clean', '--webroot', webroot, '--manifests', manifests, '--apply'], () => {
      fs.rmSync(path.join(webroot, 'assets', victim));
      fs.mkdirSync(path.join(webroot, 'assets', victim));
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(new RegExp(`\\[cleanAssets\\] FALLO A MITAD: borrados 3 de ${remove.length}; ya no estaban 0; falló en ${victim.replace(/\./g, '\\.')}: `));
    expect(r.out).not.toMatch(/ABORTADO/);
    expect(fs.statSync(path.join(webroot, 'assets', victim)).isDirectory()).toBe(true);
  });

  it('clean --apply con un candidato que ya no está: exit 0 y lo cuenta aparte', () => {
    const b1 = makeBuild(); deploy(b1);
    const b2 = makeBuild(); deploy(b2);
    const b3 = makeBuild(); deploy(b3);
    const remove = planClean({ webroot, manifestsDir: manifests, keep: 2 }).remove;
    const r = runWithHook(['clean', '--webroot', webroot, '--manifests', manifests, '--apply'], () => {
      fs.rmSync(path.join(webroot, 'assets', remove[0]));
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(new RegExp(`\\[cleanAssets\\] borrados ${remove.length - 1} de ${remove.length}; ya no estaban 1`));
  });

  it('aborto de clean: exit ≠ 0 y no borra aunque se pase --apply', () => {
    const b1 = makeBuild(); deploy(b1);
    const before = assetsNow();
    const r = run(['clean', '--webroot', webroot, '--manifests', manifests, '--apply']);
    expect(r.code).not.toBe(0);
    expect(assetsNow()).toEqual(before);
  });
});
