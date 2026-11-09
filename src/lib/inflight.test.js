import { describe, it, expect, vi } from 'vitest';
import { coalesce, _inFlightSize } from './inflight';

describe('coalesce', () => {
  it('dos peticiones simultaneas de lo MISMO hacen UNA sola llamada', async () => {
    const fn = vi.fn(() => new Promise(r => setTimeout(() => r('dato'), 10)));

    const [a, b] = await Promise.all([
      coalesce('yahoo-profile/AMZN', fn),
      coalesce('yahoo-profile/AMZN', fn),
    ]);

    expect(fn).toHaveBeenCalledOnce();
    expect(a).toBe('dato');
    expect(b).toBe('dato');
  });

  it('claves distintas no se mezclan', async () => {
    const fn = vi.fn(async (v) => v);
    const [a, b] = await Promise.all([
      coalesce('AMZN', () => fn('a')),
      coalesce('GOOGL', () => fn('b')),
    ]);
    expect(fn).toHaveBeenCalledTimes(2);
    expect([a, b]).toEqual(['a', 'b']);
  });

  it('NO es una cache: al asentarse, la siguiente vuelve a pedir', async () => {
    const fn = vi.fn(async () => 'x');
    await coalesce('k1', fn);
    await coalesce('k1', fn);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(_inFlightSize()).toBe(0);
  });

  it('un fallo se propaga a TODOS los que esperaban y no queda memorizado', async () => {
    const fn = vi.fn(async () => { throw new Error('429'); });

    const p1 = coalesce('k2', fn);
    const p2 = coalesce('k2', fn);
    await expect(p1).rejects.toThrow('429');
    await expect(p2).rejects.toThrow('429');
    expect(fn).toHaveBeenCalledOnce();
    expect(_inFlightSize()).toBe(0);

    const ok = vi.fn(async () => 'ya va');
    await expect(coalesce('k2', ok)).resolves.toBe('ya va');
  });

  it('una funcion que lanza SINCRONAMENTE tambien se captura', async () => {
    await expect(coalesce('k3', () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(_inFlightSize()).toBe(0);
  });
});
