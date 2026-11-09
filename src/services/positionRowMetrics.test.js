import { describe, it, expect } from 'vitest';
import { computePositionRowMetrics, computeTargetMetrics, resolveCashTarget } from './positionRowMetrics';

// Pin the exact semantics of the row metrics that were previously duplicated
// between CarteraPage's mobile list and desktop table.
describe('computePositionRowMetrics', () => {
  const ctx = {
    preferredCurrency: 'EUR',
    exchangeRates: { USD: 0.9, EUR: 1 },
    assetHistoricalCost: {},
  };

  const usdPos = (extra = {}) => ({
    id: 'p1',
    asset_id: 'a1',
    quantity: 10,
    entry_price: 100,
    assets: { currency: 'USD', current_price: 120 },
    ...extra,
  });

  it('FIFO _prefCostTotal tiene prioridad como base de coste', () => {
    const m = computePositionRowMetrics(usdPos({ _prefCostTotal: 900 }), ctx);
    // valConverted = 10 × 120 × 0.9 = 1080; gain = 1080/900 − 1 = 20%
    expect(m.valConverted).toBeCloseTo(1080, 10);
    expect(m.prefCostTotal).toBe(900);
    expect(m.gainPct).toBeCloseTo(20, 10);
    expect(m.profitConverted).toBeCloseTo(180, 10);
  });

  it('fallback AVCO (_histCost) escala el coste a la cantidad en cartera', () => {
    // Compró 20 por 2000, mantiene 10 → coste 1000
    const m = computePositionRowMetrics(
      usdPos({ _histCost: { totalHistCost: 2000, totalBoughtQty: 20 } }),
      ctx
    );
    expect(m.prefCostTotal).toBeCloseTo(1000, 10);
    expect(m.gainPct).toBeCloseTo((1080 / 1000 - 1) * 100, 10);
  });

  it('histCost con coste 0 NO se usa (cae al fallback de entry_price)', () => {
    const m = computePositionRowMetrics(
      usdPos({ _histCost: { totalHistCost: 0, totalBoughtQty: 20 } }),
      ctx
    );
    expect(m.prefCostTotal).toBe(0);
    // gainPct por ratio de precios: 120/100 − 1 = 20%
    expect(m.gainPct).toBeCloseTo(20, 10);
    // profit por la vía entry-price: 10 × (120−100) × 0.9 = 180
    expect(m.profitConverted).toBeCloseTo(180, 10);
  });

  it('identidad G/P: gpProducto + gpMoneda = profitConverted (con coste FIFO)', () => {
    const m = computePositionRowMetrics(usdPos({ _prefCostTotal: 950 }), ctx);
    expect(m.gpProducto).not.toBeNull();
    expect(m.gpMoneda).not.toBeNull();
    expect(m.gpProducto + m.gpMoneda).toBeCloseTo(m.profitConverted, 10);
  });

  it('gpMoneda es null sin coste histórico (solo gpProducto)', () => {
    const m = computePositionRowMetrics(usdPos(), ctx);
    expect(m.gpProducto).toBeCloseTo(180, 10);
    expect(m.gpMoneda).toBeNull();
  });

  it('posición merged usa _totalValueInPref y no muestra divisa nativa', () => {
    const m = computePositionRowMetrics(usdPos({ _totalValueInPref: 1111 }), ctx);
    expect(m.valConverted).toBe(1111);
    expect(m.showNativeCurrency).toBe(false);
    // valNative reconstruido con el fxRate del representante
    expect(m.valNative).toBeCloseTo(1111 / 0.9, 10);
  });

  it('misma divisa que la preferida → fxRate 1 y sin etiqueta nativa', () => {
    const m = computePositionRowMetrics(
      { quantity: 5, entry_price: 10, assets: { currency: 'EUR', current_price: 12 } },
      ctx
    );
    expect(m.fxRate).toBe(1);
    expect(m.showNativeCurrency).toBe(false);
    expect(m.valConverted).toBeCloseTo(60, 10);
  });

  it('sin current_price usa entry_price (gain 0, flechas apagadas)', () => {
    const m = computePositionRowMetrics(
      { quantity: 5, entry_price: 10, assets: { currency: 'EUR' } },
      ctx
    );
    expect(m.currentPrice).toBe(10);
    expect(m.gainPct).toBe(0);
    expect(m.priceUp).toBe(false);
    expect(m.priceDown).toBe(false);
  });

  it('gpObtenida refleja _realizedGain cuando existe', () => {
    expect(computePositionRowMetrics(usdPos({ _realizedGain: 42 }), ctx).gpObtenida).toBe(42);
    expect(computePositionRowMetrics(usdPos(), ctx).gpObtenida).toBeNull();
  });

  it('assetHistoricalCost (mapa legacy) funciona como fallback por asset_id', () => {
    const m = computePositionRowMetrics(usdPos(), {
      ...ctx,
      assetHistoricalCost: { a1: { totalHistCost: 1800, totalBoughtQty: 20 } },
    });
    expect(m.prefCostTotal).toBeCloseTo(900, 10);
  });
});

