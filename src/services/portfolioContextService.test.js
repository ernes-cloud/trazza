import { describe, it, expect } from 'vitest';
import { buildPortfolioContext, summarizePerformance } from './portfolioContextService';

const pos = (over = {}, asset = {}) => ({
  quantity: 1, entry_price: 100, broker_id: 'b1',
  ...over,
  assets: { ticker: 'X', currency: 'EUR', current_price: 100, asset_class: 'Stock', ...asset },
});
const brokers = [{ id: 'b1', name: 'DeGiro' }, { id: 'b2', name: 'IBKR' }];
const rates = { USD: 0.9, CAD: 0.6 };

describe('buildPortfolioContext — datos que llegan al chat', () => {
  it('el valor va en la divisa preferida y el precio y el coste medio en la de la posición, por separado', () => {
    // Caso de la conversación real: Constellation, 1 acción a C$3.000 comprada a C$2.500
    const ctx = buildPortfolioContext({
      positions: [pos({ entry_price: 2500 }, { ticker: 'CA21037X1006 (CAD)', isin: 'CA21037X1006', currency: 'CAD', current_price: 3000, company_name: 'CONSTELLATION SOFTWARE INC' })],
      brokers, rates, currency: 'EUR',
    });
    const r = ctx.positions[0];
    expect(r).toMatchObject({
      name: 'Constellation Software Inc', symbol: 'CSU.TO',
      price: 3000, priceCurrency: 'CAD', avgCost: 2500, avgCostCurrency: 'CAD',
      valuePref: 1800, costPref: 1500, gainPref: 300, gainPct: 20,
    });
  });

  it('agrupa por ISIN la misma acción comprada en dos mercados (antes salía dos veces)', () => {
    const ctx = buildPortfolioContext({
      positions: [
        pos({ quantity: 17, entry_price: 200 }, { ticker: 'US0231351067 (USD)', isin: 'US0231351067', currency: 'USD', current_price: 250, company_name: 'Amazon.com Inc' }),
        pos({ quantity: 7, entry_price: 180, broker_id: 'b2' }, { ticker: 'US0231351067 (EUR)', isin: 'US0231351067', currency: 'EUR', current_price: 220, company_name: 'AMZN' }),
      ],
      brokers, rates, currency: 'EUR',
    });
    expect(ctx.positions).toHaveLength(1);
    const r = ctx.positions[0];
    expect(r.name).toBe('Amazon.com Inc');
    expect(r.quantity).toBe(24);
    expect(r.valuePref).toBeCloseTo(17 * 250 * 0.9 + 7 * 220, 2);
    // Dos divisas: el coste medio nativo no tiene sentido y se omite
    expect(r.avgCost).toBeNull();
    expect(r.brokers.sort()).toEqual(['DeGiro', 'IBKR']);
  });

  it('excluye la liquidez y las posiciones cerradas', () => {
    const ctx = buildPortfolioContext({
      positions: [pos({}, { ticker: 'CASH_EUR', asset_class: 'Cash' }), pos({ quantity: 0 }), pos()],
      brokers, rates,
    });
    expect(ctx.positionCount).toBe(1);
  });

  it('reparte por broker, sector y país sumando 100 %', () => {
    const ctx = buildPortfolioContext({
      positions: [
        pos({ quantity: 3 }, { ticker: 'A', isin: 'US0000000001', sector: 'Technology' }),
        pos({ quantity: 1, broker_id: 'b2' }, { ticker: 'B', isin: 'DE0000000002', sector: 'Industrials' }),
      ],
      brokers, rates,
    });
    expect(ctx.byBroker).toEqual([
      { name: 'DeGiro', valuePref: 300, weightPct: 75 },
      { name: 'IBKR', valuePref: 100, weightPct: 25 },
    ]);
    expect(ctx.bySector.map((s) => s.name)).toEqual(['Technology', 'Industrials']);
    expect(ctx.byCountry.map((s) => s.name)).toEqual(['US', 'DE']);
  });
});

describe('summarizePerformance', () => {
  const now = new Date('2026-10-02T12:00:00Z');
  const series = [
    { date: '2024-10-01', value: 0, ttwror: 0 },
    { date: '2024-10-02', value: 1000, ttwror: 0 },
    { date: '2025-12-31', value: 1200, ttwror: 20 },
    { date: '2026-09-02', value: 1300, ttwror: 30 },
    { date: '2026-09-25', value: 1310, ttwror: 32 },
    { date: '2026-10-01', value: 1320, ttwror: 32 },
  ];

  it('TWR total, anualizado desde el primer día invertido y tramos YTD / 1 mes / 1 semana', () => {
    const s = summarizePerformance(series, now);
    expect(s.twrTotalPct).toBe(32);
    expect(s.since).toBe('2024-10-02');
    expect(s.ytdPct).toBe(10);          // 1,32 / 1,20 − 1
    expect(s.oneMonthPct).toBe(1.54);   // 1,32 / 1,30 − 1
    expect(s.oneWeekPct).toBe(0);       // desde el 25-sep (32 → 32)
    expect(s.annualizedPct).toBeGreaterThan(14);
    expect(s.annualizedPct).toBeLessThan(15);
  });

  it('sin serie no inventa nada', () => {
    expect(summarizePerformance(null, now)).toBeNull();
    expect(summarizePerformance([], now)).toBeNull();
  });
});
