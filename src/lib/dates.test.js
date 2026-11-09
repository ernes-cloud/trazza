import { describe, it, expect } from 'vitest';
import { localTodayIso, isoDateRange, parseIsoDateLocal } from './dates';

describe('localTodayIso', () => {
  it('usa los getters LOCALES, no la fecha UTC', () => {
    // 00:30 del 1 de julio en hora local: en UTC+2 todavía es 30 de junio.
    const d = new Date(2026, 6, 1, 0, 30);
    expect(localTodayIso(d)).toBe('2026-07-01');
  });
  it('rellena mes y día con cero', () => {
    expect(localTodayIso(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('isoDateRange', () => {
  it('incluye el primer y el último día', () => {
    expect(isoDateRange('2026-10-13', '2026-10-15')).toEqual(['2026-10-13', '2026-10-14', '2026-10-15']);
  });

  it('cruza los cambios de hora sin repetir ni saltarse días', () => {
    // Bug real: con setDate en hora local + toISOString, en verano cada día
    // salía con la fecha de AYER y "hoy" no aparecía nunca.
    expect(isoDateRange('2026-03-28', '2026-03-31')).toEqual(['2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31']);
    expect(isoDateRange('2026-10-24', '2026-10-27')).toEqual(['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27']);
  });

  it('un año entero tiene sus 365 días, sin duplicados', () => {
    const days = isoDateRange('2025-01-01', '2025-12-31');
    expect(days).toHaveLength(365);
    expect(new Set(days).size).toBe(365);
  });

  it('acepta fechas con hora (T…) y un rango vacío si el inicio va después', () => {
    expect(isoDateRange('2026-10-14T10:00:00Z', '2026-10-15')).toEqual(['2026-10-14', '2026-10-15']);
    expect(isoDateRange('2026-10-16', '2026-10-15')).toEqual([]);
  });
});

describe('parseIsoDateLocal', () => {
  it('es la medianoche LOCAL de ese día (no la UTC, que al oeste de UTC ya es ayer)', () => {
    const d = parseIsoDateLocal('2026-10-15');
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 9, 15, 0]);
  });

  it('una fecha no válida da null', () => {
    expect(parseIsoDateLocal('ayer')).toBeNull();
    expect(parseIsoDateLocal(null)).toBeNull();
  });
});
