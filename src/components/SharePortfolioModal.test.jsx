import { describe, expect, it } from 'vitest';
import { buildSnapshotData } from './SharePortfolioModal';

describe('buildSnapshotData cash filtering', () => {
  it('excludes cash rows with lowercase asset_class so modal snapshot matches shared-page cash rule', () => {
    const positions = [
      {
        broker_id: 'b1',
        quantity: 1000,
        entry_price: 1,
        current_price: 1,
        assets: { ticker: 'EUR', currency: 'EUR', asset_class: 'cash', name: 'Cash row' },
      },
      {
        broker_id: 'b1',
        quantity: 2,
        entry_price: 100,
        current_price: 120,
        assets: { ticker: 'AAPL', currency: 'USD', asset_class: 'Stock', name: 'Apple' },
      },
    ];

    const out = buildSnapshotData(
      positions,
      { EUR: 1, USD: 1.1 },
      { show_values: true, show_pnl: true, show_cost_basis: false, show_chart: true, show_broker_names: false },
      ['b1'],
    );

    expect(out.positions).toHaveLength(1);
    expect(out.positions[0].ticker).toBe('AAPL');
  });
});
