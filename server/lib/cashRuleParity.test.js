import { describe, expect, it } from 'vitest';
import { isCashPosition } from '../../src/lib/positionKind.js';
import { includesInvestedSharePosition } from '../routes/sharePortfolio.js';
import { includesInvestedNotificationPosition } from '../jobs/notificationCron.js';
import { isInvestedHoldingAsset } from '../jobs/weeklyReport.js';

const positionFromAsset = (asset) => ({ assets: asset });

describe('server cash-rule parity with client canonical rule', () => {
  it.each([
    { name: 'asset_class Cash', asset: { asset_class: 'Cash', ticker: 'VWCE' }, expectedCash: true },
    { name: 'asset_class cash', asset: { asset_class: 'cash', ticker: 'VWCE' }, expectedCash: true },
    { name: 'asset_class CASH ', asset: { asset_class: 'CASH ', ticker: 'VWCE' }, expectedCash: true },
    { name: 'ticker CASH_EUR', asset: { asset_class: 'ETF', ticker: 'CASH_EUR' }, expectedCash: true },
    { name: 'ticker cash_usd', asset: { asset_class: 'ETF', ticker: 'cash_usd' }, expectedCash: true },
    { name: 'ticker CASH_EUR (EUR)', asset: { asset_class: 'ETF', ticker: 'CASH_EUR (EUR)' }, expectedCash: true },
    { name: 'normal ETF', asset: { asset_class: 'ETF', ticker: 'VWCE' }, expectedCash: false },
  ])('matches canonical rule for $name', ({ asset, expectedCash }) => {
    const position = positionFromAsset(asset);
    const canonicalIsCash = isCashPosition(position);
    expect(canonicalIsCash).toBe(expectedCash);

    expect(isCashPosition(position)).toBe(canonicalIsCash);
    expect(includesInvestedSharePosition(position)).toBe(!canonicalIsCash);
    expect(includesInvestedNotificationPosition(position)).toBe(!canonicalIsCash);
    expect(isInvestedHoldingAsset(asset)).toBe(!canonicalIsCash);
  });
});
