import { describe, it, expect } from 'vitest';
import { buildShareMeta, formatSignedPct, formatMonthYear } from './shareMeta.js';

const NOW = new Date('2026-10-04T12:00:00Z');
const base = (over = {}) => ({
  label: 'Mi cartera indexada',
  mode: 'snapshot',
  config: { show_pnl: true, show_values: true },
  expires_at: null,
  snapshot_data: { metrics: { annualized_return: 27.36, twr: 60.44, roi_cartera: 22.1, invested_since: '2024-10-06', market_value_eur: 35150.46 } },
  ...over,
});

describe('formatSignedPct', () => {
  it('pone signo, coma decimal y un decimal', () => {
    expect(formatSignedPct(27.36)).toBe('+27,4 %');
    expect(formatSignedPct(-3.14)).toBe('−3,1 %');
    expect(formatSignedPct(0.01)).toBe('0,0 %');
  });
  it('devuelve null si no es un número', () => {
    expect(formatSignedPct(null)).toBeNull();
    expect(formatSignedPct(undefined)).toBeNull();
    expect(formatSignedPct('abc')).toBeNull();
    expect(formatSignedPct(Infinity)).toBeNull();
  });
});

describe('formatMonthYear', () => {
  it('traduce el mes sin depender de la zona horaria', () => {
    expect(formatMonthYear('2024-10-06')).toBe('octubre de 2024');
    expect(formatMonthYear('2025-01-01T00:00:00Z')).toBe('enero de 2025');
  });
  it('devuelve null si la fecha no tiene forma', () => {
    expect(formatMonthYear(null)).toBeNull();
    expect(formatMonthYear('06/10/2024')).toBeNull();
  });
});

describe('buildShareMeta', () => {
  it('usa la etiqueta del dueño y las rentabilidades cuando el resultado es visible', () => {
    const m = buildShareMeta(base(), { now: NOW });
    expect(m.available).toBe(true);
    expect(m.title).toBe('Mi cartera indexada · cartera en Trazza');
    expect(m.description).toMatch(/^Rentabilidad anualizada \+27,4 % · TWR \+60,4 % · desde octubre de 2024\. /);
  });

  it('nunca enseña importes, aunque el dueño muestre los valores', () => {
    const m = buildShareMeta(base(), { now: NOW });
    expect(m.description).not.toMatch(/€|35\.150|35150/);
  });

  it('sin show_pnl no hay ningún porcentaje', () => {
    const m = buildShareMeta(base({ config: { show_pnl: false, show_values: true } }), { now: NOW });
    expect(m.description).not.toMatch(/%/);
    expect(m.description).not.toMatch(/desde/);
    expect(m.description).toMatch(/^Cartera compartida con Trazza/);
  });

  it('cae a la plusvalía actual si no hay rentabilidad histórica', () => {
    const m = buildShareMeta(base({ snapshot_data: { metrics: { roi_cartera: -4.2 } } }), { now: NOW });
    expect(m.description).toMatch(/^Plusvalía actual −4,2 %\. /);
  });

  it('una foto antigua sin métricas propias cae a la caché', () => {
    const m = buildShareMeta(base({ snapshot_data: null, cached_metrics: { twr: 12 } }), { now: NOW });
    expect(m.description).toMatch(/^TWR \+12,0 %\. /);
  });

  it('un enlace caducado o inexistente no revela la etiqueta', () => {
    const expired = buildShareMeta(base({ expires_at: '2026-10-01T00:00:00Z' }), { now: NOW });
    expect(expired.available).toBe(false);
    expect(expired.title).not.toMatch(/indexada/);
    expect(buildShareMeta(null, { now: NOW }).available).toBe(false);
  });

  it('sin etiqueta usa un título genérico y recorta las muy largas', () => {
    expect(buildShareMeta(base({ label: '   ' }), { now: NOW }).title).toBe('Cartera compartida en Trazza');
    const long = buildShareMeta(base({ label: 'x'.repeat(200) }), { now: NOW }).title;
    expect(long.length).toBeLessThan(90);
    expect(long).toMatch(/…/);
  });

  it('limpia caracteres de control de la etiqueta', () => {
    expect(buildShareMeta(base({ label: 'Cartera\n\tlarga' }), { now: NOW }).title).toBe('Cartera larga · cartera en Trazza');
  });
});

describe('buildShareMeta — cartera en vivo', () => {
  it('no da cifras: la caché es del día en que se creó el enlace y la página recalcula', () => {
    const m = buildShareMeta({
      label: 'Viva', mode: 'live', config: { show_pnl: true },
      cached_metrics: { annualized_return: 15, roi_cartera: 19.33, first_trade_date: '2024-10-18' },
    }, { now: NOW });
    expect(m.description).not.toMatch(/%/);
    expect(m.description).toMatch(/^Cartera en vivo, con los precios de cada día\. Cartera compartida con Trazza/);
  });
});
