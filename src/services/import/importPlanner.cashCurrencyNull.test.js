import { describe, expect, it } from 'vitest';
import { computeImportPlan } from './importPlanner';
import { calculateNetBuys } from './netHoldings';

const DEPOSIT = {
  type: 'TRANSFER',
  fecha: '01-01-2026',
  hora: '09:00',
  cantidad: 0,
  precio: 0,
  moneda: 'EUR',
  total: 1000,
  descripcion: 'Ingreso',
};

const CASES = [
  { broker: 'degiro', ticker: 'CASH_EUR' },
  { broker: 'degiro', ticker: 'CASH_EUR (EUR)' },
  { broker: 'ibkr', ticker: 'CASH_EUR' },
  { broker: 'ibkr', ticker: 'CASH_EUR (EUR)' },
  { broker: 'binance', ticker: 'CASH_EUR' },
  { broker: 'binance', ticker: 'CASH_EUR (EUR)' },
];

describe('computeImportPlan cash reuse when currency is null', () => {
  for (const { broker, ticker } of CASES) {
    it(`${broker} reuses ${ticker} with null currency`, () => {
      const existingAsset = {
        id: `a-${broker}-${ticker}`,
        ticker,
        currency: null,
        asset_class: 'Cash',
        current_price: 1,
      };
      const existingPos = {
        id: `p-${broker}-${ticker}`,
        asset_id: existingAsset.id,
        quantity: 100,
        broker_id: 'b1',
        assets: existingAsset,
      };
      const dataSource = [DEPOSIT];
      const netBuys = calculateNetBuys(dataSource, broker);
      const existingAssetsByTicker = {
        [ticker]: existingAsset,
      };

      const plan = computeImportPlan({
        dataSource,
        netBuys,
        broker,
        existingPositions: [existingPos],
        existingAssetsByTicker,
      });

      expect(plan.assetsToCreate).toEqual([]);
      expect(plan.positionsToCreate).toEqual([]);
      expect(plan.positionUpdates.some((u) => u.positionId === existingPos.id)).toBe(true);
    });
  }
});
