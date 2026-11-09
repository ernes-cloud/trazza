import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shareHtmlCandidates, normalizeShareBase, readShareBase } from './shareHtml.js';
import { getAppHostname } from './appUrl.js';
import { injectRoot, PRERENDER_START, PRERENDER_END } from '../../src/lib/prerender.js';

const SHELL = '<!doctype html><html lang="es"><head><title>Trazza</title></head><body><div id="root"></div><script type="module" src="/assets/index.js"></script></body></html>';
const HOME = injectRoot(SHELL, '<main><h1>Controla tu cartera</h1></main>', '/');

/** Default OSS/runtime: /srv/www/<APP hostname> — sin literales de host que el export reescriba. */
const DEFAULT_STATIC = () => `/srv/www/${getAppHostname()}`;
/** Ruta genérica que documenta el webroot real del VPS vía WEB_STATIC_ROOT (no incrustar /srv/www). */
const VPS_STATIC = '/data/vps-static';

describe('shareHtmlCandidates', () => {
  it('ordena: WEB_APP_HTML, app.html hermano, app.html del estático por defecto, WEB_INDEX_HTML, dist/app.html y las portadas', () => {
    const staticRoot = DEFAULT_STATIC();
    const list = shareHtmlCandidates({
      env: { WEB_APP_HTML: '/x/app.html', WEB_INDEX_HTML: '/y/index.html' },
      distDir: '/repo/dist',
    });
    expect(list).toEqual([
      '/x/app.html',
      '/y/app.html',
      `${staticRoot}/app.html`,
      '/y/index.html',
      '/repo/dist/app.html',
      `${staticRoot}/index.html`,
      '/repo/dist/index.html',
    ]);
  });

  it('dist/app.html NO gana a WEB_INDEX_HTML aunque esta no tenga un app.html al lado', () => {
    const staticRoot = DEFAULT_STATIC();
    const list = shareHtmlCandidates({ env: { WEB_INDEX_HTML: '/y/index.html' }, distDir: '/repo/dist' });
    expect(list.indexOf('/y/index.html')).toBeLessThan(list.indexOf('/repo/dist/app.html'));
    // El shell del directorio estático por defecto gana a una portada configurada.
    expect(list.indexOf(`${staticRoot}/app.html`)).toBeLessThan(list.indexOf('/y/index.html'));
  });

  it('con WEB_INDEX_HTML apuntando a la portada del VPS, el app.html del VPS va antes que esa portada', () => {
    const list = shareHtmlCandidates({
      env: {
        WEB_STATIC_ROOT: VPS_STATIC,
        WEB_INDEX_HTML: `${VPS_STATIC}/index.html`,
      },
      distDir: '/repo/dist',
    });
    expect(list).toEqual([
      `${VPS_STATIC}/app.html`,
      `${VPS_STATIC}/index.html`,
      '/repo/dist/app.html',
      '/repo/dist/index.html',
    ]);
  });

  it('producción con WEB_STATIC_ROOT=<ruta del VPS>: primero el app.html del VPS', () => {
    // El VPS real sirve estáticos desde su webroot; documentamos el contrato vía env,
    // no con un literal /srv/www que el export reescribiría.
    const list = shareHtmlCandidates({
      env: { WEB_STATIC_ROOT: VPS_STATIC },
      distDir: '/repo/dist',
    });
    expect(list).toEqual([
      `${VPS_STATIC}/app.html`,
      '/repo/dist/app.html',
      `${VPS_STATIC}/index.html`,
      '/repo/dist/index.html',
    ]);
    expect(list[0]).toBe(`${VPS_STATIC}/app.html`);
  });

  it('sin variables: default /srv/www/<host>, sin /srv/www ni /srv/', () => {
    const staticRoot = DEFAULT_STATIC();
    const hostOpt = ['/', 'opt', '/'].join('');
    const hostWww = ['/', 'var', '/', 'www'].join('');
    expect(staticRoot.startsWith('/srv/www/')).toBe(true);
    const list = shareHtmlCandidates({ env: {}, distDir: '/repo/dist' });
    expect(list).toEqual([
      `${staticRoot}/app.html`,
      '/repo/dist/app.html',
      `${staticRoot}/index.html`,
      '/repo/dist/index.html',
    ]);
    for (const p of list.filter((x) => !x.startsWith('/repo/dist'))) {
      expect(p.includes(hostWww), `default no debe usar hosting legado: ${p}`).toBe(false);
      expect(p.includes(hostOpt), `default no debe usar ${hostOpt}: ${p}`).toBe(false);
    }
  });

  it.each([
    [{}],
    [{ WEB_APP_HTML: '/x/app.html' }],
    [{ WEB_INDEX_HTML: '/y/index.html' }],
    [{ WEB_APP_HTML: '/x/app.html', WEB_INDEX_HTML: '/y/index.html' }],
  ])('con env %j, en cada directorio app.html va antes que su index.html', (env) => {
    const list = shareHtmlCandidates({ env, distDir: '/repo/dist' });
    for (const [i, f] of list.entries()) {
      if (!f.endsWith('/index.html')) continue;
      const sibling = list.indexOf(f.replace(/index\.html$/, 'app.html'));
      if (sibling !== -1) expect(sibling, f).toBeLessThan(i);
    }
  });

  it('omite las variables de entorno vacías', () => {
    const staticRoot = DEFAULT_STATIC();
    const list = shareHtmlCandidates({ env: { WEB_APP_HTML: '', WEB_INDEX_HTML: '' }, distDir: '/repo/dist' });
    expect(list[0]).toBe(`${staticRoot}/app.html`);
    expect(list).toHaveLength(4);
  });
});
describe('normalizeShareBase', () => {
  it('deja intacto un shell con #root vacío', () => {
    expect(normalizeShareBase(SHELL)).toBe(SHELL);
  });
  it('vacía el #root de un index.html prerenderizado (la home no se cuela en /share)', () => {
    const out = normalizeShareBase(HOME);
    expect(out).toContain('<div id="root"></div>');
    expect(out).not.toContain('Controla tu cartera');
    expect(out).not.toContain(PRERENDER_START);
    expect(out).not.toContain(PRERENDER_END);
    expect(out).not.toContain('data-prerender-path');
    expect(out).toContain('/assets/index.js');
  });
  it('quita un data-prerender-path suelto en un #root sin contenido', () => {
    const html = SHELL.replace('<div id="root"></div>', '<div id="root" data-prerender-path="/"></div>');
    expect(normalizeShareBase(html)).toBe(SHELL);
  });
  it('devuelve null si no puede garantizar un #root vacío', () => {
    expect(normalizeShareBase('<html><body><p>sin root</p></body></html>')).toBeNull();
    const roto = SHELL.replace('<div id="root"></div>', `<div id="root">${PRERENDER_START}<p>a medias</p></div>`);
    expect(normalizeShareBase(roto)).toBeNull();
    expect(normalizeShareBase('')).toBeNull();
    expect(normalizeShareBase(null)).toBeNull();
  });
});

