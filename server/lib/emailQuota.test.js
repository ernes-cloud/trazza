import { describe, it, expect } from 'vitest';
import {
  madridDayStartUtc,
  checkDailyQuota,
  DAILY_NOTIFICATION_EMAIL_LIMIT,
} from './emailQuota.js';

describe('checkDailyQuota', () => {
  it('deja pasar mientras no se alcance el tope', () => {
    expect(checkDailyQuota(0).allowed).toBe(true);
    expect(checkDailyQuota(14).allowed).toBe(true);
    expect(checkDailyQuota(14).remaining).toBe(1);
  });

  it('bloquea AL alcanzar el tope, no al superarlo', () => {
    // 15 enviados significa que el usuario ya recibió los 15 que le tocan.
    expect(checkDailyQuota(15).allowed).toBe(false);
    expect(checkDailyQuota(15).remaining).toBe(0);
    expect(checkDailyQuota(99).allowed).toBe(false);
  });

  it('el tope es 15', () => {
    expect(DAILY_NOTIFICATION_EMAIL_LIMIT).toBe(15);
  });

  it('un recuento inválido NO bloquea', () => {
    // Si la consulta falla, perder un aviso legítimo es peor que dejar pasar
    // algún correo de más. La misma asimetría que en los reintentos.
    for (const bad of [null, undefined, NaN, 'muchos']) {
      expect(checkDailyQuota(bad).allowed, String(bad)).toBe(true);
    }
  });

  it('un recuento negativo se trata como cero', () => {
    expect(checkDailyQuota(-5).remaining).toBe(DAILY_NOTIFICATION_EMAIL_LIMIT);
  });

  it('acepta un tope distinto', () => {
    expect(checkDailyQuota(3, 3).allowed).toBe(false);
    expect(checkDailyQuota(2, 3).allowed).toBe(true);
  });
});

describe('madridDayStartUtc', () => {
  it('en INVIERNO la medianoche de Madrid son las 23:00 UTC del día anterior', () => {
    // 15-ene-2026 10:00 UTC → Madrid es UTC+1 → el día empezó a las 23:00 del 14.
    const start = madridDayStartUtc(new Date('2026-01-15T10:00:00Z'));
    expect(start.toISOString()).toBe('2026-01-14T23:00:00.000Z');
  });

  it('en VERANO la medianoche de Madrid son las 22:00 UTC del día anterior', () => {
    // 15-jul-2026 10:00 UTC → Madrid es UTC+2 → el día empezó a las 22:00 del 14.
    const start = madridDayStartUtc(new Date('2026-07-15T10:00:00Z'));
    expect(start.toISOString()).toBe('2026-07-14T22:00:00.000Z');
  });

  it('a las 00:30 de Madrid el día es el NUEVO, no el de UTC', () => {
    // Éste es el bug que la función existe para evitar: a las 23:30 UTC del
    // 14 de enero en Madrid ya son las 00:30 del 15. Con toISOString() el
    // contador seguiría sumando en el día 14 y el cupo no se reiniciaría.
    const start = madridDayStartUtc(new Date('2026-01-14T23:30:00Z'));
    expect(start.toISOString()).toBe('2026-01-14T23:00:00.000Z');
    // Comprobación de que el día que abre es el 15 en hora de Madrid.
    const madridDay = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(start.getTime() + 60_000));
    expect(madridDay).toBe('2026-01-15');
  });

  it('el inicio del día nunca es posterior al instante consultado', () => {
    for (const iso of [
      '2026-01-01T00:00:00Z', '2026-03-29T01:30:00Z', // cambio a horario de verano
      '2026-06-30T12:00:00Z', '2026-10-25T00:30:00Z', // cambio a horario de invierno
      '2026-12-31T23:59:59Z',
    ]) {
      const now = new Date(iso);
      expect(madridDayStartUtc(now).getTime(), iso).toBeLessThanOrEqual(now.getTime());
    }
  });

  it('el día dura menos de 25 h incluso en los cambios de hora', () => {
    // Guardia de cordura: si el cálculo del desfase se equivocara de signo,
    // la ventana se iría a 47 h y el tope contaría dos días como uno.
    for (const iso of ['2026-03-29T12:00:00Z', '2026-10-25T12:00:00Z']) {
      const now = new Date(iso);
      const horas = (now.getTime() - madridDayStartUtc(now).getTime()) / 3_600_000;
      expect(horas, iso).toBeLessThan(25);
      expect(horas, iso).toBeGreaterThanOrEqual(0);
    }
  });
});
