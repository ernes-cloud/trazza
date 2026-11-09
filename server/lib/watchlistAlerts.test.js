import { describe, it, expect } from 'vitest';
import { evaluateWatchlistAlert } from './watchlistAlerts.js';

const target = (over = {}) => ({ alert_type: 'PRICE_TARGET', status: 'PENDING', target_value: 150, initial_price: 140, ...over });

describe('evaluateWatchlistAlert — precio objetivo de un disparo', () => {
  it('al cruzar el objetivo avisa y queda cumplida', () => {
    expect(evaluateWatchlistAlert(target(), { current: 151 })).toEqual({ kind: 'price', upside: true, nextStatus: 'TRIGGERED' });
  });

  it('cumplida, ya no avisa aunque el precio vuelva a bajar (antes: "cayó al objetivo (Baja)")', () => {
    expect(evaluateWatchlistAlert(target({ status: 'TRIGGERED' }), { current: 149 })).toBe(null);
    expect(evaluateWatchlistAlert(target({ status: 'TRIGGERED' }), { current: 151 })).toBe(null);
  });

  it('objetivo a la baja', () => {
    expect(evaluateWatchlistAlert(target({ initial_price: 160 }), { current: 150 })).toMatchObject({ upside: false });
    expect(evaluateWatchlistAlert(target({ initial_price: 160 }), { current: 151 })).toBe(null);
  });
});

describe('evaluateWatchlistAlert — variación diaria', () => {
  const pct = { alert_type: 'PERCENT_CHANGE', status: 'PENDING', target_value: 5 };
  it('salta con |%| ≥ umbral en cualquier sentido', () => {
    expect(evaluateWatchlistAlert(pct, { percentChange: -5.7 })).toEqual({ kind: 'percent', change: -5.7, target: 5 });
    expect(evaluateWatchlistAlert(pct, { percentChange: 4.9 })).toBe(null);
  });
  it('sigue activa tras dispararse (es diaria)', () => {
    expect(evaluateWatchlistAlert({ ...pct, status: 'TRIGGERED' }, { percentChange: 6 })).not.toBe(null);
  });
});
