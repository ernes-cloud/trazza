#!/usr/bin/env node
/**
 * Limpieza de /srv/www/example.com/assets/ (SERVIDOR.md, plan de despliegue).
 *
 * c0 publica los chunks nuevos SIN --delete (una pestaña abierta antes del
 * despliegue sigue pidiendo los viejos), así que assets/ crece en cada despliegue.
 * Este script decide qué sobra. No sirve `find -mtime`: vite reescribe todos los
 * chunks y `rsync -a` conserva ese mtime.
 *
 *   node tools/cleanAssets.mjs record --dist <abs> --webroot <abs> --manifests <abs> --id <AAAAMMDD-HHMMSS-hash>
 *     Tras e), con los curl en verde. Escribe <manifests>/<id>.txt con la lista de
 *     dist/assets (temporal + rename). Rechaza si la lista está vacía, si algún nombre
 *     no está en webroot/assets o si no contiene TODO lo que carga el index.html
 *     publicado: prueba de que ese build es el publicado.
 *
 *   node tools/cleanAssets.mjs clean --webroot <abs> --manifests <abs> [--keep 2] [--apply]
 *     Conserva la unión de (a) lo que cargan TODOS los .html del webroot, siguiendo
 *     de forma transitiva JS y CSS, y (b) los N últimos builds DISTINTOS entre los
 *     manifiestos válidos (dos manifiestos con los mismos nombres son un redespliegue
 *     del mismo build y cuentan una vez). Sin --apply solo lista (dry-run). Aborta sin
 *     borrar nada si hay menos de N builds distintos, si el más reciente no cubre el index.html publicado, si
 *     no hay index.html, si (a) sale vacío, si algún nombre de assets/ no cumple
 *     NAME_RE (se mira antes de nada), si hay symlinks en el webroot fuera de
 *     assets/ o algo que no sea un fichero regular dentro de assets/ (las dos cosas
 *     también en record); y, como red de seguridad, si algún
 *     candidato aparece como cadena en un .html/.js/.css conservado.
 *
 * Rutas siempre absolutas (nunca depende del cwd). Exit: 0 bien, 1 rechazo o
 * aborto, 2 uso incorrecto. Tests: tools/cleanAssets.test.js (simulación).
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MANIFEST_RE = /^\d{8}-\d{6}-[0-9a-f]{7,40}\.txt$/;
const ID_RE = /^\d{8}-\d{6}-[0-9a-f]{7,40}$/;
/** Nombre de fichero plano de assets/ (vite no crea subcarpetas ahí). */
const NAME_RE = /^[A-Za-z0-9_.~-]+$/;
const TEXT_EXT = new Set(['.js', '.mjs', '.css']);

export const isManifestName = (name) => MANIFEST_RE.test(name);

/**
 * Entradas de webroot/assets que NO son ficheros regulares (symlink, directorio, otro).
 * listAssets solo ve ficheros: un chunk VIVO sustituido por un enlace dejaba de existir
 * para el cierre y sus dependencias se borraban (5.ª revisión, hallazgo 5). Ante la duda,
 * clean y record abortan y lo nombran.
 */
function nonRegularAssets(webroot) {
  return fs.readdirSync(path.join(webroot, 'assets'), { withFileTypes: true })
    .filter((d) => !d.isFile())
    .map((d) => `${d.name} (${d.isSymbolicLink() ? 'symlink' : d.isDirectory() ? 'directorio' : 'otro'})`)
    .sort();
}
const nonRegularReason = (list) => `hay ${list.length} entrada(s) en assets/ que no son ficheros regulares `
  + `(ni se siguen ni se ignoran; revisarlas a mano): ${list.slice(0, 20).join(', ')}`;

