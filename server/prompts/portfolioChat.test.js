import { describe, it, expect } from 'vitest';
import { buildSystemMessage } from './portfolioChat.js';

const base = {
  currency: 'EUR', date: '02 oct 2026', brokers: [{ id: 'b1', name: 'DeGiro' }],
  totalWealth: 32190.5, investedValue: 32146.06, totalInvested: 25000, cashPosition: 44.44,
  totalGainAbs: 7146.06, totalGainPct: 28.58, dailyChangePct: 0.4,
  totalDividends: 120, totalFees: 30, realizedGain: 500,
};

describe('buildSystemMessage — contexto del chat', () => {
  it('el valor de una posición va en la divisa PREFERIDA, nunca con la de la posición (el bug "USD 9.701")', () => {
    const msg = buildSystemMessage({
      ...base,
      positions: [{
        name: 'Meta Platforms Inc Class A', symbol: 'META', quantity: 15,
        price: 729.84, priceCurrency: 'USD', avgCost: 600.2, avgCostCurrency: 'USD',
        valuePref: 9701.3, costPref: 8005.62, gainPref: 1695.68, gainPct: 21.18, weightPct: 27.69,
        brokers: ['DeGiro'], sector: 'Communication Services', country: 'US',
      }],
    });
    expect(msg).toContain('valuePref 9701.30 EUR');
    expect(msg).toContain('price 729.84 USD');
    expect(msg).toContain('avgCost 600.20 USD');
    expect(msg).not.toMatch(/USD 9701/);
  });

  it('pide formato para un panel estrecho y números en formato español', () => {
    const msg = buildSystemMessage({ ...base, positions: [] });
    expect(msg).toMatch(/NEVER use markdown tables with more than 2 columns/);
    expect(msg).toMatch(/32\.146,06 €/);
  });

  it('incluye rentabilidad y repartos cuando los hay', () => {
    const msg = buildSystemMessage({
      ...base, positions: [],
      performance: { twrTotalPct: 60.44, annualizedPct: 27.36, ytdPct: 12.1, oneMonthPct: -1.2, oneWeekPct: 0.8, since: '2024-10-06', asOf: '2026-10-01' },
      byBroker: [{ name: 'DeGiro', valuePref: 30000, weightPct: 93.3 }],
    });
    expect(msg).toContain('TWR since start +60.44%');
    expect(msg).toContain('annualized +27.36%');
    expect(msg).toContain('By broker: DeGiro 93.3%');
  });

  it('acepta el formato antiguo de contexto (app cacheada durante el despliegue)', () => {
    const msg = buildSystemMessage({
      ...base,
      positions: [{ name: 'Old', ticker: 'OLD', quantity: 1, price: 10, currency: 'USD', value: 9, gainAbs: 1, gainPct: 12.5, weight: 100 }],
    });
    expect(msg).toContain('valuePref 9.00 EUR');
  });

  it('sin datos, prohíbe inventar', () => {
    const msg = buildSystemMessage({ currency: 'EUR', positions: [], brokers: [], totalWealth: 0 });
    expect(msg).toMatch(/Do NOT invent values/);
  });
});
