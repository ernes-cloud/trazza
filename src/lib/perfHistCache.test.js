import { describe, it, expect, vi } from 'vitest';
import { createPerfHistCache, slimBars, PERF_LS_PREFIX } from './perfHistCache';

/** localStorage falso con CUOTA, que es la condición que hay que reproducir. */
function fakeStorage(limitBytes = Infinity) {
  const map = new Map();
  const used = (skipKey) => [...map.entries()]
    .reduce((s, [k, v]) => s + (k === skipKey ? 0 : k.length + v.length), 0);
  return {
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    removeItem(k) { map.delete(k); },
    setItem(k, v) {
      if (used(k) + k.length + v.length > limitBytes) {
        const e = new Error('QuotaExceededError');
        e.name = 'QuotaExceededError';
        throw e;
      }
      map.set(k, v);
    },
    _map: map,
  };
}

const bars = (n = 3) => Array.from({ length: n }, (_, i) => ({
  time: `2026-01-0${i + 1}`, close: 100 + i, open: 99, high: 101, low: 98, volume: 123456,
}));


/** Tamaño real de UNA entrada, medido — así los límites de cuota de abajo son
 *  relativos al payload y no números mágicos que caducan al tocarlo. */
const ENTRY = (() => {
  const s = fakeStorage();
  const c = createPerfHistCache({ storage: s, range: 'r', now: () => 1_000_000 });
  c.save('PROBE', bars(2));
  const k = c.keyFor('PROBE');
  return k.length + s.getItem(k).length;
})();
const FITS_ONE = Math.floor(ENTRY * 1.5);
const FITS_TWO = Math.floor(ENTRY * 2.5);

describe('slimBars', () => {
  it('se queda SOLO con time y close (lo unico que lee calculateDailyTWR)', () => {
    expect(slimBars(bars(2))).toEqual([
      { time: '2026-01-01', close: 100 },
      { time: '2026-01-02', close: 101 },
    ]);
  });

  it('tolera entradas que no son array', () => {
    expect(slimBars(null)).toEqual([]);
    expect(slimBars(undefined)).toEqual([]);
  });

  it('recorta de verdad el tamaño guardado', () => {
    const full = JSON.stringify(bars(500)).length;
    const slim = JSON.stringify(slimBars(bars(500))).length;
    // Medido sobre series reales de 10 años: 271 KB -> 106 KB por ticker.
    expect(slim).toBeLessThan(full * 0.5);
  });
});

describe('createPerfHistCache', () => {
  it('guarda y recupera, marcando si esta vencida', () => {
    let t = 1_000_000;
    const storage = fakeStorage();
    const c = createPerfHistCache({ storage, range: '10y', ttl: 1000, now: () => t });

    expect(c.save('AAPL', bars())).toBe(true);
    expect(c.load('AAPL').stale).toBe(false);
    expect(c.load('AAPL').data).toEqual(slimBars(bars()));

    t += 1001;
    expect(c.load('AAPL').stale).toBe(true);
  });

  it('caduca al cambiar de día aunque no haya pasado el TTL (todas las series del mismo día)', () => {
    // Regresión 2026-10-02: con solo un TTL de 23 h cada ticker caducaba a una
    // hora distinta, y el TWR mezclaba series que acababan en días distintos
    // (o con un precio de media sesión guardado como "cierre"). El gráfico 1W
    // marcó -1,64 % donde los mismos cálculos con datos frescos dan -0,83 %.
    let t = new Date(2026, 9, 1, 23, 0).getTime();   // 1-oct 23:00 (hora local)
    const c = createPerfHistCache({ storage: fakeStorage(), range: '10y', ttl: 23 * 3600 * 1000, now: () => t });
    c.save('META', bars());

    t = new Date(2026, 9, 1, 23, 59).getTime();      // mismo día: sigue valiendo
    expect(c.load('META').stale).toBe(false);

    t = new Date(2026, 9, 2, 1, 0).getTime();        // día siguiente, 2 h después
    expect(c.load('META').stale).toBe(true);
  });

  it('el rango forma parte de la clave (una serie de 5y no se sirve como 10y)', () => {
    const storage = fakeStorage();
    const c5  = createPerfHistCache({ storage, range: '5y' });
    const c10 = createPerfHistCache({ storage, range: '10y' });
    c5.save('AAPL', bars());
    expect(c10.load('AAPL')).toBeNull();
  });

  it('ante la cuota llena DESALOJA lo vencido y consigue guardar', () => {
    let t = 1_000_000;
    const storage = fakeStorage(FITS_ONE);
    const c = createPerfHistCache({ storage, range: 'r', ttl: 1000, now: () => t });

    expect(c.save('VIEJO', bars(2))).toBe(true);
    t += 5000;                                  // VIEJO queda vencido
    expect(c.save('NUEVO', bars(2))).toBe(true);  // no cabría sin desalojar

    expect(c.load('NUEVO')).not.toBeNull();
    expect(c.load('VIEJO')).toBeNull();           // fue la víctima
  });

  it('sin nada vencido desaloja lo MAS ANTIGUO y guarda', () => {
    let t = 1_000_000;
    const storage = fakeStorage(FITS_TWO);
    const c = createPerfHistCache({ storage, range: 'r', ttl: 10_000_000, now: () => t });

    c.save('A', bars(2)); t += 10;
    c.save('B', bars(2)); t += 10;
    expect(c.save('C', bars(2))).toBe(true);

    expect(c.load('C')).not.toBeNull();
    expect(c.load('A')).toBeNull();   // el más antiguo cae primero
  });

  it('NUNCA borra claves ajenas a su prefijo', () => {
    let t = 1_000_000;
    const storage = fakeStorage(FITS_ONE);
    storage.setItem('trazza_selected_broker', 'broker-1');
    const c = createPerfHistCache({ storage, range: 'r', ttl: 1000, now: () => t });

    c.save('A', bars(2));
    t += 5000;
    c.save('B', bars(2));

    expect(storage.getItem('trazza_selected_broker')).toBe('broker-1');
  });

  it('AVISA y devuelve false cuando ni desalojando cabe (nunca calla)', () => {
    const warn = vi.fn();
    const storage = fakeStorage(10);            // no cabe nada
    const c = createPerfHistCache({ storage, range: 'r', warn });

    expect(c.save('AAPL', bars(50))).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('localStorage lleno');
  });

  it('una entrada corrupta no revienta la lectura', () => {
    const storage = fakeStorage();
    const c = createPerfHistCache({ storage, range: 'r' });
    storage.setItem(c.keyFor('AAPL'), '{no es json');
    expect(c.load('AAPL')).toBeNull();
  });

  it('sin storage (SSR / modo privado) degrada sin lanzar', () => {
    const c = createPerfHistCache({ storage: null, range: 'r' });
    expect(c.load('AAPL')).toBeNull();
    expect(c.save('AAPL', bars())).toBe(false);
    expect(c.entries()).toEqual([]);
  });

  it('solo inventaria las entradas con su propio prefijo', () => {
    const storage = fakeStorage();
    storage.setItem('trazza_dark', 'true');
    const c = createPerfHistCache({ storage, range: 'r' });
    c.save('AAPL', bars());
    const inv = c.entries();
    expect(inv).toHaveLength(1);
    expect(inv[0].key.startsWith(PERF_LS_PREFIX)).toBe(true);
  });
});