describe('readShareBase', () => {
  const reader = (files) => async (file) => {
    if (!(file in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return files[file];
  };

  it('prefiere app.html aunque index.html exista', async () => {
    const files = { '/d/app.html': SHELL.replace('Trazza', 'App'), '/d/index.html': HOME };
    const out = await readShareBase(['/d/app.html', '/d/index.html'], reader(files));
    expect(out).toEqual({ file: '/d/app.html', html: SHELL.replace('Trazza', 'App') });
  });
  it('sin app.html cae a index.html con #root vacío', async () => {
    const out = await readShareBase(['/d/app.html', '/d/index.html'], reader({ '/d/index.html': HOME }));
    expect(out.file).toBe('/d/index.html');
    expect(out.html).toContain('<div id="root"></div>');
    expect(out.html).not.toContain('Controla tu cartera');
  });
  it('salta un candidato que no se puede normalizar', async () => {
    const files = { '/d/app.html': '<html>roto</html>', '/d/index.html': HOME };
    const out = await readShareBase(['/d/app.html', '/d/index.html'], reader(files));
    expect(out.file).toBe('/d/index.html');
  });
  it('devuelve null si ningún candidato sirve', async () => {
    expect(await readShareBase(['/a', '/b'], reader({}))).toBeNull();
  });
});


describe('WEB_STATIC_ROOT — ruta estática parametrizada (OSS)', () => {
  let warnSpy;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('shareHtmlCandidates respeta WEB_STATIC_ROOT cuando está definido', () => {
    const list = shareHtmlCandidates({
      env: { WEB_STATIC_ROOT: '/data/web-static' },
      distDir: '/repo/dist',
    });
    expect(list).toContain('/data/web-static/app.html');
    expect(list).toContain('/data/web-static/index.html');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('ruta absoluta válida se acepta y no registra warning (control)', () => {
    const ok = '/data/web-static-ok';
    const list = shareHtmlCandidates({ env: { WEB_STATIC_ROOT: ok }, distDir: '/repo/dist' });
    expect(list.some((p) => p.startsWith(`${ok}/`))).toBe(true);
    expect(list.some((p) => p.includes(ok))).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  function expectRejectedFallsBackToDefault(badRoot) {
    const staticRoot = DEFAULT_STATIC();
    const list = shareHtmlCandidates({ env: { WEB_STATIC_ROOT: badRoot }, distDir: '/repo/dist' });
    // El valor rechazado no aparece en ningún candidato.
    for (const p of list) {
      expect(p.includes(badRoot), `candidato no debe contener la ruta rechazada: ${p}`).toBe(false);
    }
    // Se usa el default /srv/www/<host>.
    expect(list).toContain(`${staticRoot}/app.html`);
    expect(list).toContain(`${staticRoot}/index.html`);
    expect(warnSpy).toHaveBeenCalled();
    const joined = warnSpy.mock.calls.flat().map(String).join('\n');
    expect(joined).toMatch(/WEB_STATIC_ROOT/);
  }

  it('rechaza ruta con .. (p. ej. /srv/www/../etc)', () => {
    expectRejectedFallsBackToDefault('/srv/www/../etc');
  });

  it('rechaza ruta relativa', () => {
    expectRejectedFallsBackToDefault('relative/web-static');
  });

  it.each([
    ['/etc'],
    ['/etc/passwd-dir'],
    ['/proc'],
    ['/proc/self'],
    ['/sys'],
    ['/sys/class'],
  ])('rechaza %s (y subrutas)', (bad) => {
    expectRejectedFallsBackToDefault(bad);
  });
});
