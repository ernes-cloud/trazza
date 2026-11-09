import { describe, it, expect } from 'vitest';
import { mergeBenchmarkSeries } from './performanceService';

// Índice que sube un 10% cada sesión hábil — los porcentajes salen redondos.
const SP = [
  { date: '2023-01-05', close: 100 },
  { date: '2023-01-06', close: 110 },
  { date: '2023-01-09', close: 121 },
  { date: '2023-01-10', close: 133.1 },
  { date: '2023-01-11', close: 146.41 },
];

describe('mergeBenchmarkSeries', () => {
  it('se basa en el cierre ANTERIOR al primer día invertido, no en el primer punto', () => {
    // Caso de la demo: primer punto con valor 0 (solo caja) el 06, primera
    // posición el 10. La base tiene que ser el cierre del 09, no el del 05.
    const points = [
      { date: '2023-01-06', value: 0 },
      { date: '2023-01-09', value: 0 },
      { date: '2023-01-10', value: 1000 },
      { date: '2023-01-11', value: 1050 },
    ];
    const out = mergeBenchmarkSeries(points, SP);
    expect(out[0].sp500Return).toBeNull();
    expect(out[1].sp500Return).toBeNull();
    // 133,1 / 121 − 1 = +10%: el índice cuenta la sesión del 10, igual que la cartera.
    expect(out[2].sp500Return).toBeCloseTo(10, 6);
    expect(out[3].sp500Return).toBeCloseTo(21, 6);
  });

  it('un festivo arrastra el último valor y el primer día sin barra arranca en 0', () => {
    const points = [
      { date: '2023-01-07', value: 500 },  // sábado: sin barra
      { date: '2023-01-08', value: 500 },  // domingo
      { date: '2023-01-09', value: 520 },
    ];
    const out = mergeBenchmarkSeries(points, SP);
    // Base = cierre del 06 (110). Sábado y domingo no tienen barra: 0, no null.
    expect(out[0].sp500Return).toBe(0);
    expect(out[1].sp500Return).toBe(0);
    expect(out[2].sp500Return).toBeCloseTo(10, 6);
  });

  it('sin barra anterior usa la primera disponible (sin desfase inventado)', () => {
    const points = [{ date: '2023-01-05', value: 100 }, { date: '2023-01-06', value: 101 }];
    const out = mergeBenchmarkSeries(points, SP);
    expect(out[0].sp500Return).toBe(0);
    expect(out[1].sp500Return).toBeCloseTo(10, 6);
  });

  it('acepta series con la fecha en `name` (pantalla de brokers)', () => {
    const points = [{ name: '2023-01-09', value: 1 }, { name: '2023-01-10', value: 1 }];
    const out = mergeBenchmarkSeries(points, SP, { dateKey: 'name' });
    expect(out.map(d => d.sp500Return)).toEqual([expect.closeTo(10, 6), expect.closeTo(21, 6)]);
  });

  it('el orden de entrada del índice no importa', () => {
    const points = [{ date: '2023-01-10', value: 1 }];
    const a = mergeBenchmarkSeries(points, SP);
    const b = mergeBenchmarkSeries(points, [...SP].reverse());
    expect(b).toEqual(a);
  });

  it('sin índice o sin puntos devuelve la serie intacta', () => {
    const points = [{ date: '2023-01-10', value: 1 }];
    expect(mergeBenchmarkSeries(points, [])).toBe(points);
    expect(mergeBenchmarkSeries([], SP)).toEqual([]);
  });

  it('no muta la serie de entrada', () => {
    const points = [{ date: '2023-01-10', value: 1 }];
    mergeBenchmarkSeries(points, SP);
    expect(points[0]).not.toHaveProperty('sp500Return');
  });
});
