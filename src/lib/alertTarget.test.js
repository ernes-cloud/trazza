import { describe, it, expect } from 'vitest';
import { parseAlertTarget, MIN_PERCENT, MAX_PERCENT } from './alertTarget.js';

describe('parseAlertTarget — porcentaje', () => {
  it('acepta coma decimal, que es lo que teclea un usuario español', () => {
    expect(parseAlertTarget('PERCENT_CHANGE', '2,5')).toEqual({ ok: true, value: 2.5 });
  });

  it('guarda el valor absoluto: la alerta es simétrica (±)', () => {
    expect(parseAlertTarget('PERCENT_CHANGE', '-5')).toEqual({ ok: true, value: 5 });
  });

  it('rechaza objetivos por debajo del mínimo (el caso real de ±1e-21%)', () => {
    expect(parseAlertTarget('PERCENT_CHANGE', '0.000000000000000000001')).toEqual({ ok: false, reason: 'min_percent' });
    expect(parseAlertTarget('PERCENT_CHANGE', '0,01')).toEqual({ ok: false, reason: 'min_percent' });
  });

  it('acepta justo los extremos', () => {
    expect(parseAlertTarget('PERCENT_CHANGE', String(MIN_PERCENT))).toEqual({ ok: true, value: MIN_PERCENT });
    expect(parseAlertTarget('PERCENT_CHANGE', String(MAX_PERCENT))).toEqual({ ok: true, value: MAX_PERCENT });
  });

  it('rechaza más de un 100% diario', () => {
    expect(parseAlertTarget('PERCENT_CHANGE', '150')).toEqual({ ok: false, reason: 'max_percent' });
  });
});

describe('parseAlertTarget — precio', () => {
  it('acepta un precio positivo con coma decimal', () => {
    expect(parseAlertTarget('PRICE_TARGET', '123,45')).toEqual({ ok: true, value: 123.45 });
  });

  it('rechaza cero y negativos', () => {
    expect(parseAlertTarget('PRICE_TARGET', '0')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseAlertTarget('PRICE_TARGET', '-10')).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('parseAlertTarget — entrada no numérica', () => {
  it.each(['', '   ', 'abc', '1e-21', '1.2.3', null, undefined])('rechaza %p', (raw) => {
    expect(parseAlertTarget('PERCENT_CHANGE', raw)).toEqual({ ok: false, reason: 'invalid' });
  });
});
