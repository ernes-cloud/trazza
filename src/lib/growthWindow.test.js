import { describe, it, expect } from 'vitest';
import { oneDayWindow } from './growthWindow';

// Serie real de la demo, 14 y 15 de octubre de 2026 (rentabilidad diaria aislada).
const series = [
  { date: '2026-10-13', isolatedTTWROR: -0.0034 },
  { date: '2026-10-14', isolatedTTWROR: -0.0073 },
  { date: '2026-10-15', isolatedTTWROR: -0.0076 },
];
const chain = (pts) => (pts.reduce((acc, p) => acc * (1 + (p.isolatedTTWROR || 0)), 1) - 1) * 100;

describe('oneDayWindow', () => {
  it('mide UNA sesión: la de hoy (antes encadenaba ayer + hoy, −1,48% en vez de −0,76%)', () => {
    const win = oneDayWindow(series);
    expect(win.map((p) => p.date)).toEqual(['2026-10-14', '2026-10-15']);
    expect(chain(win)).toBeCloseTo(-0.76, 6);
    expect(chain(series.slice(-2))).toBeCloseTo(-1.48, 1); // lo que pintaba antes
  });

  it('el primer punto es la base: 0 % y marcado', () => {
    const [base] = oneDayWindow(series);
    expect(base.isolatedTTWROR).toBe(0);
    expect(base.isOneDayBase).toBe(true);
  });

  it('no muta la serie de entrada', () => {
    oneDayWindow(series);
    expect(series[1].isolatedTTWROR).toBe(-0.0073);
  });

  it('con un solo punto o ninguno, lo deja tal cual', () => {
    expect(oneDayWindow([series[0]])).toEqual([series[0]]);
    expect(oneDayWindow([])).toEqual([]);
  });
});