const listAssets = (webroot) => new Set(
  fs.readdirSync(path.join(webroot, 'assets'), { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name),
);

/**
 * Nombres de assets/ que aparecen referenciados en `text`: `/assets/x` o `assets/x`
 * (HTML y el __vite__mapDeps de los chunks), `./x` (import estático e import()
 * entre chunks, url() relativas) y `url(x)` del CSS. Solo cuentan los que existen
 * en `known`: así un falso positivo de la regex nunca añade nada inventado.
 */
export function extractRefs(text, known) {
  const out = new Set();
  const add = (raw) => {
    const name = raw.split(/[?#]/)[0];
    if (known.has(name)) out.add(name);
  };
  for (const m of text.matchAll(/(?:^|[^A-Za-z0-9_])assets\/([A-Za-z0-9_.~-]+)/g)) add(m[1]);
  for (const m of text.matchAll(/(?:^|[^A-Za-z0-9_.])\.\/([A-Za-z0-9_.~-]+)/g)) add(m[1]);
  for (const m of text.matchAll(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/g)) add(path.posix.basename(m[1]));
  return out;
}

/**
 * Recorre el webroot (recursivo, salvo assets/): sus .html y los symlinks que haya,
 * como rutas relativas al webroot. Un symlink no se sigue ni se ignora: un HTML detrás
 * de uno cargaría assets que la limpieza no vería, así que quien llama aborta.
 */
function scanWebroot(webroot) {
  const html = [];
  const symlinks = [];
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isSymbolicLink()) symlinks.push(path.relative(webroot, p));
      else if (d.isDirectory()) {
        if (dir === webroot && d.name === 'assets') continue;
        walk(p);
      } else if (d.isFile() && d.name.endsWith('.html')) html.push(p);
    }
  };
  walk(webroot);
  return { html: html.sort(), symlinks: symlinks.sort() };
}

const symlinkReason = (symlinks) => `hay ${symlinks.length} symlink(s) en el webroot fuera de assets/ `
  + `(ni se siguen ni se ignoran; revisarlos a mano): ${symlinks.slice(0, 20).join(', ')}`;

/** Cierre transitivo desde `seeds` siguiendo los .js/.css de assets/. */
function closure(webroot, seeds, known) {
  const refs = new Set(seeds);
  const queue = [...seeds];
  while (queue.length) {
    const name = queue.pop();
    if (!TEXT_EXT.has(path.extname(name))) continue;
    const txt = fs.readFileSync(path.join(webroot, 'assets', name), 'utf8');
    for (const r of extractRefs(txt, known)) {
      if (!refs.has(r)) { refs.add(r); queue.push(r); }
    }
  }
  return refs;
}

/** (a): lo que cargan todos los .html publicados, y aparte lo que carga solo index.html. */
export function referencedClosure(webroot, known = listAssets(webroot)) {
  const { html: files, symlinks } = scanWebroot(webroot);
  const seeds = new Set();
  for (const f of files) for (const r of extractRefs(fs.readFileSync(f, 'utf8'), known)) seeds.add(r);
  const indexPath = path.join(webroot, 'index.html');
  const hasIndex = fs.existsSync(indexPath);
  const indexRefs = hasIndex ? closure(webroot, extractRefs(fs.readFileSync(indexPath, 'utf8'), known), known) : new Set();
  return { refs: closure(webroot, seeds, known), indexRefs, hasIndex, htmlFiles: files, symlinks };
}

/** Una línea por nombre. CRLF explícito (un manifiesto editado en Windows) y trim (espacios finales). */
const readList = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/**
 * Manifiestos (solo los que siguen MANIFEST_RE), en orden cronológico (= por nombre).
 * Válido = no vacío, nombres con forma de fichero de assets/ y TODOS existentes.
 * Uno con nombres que faltan no se usa: o está truncado (el corte deja un nombre a
 * medias) o sus chunks ya se limpiaron; en ninguno de los dos casos describe un
 * build completo, y fiarse de él podría dejar fuera algo en uso.
 */
export function loadManifests(manifestsDir, known) {
  const valid = [];
  const invalid = [];
  for (const file of fs.readdirSync(manifestsDir).filter(isManifestName).sort()) {
    const names = readList(path.join(manifestsDir, file));
    let reason = null;
    if (!names.length) reason = 'vacío';
    else if (names.some((x) => !NAME_RE.test(x))) reason = 'líneas que no son nombres de assets/';
    else {
      const missing = names.filter((x) => !known.has(x));
      if (missing.length) reason = `${missing.length} nombre(s) que ya no están en assets/ (p. ej. ${missing[0]})`;
    }
    (reason ? invalid : valid).push({ file, names, reason });
  }
  return { valid, invalid };
}