describe('computeTargetMetrics', () => {
  it('peso actual, fill y drift con target definido', () => {
    // valor 2000 sobre total 10000 = 20%; target 25% → under, fill 80%
    const m = computeTargetMetrics(2000, 25, 10000);
    expect(m.currentWeight).toBeCloseTo(20, 10);
    expect(m.fillPct).toBeCloseTo(80, 10);
    expect(m.isUnder).toBe(true);
    expect(m.isOver).toBe(false);
    expect(m.drift).toBeCloseTo(-5, 10);
    // faltan 25%×10000 − 2000 = 500 para llegar al target
    expect(m.moneyDelta).toBeCloseTo(500, 10);
  });

  it('sobre-asignado marca isOver y el fill se capa a 130', () => {
    const m = computeTargetMetrics(5000, 10, 10000); // 50% vs 10%
    expect(m.isOver).toBe(true);
    expect(m.fillPct).toBe(130);
    expect(m.moneyDelta).toBeCloseTo(-4000, 10);
  });

  it('sin target: moneyDelta null y sin over/under', () => {
    const m = computeTargetMetrics(2000, 0, 10000);
    expect(m.moneyDelta).toBeNull();
    expect(m.isOver).toBe(false);
    expect(m.isUnder).toBe(false);
    expect(m.fillPct).toBe(0);
  });

  it('dentro de la tolerancia de ±0.5% no marca over ni under', () => {
    const m = computeTargetMetrics(2030, 20, 10000); // 20.3% vs 20%
    expect(m.isOver).toBe(false);
    expect(m.isUnder).toBe(false);
  });

  it('total 0 → peso 0 sin dividir por cero', () => {
    expect(computeTargetMetrics(1000, 20, 0).currentWeight).toBe(0);
  });
});

describe('resolveCashTarget', () => {
  it('prefiere la posición CASH de la divisa preferida y su target_percentage', () => {
    const positions = [
      { asset_id: 'c2', target_percentage: 5, assets: { ticker: 'CASH_USD' } },
      { asset_id: 'c1', target_percentage: 12, assets: { ticker: 'CASH_EUR' } },
    ];
    const r = resolveCashTarget(positions, 'EUR');
    expect(r.cashTickerId).toBe('CASH_EUR');
    expect(r.cashTarget).toBe(12);
    expect(r.cashAsset.asset_id).toBe('c1');
  });

  it('cae a cualquier CASH_* si no hay una de la divisa preferida', () => {
    const positions = [{ asset_id: 'c2', target_percentage: 7, assets: { ticker: 'CASH_USD' } }];
    const r = resolveCashTarget(positions, 'EUR');
    expect(r.cashTickerId).toBe('CASH_USD');
    expect(r.cashTarget).toBe(7);
  });

  it('sin posición cash: ticker sintético y target 0 (localStorage no disponible en Node)', () => {
    const r = resolveCashTarget([], 'EUR');
    expect(r.cashAsset).toBeUndefined();
    expect(r.cashTickerId).toBe('CASH_EUR');
    expect(r.cashTarget).toBe(0);
  });
});
