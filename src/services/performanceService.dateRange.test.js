// La zona horaria importa: el fallo aparece con desfase POSITIVO cuando la
// primera operación es de INVIERNO (UTC+1) y hoy es de VERANO (UTC+2) — el
// caso de la demo y de cualquier cartera con historia. Node aplica el TZ al vuelo.
globalThis.process.env.TZ = 'Europe/Madrid';

import { describe, it, expect, vi, afterEach } from 'vitest';
import { performanceService } from './performanceService.js';

/**
 * Fechas de la serie de rendimiento (bug medido el 2026-10-15): el rango de
 * días se construía con new Date('YYYY-MM-DD') + setDate (hora local) +
 * toISOString (UTC). En verano, en Madrid, cada punto llevaba la fecha de
 * AYER y su cierre, y el día de hoy no aparecía: el "1D" del Dashboard
 * enseñaba −1,07% (el movimiento de ayer) con la tarjeta diciendo −0,76% hoy.
 */
const buy = {
  transaction_date: '2026-01-12T09:30:00',
  transaction_type: 'BUY',
  quantity: 1,
  price: 100,
  isin: 'TEST0000001',
  positions: { assets: { ticker: 'TEST', currency: 'EUR', company_name: 'Test Co' } },
};
const closes = { '2026-01-12': 100, '2026-07-13': 104, '2026-07-14': 110, '2026-07-15': 121 };
const prices = { TEST: Object.entries(closes).map(([time, close]) => ({ time, close })) };
const resolve = (t) => (t && t.startsWith('TEST0') ? null : t);
const run = () => performanceService.calculateDailyTWR([buy], prices, {}, {}, 'EUR', {}, resolve, [buy]);

describe('serie de rendimiento — fechas en horario de verano', () => {
  afterEach(() => vi.useRealTimers());

  it('el último punto es HOY (no ayer) y no hay días repetidos', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 15, 22, 0)); // 15-jul 22:00 en Madrid
    const out = run();
    const dates = out.map((d) => d.date);
    expect(dates.at(-1)).toBe('2026-07-15');
    expect(dates[0]).toBe('2026-01-12');
    expect(new Set(dates).size).toBe(dates.length);
  });

  it('cada día se valora con SU cierre: el del 15 es 121, no el 110 del 14', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 15, 22, 0));
    const out = run();
    const byDate = Object.fromEntries(out.map((d) => [d.date, d]));
    expect(byDate['2026-07-15'].value).toBeCloseTo(121, 6);
    expect(byDate['2026-07-14'].value).toBeCloseTo(110, 6);
  });
});
