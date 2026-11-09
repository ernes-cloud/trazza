import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Estado de módulo: cada test parte de un módulo recién cargado.
const fresh = async () => {
  vi.resetModules();
  return import('./prerenderBoot.js');
};

describe('prerenderBoot', () => {
  beforeEach(() => { delete globalThis.window; });
  afterEach(() => { delete globalThis.window; });

  it('por defecto no se arrancó desde prerender y motionInitial deja pasar el valor', async () => {
    const m = await fresh();
    expect(m.bootedFromPrerender()).toBe(false);
    const v = { opacity: 0, y: 16 };
    expect(m.motionInitial(v)).toBe(v);
    expect(m.motionInitial('hidden')).toBe('hidden');
  });

  it('tras markBootedFromPrerender, motionInitial devuelve false: la animación de entrada no se repite sobre el HTML ya pintado', async () => {
    const m = await fresh();
    m.markBootedFromPrerender();
    expect(m.bootedFromPrerender()).toBe(true);
    expect(m.motionInitial({ opacity: 0 })).toBe(false);
    expect(m.motionInitial('hidden')).toBe(false);
  });

  it('isPrerendering: solo con window.__TRAZZA_PRERENDER__ === true (lo pone tools/prerender.mjs)', async () => {
    const m = await fresh();
    expect(m.isPrerendering()).toBe(false); // sin window (Node)
    globalThis.window = {};
    expect(m.isPrerendering()).toBe(false);
    globalThis.window = { __TRAZZA_PRERENDER__: 'true' };
    expect(m.isPrerendering()).toBe(false);
    globalThis.window = { __TRAZZA_PRERENDER__: true };
    expect(m.isPrerendering()).toBe(true);
  });

  it('mientras se prerenderiza NO se salta la animación: el HTML se captura con la animación ya terminada', async () => {
    const m = await fresh();
    globalThis.window = { __TRAZZA_PRERENDER__: true };
    const v = { opacity: 0 };
    expect(m.motionInitial(v)).toBe(v);
  });
});
