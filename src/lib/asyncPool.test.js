import { describe, it, expect, vi } from 'vitest';
import { runPooled, runPooledSettled, withRetry, DEFAULT_POOL_SIZE } from './asyncPool';

const defer = () => { let res; const p = new Promise(r => { res = r; }); return { p, res }; };

describe('runPooled', () => {
  it('NUNCA supera el tamaño del pool (es lo que evita el 429 de Yahoo)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const jobs = Array.from({ length: 30 }, (_, i) => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 1));
      inFlight--;
      return i;
    });

    await runPooled(jobs, 4);

    expect(maxInFlight).toBe(4);
    expect(inFlight).toBe(0);
  });

  it('ejecuta TODOS los trabajos y devuelve los resultados en el orden de entrada', async () => {
    // Los trabajos acaban en orden inverso al de entrada: si el pool devolviera
    // por orden de finalización, un llamante que hoy usa Promise.all se rompería.
    const jobs = Array.from({ length: 8 }, (_, i) => async () => {
      await new Promise(r => setTimeout(r, (8 - i)));
      return i * 10;
    });

    const out = await runPooled(jobs, 3);

    expect(out).toEqual([0, 10, 20, 30, 40, 50, 60, 70]);
  });

  it('no lanza mas workers que trabajos hay', async () => {
    let started = 0;
    const jobs = [async () => { started++; return 1; }];
    await runPooled(jobs, 10);
    expect(started).toBe(1);
  });

  it('tolera la lista vacia', async () => {
    await expect(runPooled([], 4)).resolves.toEqual([]);
  });

  it('mantiene el pool LLENO: al acabar uno entra el siguiente, no espera al lote', async () => {
    const gates = Array.from({ length: 5 }, defer);
    let started = 0;
    const jobs = gates.map(g => async () => { started++; await g.p; });

    const done = runPooled(jobs, 2);
    await Promise.resolve();
    expect(started).toBe(2);          // solo dos en vuelo

    gates[0].res();                   // libera uno
    await new Promise(r => setTimeout(r, 0));
    expect(started).toBe(3);          // entra el tercero de inmediato

    gates.forEach(g => g.res());
    await done;
    expect(started).toBe(5);
  });

  it('el pool por defecto son 4', () => {
    expect(DEFAULT_POOL_SIZE).toBe(4);
  });
});

describe('withRetry', () => {
  it('reintenta un fallo transitorio y devuelve el resultado del segundo intento', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('429'))
      .mockResolvedValueOnce('ok');

    const out = await withRetry(fn, { sleepFn: async () => {} });

    expect(out).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('no reintenta si el primer intento funciona', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await withRetry(fn, { sleepFn: async () => {} });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('lanza el ULTIMO error cuando se agotan los intentos', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('primero'))
      .mockRejectedValueOnce(new Error('ultimo'));

    await expect(withRetry(fn, { sleepFn: async () => {} })).rejects.toThrow('ultimo');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('espera entre intentos con jitter (dos pestañas no deben sincronizarse)', async () => {
    const waits = [];
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('429'))
      .mockResolvedValueOnce('ok');

    await withRetry(fn, { baseDelay: 500, jitter: 500, sleepFn: async (ms) => { waits.push(ms); } });

    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(500);
    expect(waits[0]).toBeLessThan(1000);
  });
});

describe('runPooledSettled', () => {
  it('un job que falla no detiene el resto y conserva el orden', async () => {
    const jobs = [
      async () => 'a',
      async () => { throw new Error('429'); },
      async () => 'c',
    ];
    const out = await runPooledSettled(jobs, 2);
    expect(out).toEqual([
      { status: 'fulfilled', value: 'a' },
      { status: 'rejected', reason: expect.any(Error) },
      { status: 'fulfilled', value: 'c' },
    ]);
    expect(out[1].reason.message).toBe('429');
  });

  it('nunca supera la concurrencia pedida', async () => {
    let active = 0;
    let peak = 0;
    const jobs = Array.from({ length: 10 }, () => async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      throw new Error('x');
    });
    await runPooledSettled(jobs, 3);
    expect(peak).toBe(3);
  });
});