/**
 * Un manifiesto por build DISTINTO, en orden cronológico. Dos manifiestos con el mismo
 * conjunto de nombres (da igual el orden, el CRLF y los espacios finales: readList) describen el
 * mismo build — un redespliegue del mismo commit con un id nuevo — y cuentan como una
 * sola versión: la más reciente. Sin esto, keep=2 conservaría dos veces el mismo build y
 * borraría el anterior, con las pestañas abiertas en él dentro.
 */
export function distinctBuilds(valid) {
  const seen = new Set();
  const out = [];
  for (let i = valid.length - 1; i >= 0; i -= 1) {
    const key = [...new Set(valid[i].names)].sort().join('\n');
    if (seen.has(key)) continue;
    seen.add(key);
    out.unshift(valid[i]);
  }
  return out;
}

function checkDir(p, label) {
  if (!p || !path.isAbsolute(p)) return `${label} tiene que ser una ruta absoluta`;
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) return `${label} no existe o no es un directorio: ${p}`;
  return null;
}

export function recordManifest({ distDir, webroot, manifestsDir, id }) {
  const fail = (reason) => ({ ok: false, reason });
  if (!ID_RE.test(id || '')) return fail(`--id tiene que ser AAAAMMDD-HHMMSS-<hash git>: ${id}`);
  for (const [p, l] of [[distDir, '--dist'], [webroot, '--webroot'], [manifestsDir, '--manifests']]) {
    const e = checkDir(p, l);
    if (e) return fail(e);
  }
  if (checkDir(path.join(webroot, 'assets'), 'webroot/assets')) return fail(`no hay ${path.join(webroot, 'assets')}`);
  const target = path.join(manifestsDir, `${id}.txt`);
  if (fs.existsSync(target)) return fail(`ya existe ${target}; no se sobrescribe`);
  const distAssets = path.join(distDir, 'assets');
  if (checkDir(distAssets, 'dist/assets')) return fail(`no hay ${distAssets}`);
  const names = fs.readdirSync(distAssets, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name).sort();
  if (!names.length) return fail('dist/assets está vacío');
  const nonRegular = nonRegularAssets(webroot);
  if (nonRegular.length) return fail(nonRegularReason(nonRegular));
  const known = listAssets(webroot);
  const missing = names.filter((x) => !known.has(x));
  if (missing.length) return fail(`${missing.length} asset(s) de dist no están en webroot/assets (¿se hizo c0?): ${missing.slice(0, 5).join(', ')}`);
  const { indexRefs, hasIndex, symlinks } = referencedClosure(webroot, known);
  if (symlinks.length) return fail(symlinkReason(symlinks));
  if (!hasIndex) return fail('no hay index.html en el webroot');
  if (!indexRefs.size) return fail('el index.html publicado no referencia ningún asset');
  const set = new Set(names);
  const uncovered = [...indexRefs].filter((x) => !set.has(x));
  if (uncovered.length) {
    return fail(`este build no es el publicado: el index.html del webroot carga ${uncovered.length} asset(s) que no están en dist/assets (${uncovered.slice(0, 5).join(', ')})`);
  }
  const tmp = path.join(manifestsDir, `.${id}.txt.tmp`);
  fs.writeFileSync(tmp, `${names.join('\n')}\n`);
  fs.renameSync(tmp, target);
  return { ok: true, file: target, count: names.length };
}

/**
 * `safetyNet: false` existe SOLO para los tests (probar el cierre transitivo sin que la
 * red de seguridad tape un fallo suyo); la CLI no lo expone y siempre va activa.
 */
