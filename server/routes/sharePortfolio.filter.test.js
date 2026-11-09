import { describe, it, expect, vi } from 'vitest';

const { computeInvestedHybridMock, supabaseAdminMock } = vi.hoisted(() => {
  const computeInvestedHybrid = vi.fn((positions) => (
    positions.reduce((sum, p) => sum + ((parseFloat(p.quantity) || 0) * (parseFloat(p.entry_price) || 0)), 0)
  ));

  const supabaseAdmin = {
    from: vi.fn((table) => {
      if (table === 'portfolio_shares') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: '00000000-0000-4000-8000-000000000001',
                  user_id: 'user-1',
                  label: 'share',
                  mode: 'live',
                  config: { show_values: true, show_pnl: false },
                },
                error: null,
              }),
            }),
          }),
        };
      }

      if (table === 'brokers') {
        return {
          select: () => ({
            eq: () => ({
              data: [{ id: 'broker-1', name: 'Principal' }],
              error: null,
              in: () => ({ data: [{ id: 'broker-1', name: 'Principal' }], error: null }),
            }),
          }),
        };
      }

      if (table === 'positions') {
        return {
          select: (fields) => {
            if (String(fields).includes('assets(')) {
              return {
                in: () => ({
                  gt: () => ({
                    data: [
                      {
                        id: 'pos-cash',
                        broker_id: 'broker-1',
                        quantity: 1000,
                        entry_price: 1,
                        assets: { ticker: 'CASH_EUR', currency: 'EUR', current_price: 1, asset_class: 'Cash' },
                      },
                      {
                        id: 'pos-stock',
                        broker_id: 'broker-1',
                        quantity: 2,
                        entry_price: 100,
                        assets: { ticker: 'AAPL', currency: 'EUR', current_price: 100, asset_class: 'Stock' },
                      },
                    ],
                    error: null,
                  }),
                }),
              };
            }
            return {
              in: () => ({
                data: [{ id: 'pos-cash' }, { id: 'pos-stock' }],
                error: null,
              }),
            };
          },
        };
      }

      if (table === 'transactions') {
        return {
          select: () => ({
            in: () => ({
              order: () => ({ data: [], error: null }),
            }),
          }),
        };
      }

      if (table === 'portfolio_metrics_cache') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
        };
      }

      if (table === 'imported_data') {
        return {
          select: () => ({
            eq: () => ({
              in: async () => ({ data: [], error: null }),
            }),
          }),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    }),
  };

  return { computeInvestedHybridMock: computeInvestedHybrid, supabaseAdminMock: supabaseAdmin };
});

vi.mock('../lib/adminSupabase.js', () => ({ supabaseAdmin: supabaseAdminMock }));
vi.mock('../../src/services/portfolioHistory.js', () => ({
  computeHistoryTotals: vi.fn(async () => ({
    dividends: 0,
    totalBuyCost: 0,
    realized: 0,
    firstTransactionDate: null,
    openPositionCost: 0,
    fees: 0,
    tradeCommissions: 0,
    tradeCommissionsByBroker: {},
    perAssetMetrics: {},
    buyTotalsByPosition: {},
    buyTotalsByAsset: {},
    realizedSales: [],
  })),
  scaleOpenCostToHeldQty: vi.fn(() => 0),
  computeInvestedHybrid: computeInvestedHybridMock,
}));
vi.mock('../../src/services/portfolioStats.js', () => ({
  computeEmbeddedCommissionsFallback: vi.fn(() => 0),
}));
vi.mock('../../src/services/positionRowMetrics.js', () => ({
  computePositionRowMetrics: vi.fn(() => ({ profitConverted: 0, prefCostTotal: 200, gainPct: 0 })),
}));
vi.mock('../../src/services/performanceService.js', () => ({
  annualizeReturn: vi.fn(() => null),
}));

import { getShare } from './sharePortfolio.js';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
};

describe('getShare cash filter wiring', () => {
  it('excludes CASH_* positions from invested metrics', async () => {
    const req = { params: { token: '00000000-0000-4000-8000-000000000001' } };
    const res = makeRes();

    await getShare(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.positions).toHaveLength(1);
    expect(res.body.positions[0].ticker).toBe('AAPL');
    expect(res.body.metrics.market_value_eur).toBe(200);
    expect(res.body.metrics.open_invested_eur).toBe(200);
    expect(computeInvestedHybridMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: 'pos-stock' }),
      ]),
      expect.any(Object),
      expect.any(Object),
    );
    expect(computeInvestedHybridMock.mock.calls[0][0]).toHaveLength(1);
  });
});