export function planClean({ webroot, manifestsDir, keep = 2, safetyNet = true }) {
  const base = { ok: false, keep: [], remove: [], invalid: [] };
  const fail = (reason, extra = {}) => ({ ...base, ...extra, reason });
  for (const [p, l] of [[webroot, '--webroot'], [manifestsDir, '--manifests']]) {
    const e = checkDir(p, l);
    if (e) return fail(e);
  }
  if (!Number.isInteger(keep) || keep < 1) return fail(`--keep tiene que ser un entero ≥ 1: ${keep}`);
  if (checkDir(path.join(webroot, 'assets'), 'webroot/assets')) return fail(`no hay ${path.join(webroot, 'assets')}`);
  // TODOS los nombres de assets/, no solo los candidatos, y antes de calcular nada: un
  // nombre que no es de vite (subido a mano, con espacio…) es una duda, y ante la duda
  // no se borra. applyClean lo vuelve a comprobar como segunda barrera.
  const odd = fs.readdirSync(path.join(webroot, 'assets')).filter((x) => !NAME_RE.test(x)).sort();
  if (odd.length) {
    return fail(`hay ${odd.length} nombre(s) que no son de assets/ generados por vite en ${path.join(webroot, 'assets')}; `
      + `revisarlos a mano antes de limpiar: ${odd.slice(0, 20).map((x) => JSON.stringify(x)).join(', ')}`);
  }

  const nonRegular = nonRegularAssets(webroot);
  if (nonRegular.length) return fail(nonRegularReason(nonRegular));

  const known = listAssets(webroot);
  const { valid, invalid } = loadManifests(manifestsDir, known);
  const { refs, indexRefs, hasIndex, htmlFiles: html, symlinks } = referencedClosure(webroot, known);
  if (symlinks.length) return fail(symlinkReason(symlinks), { invalid });
  if (!hasIndex) return fail('no hay index.html en el webroot', { invalid });
  if (!refs.size) return fail('los .html del webroot no referencian ningún asset (a vacío)', { invalid });
  const builds = distinctBuilds(valid);
  if (builds.length < keep) {
    return fail(`hay ${builds.length} builds distintos en ${valid.length} manifiestos válidos y hacen falta ${keep}`, { invalid });
  }
  const used = builds.slice(-keep);
  const newest = used[used.length - 1];
  const newestSet = new Set(newest.names);
  const uncovered = [...indexRefs].filter((x) => !newestSet.has(x));
  if (uncovered.length) {
    return fail(`el manifiesto más reciente (${newest.file}) no cubre lo que carga el index.html publicado `
      + `(${uncovered.slice(0, 5).join(', ')}): no corresponde a lo publicado`, { invalid });
  }

  const keepSet = new Set(refs);
  for (const m of used) for (const x of m.names) keepSet.add(x);
  const remove = [...known].filter((x) => !keepSet.has(x)).sort();
  const plan = { ok: true, keep: [...keepSet].sort(), remove, invalid, manifests: used.map((m) => m.file) };

  // Red de seguridad: ningún candidato puede aparecer como cadena en lo que se queda.
  if (!safetyNet) return plan;
  const corpus = [
    ...html.map((f) => fs.readFileSync(f, 'utf8')),
    ...[...keepSet].filter((x) => TEXT_EXT.has(path.extname(x))).map((x) => fs.readFileSync(path.join(webroot, 'assets', x), 'utf8')),
  ].join('\n');
  const referenced = remove.filter((x) => corpus.includes(x));
  if (referenced.length) {
    return fail(`red de seguridad: ${referenced.length} candidato(s) aparecen en un .html/.js/.css conservado `
      + `(${referenced.slice(0, 10).join(', ')}); no se borra nada`, { invalid });
  }
  return plan;
}

/**
 * Borra `remove` de webroot/assets. Primer pase, ANTES de borrar: todos los nombres
 * tienen que cumplir NAME_RE; si no, lanza sin haber borrado nada. Después, fichero a
 * fichero con `unlinkSync` (nunca recursivo: un directorio con el nombre de un
 * candidato es un fallo, no se borra). Un ENOENT (ya no estaba) se cuenta aparte, en
 * `missing`, no como borrado. Cualquier otro error PARA en ese fichero y lanza un
 * Error con `progress = { removed, missing, failedAt, error, total }`: lo anterior ya
 * está borrado y hay que decirlo (5.ª revisión: «ABORTADO» se leía como «nada»).
 * Devuelve `{ removed, missing, total, failedAt: null, error: null }`.
 */
export function applyClean({ webroot, remove }) {
  const dir = path.join(webroot, 'assets');
  const bad = remove.filter((name) => !NAME_RE.test(name));
  if (bad.length) throw new Error(`nombre inesperado, no se borra nada: ${bad.map((x) => JSON.stringify(x)).join(', ')}`);
  const total = remove.length;
  let removed = 0;
  let missing = 0;
  for (const name of remove) {
    try {
      fs.unlinkSync(path.join(dir, name));
      removed += 1;
    } catch (e) {
      if (e.code === 'ENOENT') { missing += 1; continue; }
      const error = `${e.code ? `${e.code}: ` : ''}${e.message}`;
      const err = new Error(`borrados ${removed} de ${total}; ya no estaban ${missing}; falló en ${name}: ${error}`);
      err.progress = { removed, missing, failedAt: name, error, total };
      throw err;
    }
  }
  return { removed, missing, total, failedAt: null, error: null };
}

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { cmd, apply: false };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--apply') opts.apply = true;
    else if (['--dist', '--webroot', '--manifests', '--keep', '--id'].includes(a)) {
      opts[a.slice(2)] = rest[i + 1];
      i += 1;
    } else throw new Error(`argumento desconocido: ${a}`);
  }
  return opts;
}

const USAGE = 'uso:\n'
  + '  node tools/cleanAssets.mjs record --dist <abs> --webroot <abs> --manifests <abs> --id <AAAAMMDD-HHMMSS-hash>\n'
  + '  node tools/cleanAssets.mjs clean --webroot <abs> --manifests <abs> [--keep 2] [--apply]';

export function runCli(argv = process.argv.slice(2), { exit = process.exit, logger = console } = {}) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    logger.error(`${e.message}\n${USAGE}`);
    return exit(2);
  }
  if (o.cmd === 'record') {
    if (!o.dist || !o.webroot || !o.manifests || !o.id) { logger.error(USAGE); return exit(2); }
    const r = recordManifest({ distDir: o.dist, webroot: o.webroot, manifestsDir: o.manifests, id: o.id });
    if (!r.ok) { logger.error(`[cleanAssets] record RECHAZADO: ${r.reason}`); return exit(1); }
    logger.log(`[cleanAssets] manifiesto escrito: ${r.file} (${r.count} assets)`);
    return exit(0);
  }
  if (o.cmd === 'clean') {
    if (!o.webroot || !o.manifests) { logger.error(USAGE); return exit(2); }
    const keep = o.keep === undefined ? 2 : Number(o.keep);
    if (!Number.isInteger(keep) || keep < 1) { logger.error(`--keep tiene que ser un entero ≥ 1\n${USAGE}`); return exit(2); }
    const p = planClean({ webroot: o.webroot, manifestsDir: o.manifests, keep });
    for (const m of p.invalid) logger.warn(`[cleanAssets] AVISO: manifiesto ignorado ${m.file}: ${m.reason}`);
    // Un plan abortado no borra nada aunque algún camino de fail trajera lista.
    const remove = p.ok ? p.remove : [];
    if (!p.ok) { logger.error(`[cleanAssets] ABORTADO, no se borra nada: ${p.reason}`); return exit(1); }
    logger.log(`[cleanAssets] manifiestos usados: ${p.manifests.join(', ')}`);
    logger.log(`[cleanAssets] se conservan ${p.keep.length}; ${remove.length} se borrarían${o.apply ? '' : ' (dry-run: no se borra nada; repetir con --apply)'}:`);
    for (const x of remove) logger.log(`  ${x}`);
    if (o.apply) {
      let r;
      try {
        r = applyClean({ webroot: o.webroot, remove });
      } catch (e) {
        // Con progress, ya se borró algo (o pudo): nunca «ABORTADO» a secas.
        logger.error(e.progress
          ? `[cleanAssets] FALLO A MITAD: ${e.message}`
          : `[cleanAssets] ABORTADO, no se borra nada: ${e.message}`);
        return exit(1);
      }
      logger.log(`[cleanAssets] borrados ${r.removed} de ${r.total}; ya no estaban ${r.missing}`);
    }
    return exit(0);
  }
  logger.error(USAGE);
  return exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
