/**
 * C1: collectImportAssetRefs is the same pure helper useImportFlow uses to
 * build candidate refs before loadExistingAssetsByTicker. Tests must construct
 * the assets map the way the real save path does — never hand-key only the
 * CSV dbTicker.
 */
import { describe, it, expect } from 'vitest';
import { collectImportAssetRefs, indexAssetsByTicker } from './existingAssets';
import { buildTransactionRows, computeImportPlan } from './importPlanner';
import { calculateNetBuys } from './netHoldings';
import { getAssetIdentifiers } from './assetIdentity';
import { CANONICAL_CASH_RE } from '../../lib/cashIdentity';

const DEPOSIT = {
  type: 'TRANSFER', fecha: '01-01-2026', hora: '09:00', cantidad: 0, precio: 0,
  moneda: 'EUR', total: 1000, descripcion: 'Ingreso',
};

function planReimport({ broker, existingAsset, existingPos }) {
  const dataSource = [DEPOSIT];
  const netBuys = calculateNetBuys(dataSource, broker);
  const refs = collectImportAssetRefs({ netBuys, dataSource, broker });
  // Same composition as useImportFlow: refs (+ position asset ids in the hook)
  // → rows → indexAssetsByTicker.
  const existingAssetsByTicker = indexAssetsByTicker([existingAsset]);
  // Ensure aliases requested by collectImportAssetRefs are present when the
  // row's ticker is one of them (mirrors loadExistingAssetsByTicker by id).
  for (const r of refs) {
    if (!(r in existingAssetsByTicker) && existingAsset.ticker === r) {
      existingAssetsByTicker[r] = existingAsset;
    }
  }
  // Position carries nested assets like the new positions select.
  const pos = {
    ...existingPos,
    assets: existingAsset,
    broker_id: existingPos.broker_id || 'b1',
  };
  return computeImportPlan({
    dataSource,
    netBuys,
    broker,
    existingPositions: [pos],
    existingAssetsByTicker,
  });
}

describe('collectImportAssetRefs', () => {
  it('incluye aliases de cash y el dbTicker con broker (Binance → CASH_EUR)', () => {
    const net = {
      type: 'CASH', isin: 'CASH_EUR', producto: 'CASH_EUR', moneda: 'EUR', qty: 100, precio: 1,
    };
    const refs = collectImportAssetRefs({ netBuys: [net], dataSource: [], broker: 'binance' });
    expect(refs).toContain('CASH_EUR');
    expect(refs).toContain('CASH_EUR (EUR)');
    expect(getAssetIdentifiers(net, 'binance').dbTicker).toBe('CASH_EUR');
  });

  it('DeGiro pide CASH_EUR (EUR) y también el canónico CASH_EUR', () => {
    const netBuys = calculateNetBuys([DEPOSIT], 'degiro');
    const refs = collectImportAssetRefs({ netBuys, dataSource: [DEPOSIT], broker: 'degiro' });
    expect(refs).toContain('CASH_EUR (EUR)');
    expect(refs).toContain('CASH_EUR');
  });
});

describe('C1 — reimport con mapa = collectImportAssetRefs + indexAssetsByTicker', () => {
  const brokers = ['degiro', 'ibkr', 'myinvestor', 'trading212'];

  for (const broker of brokers) {
    it(`${broker}: usuario con CASH_EUR → 0 assets nuevos, 0 pos nuevas, update existente`, () => {
      const existingAsset = {
        id: 'a-cash', ticker: 'CASH_EUR', asset_class: 'Cash', currency: 'EUR', current_price: 1,
      };
      const existingPos = { id: 'p-cash', asset_id: 'a-cash', quantity: 1000, broker_id: 'b1' };
      const plan = planReimport({ broker, existingAsset, existingPos });
      expect(plan.assetsToCreate.filter((a) => String(a.ref).toUpperCase().includes('CASH'))).toHaveLength(0);
      expect(plan.positionsToCreate.filter((p) => String(p.ref).toUpperCase().includes('CASH'))).toHaveLength(0);
      expect(plan.positionUpdates.some((u) => u.positionId === 'p-cash')).toBe(true);
    });
  }

  it("otro usuario / asset compartido 'CASH_EUR (EUR)' + posición propia CASH_EUR → update de la posición propia", () => {
    const own = {
      id: 'a-own', ticker: 'CASH_EUR', asset_class: 'Cash', currency: 'EUR', current_price: 1,
    };
    const foreign = {
      id: 'a-foreign', ticker: 'CASH_EUR (EUR)', asset_class: 'Cash', currency: 'EUR', current_price: 1,
    };
    const dataSource = [DEPOSIT];
    const netBuys = calculateNetBuys(dataSource, 'degiro');
    const refs = collectImportAssetRefs({ netBuys, dataSource, broker: 'degiro' });
    expect(refs).toContain('CASH_EUR (EUR)');
    // Shared table has the decorated ticker (another user); this broker only
    // holds a position on CASH_EUR. Planner must update p-own, not create.
    const existingAssetsByTicker = indexAssetsByTicker([own, foreign]);
    const plan = computeImportPlan({
      dataSource,
      netBuys,
      broker: 'degiro',
      existingPositions: [{
        id: 'p-own', asset_id: own.id, quantity: 500, broker_id: 'b1', assets: own,
      }],
      existingAssetsByTicker,
    });
    expect(plan.assetsToCreate).toHaveLength(0);
    expect(plan.positionsToCreate).toHaveLength(0);
    expect(plan.positionUpdates.some((u) => u.positionId === 'p-own')).toBe(true);
  });
});

describe('I1 — Binance reimport con CASH_EUR existente', () => {
  it('no reinserta asset ni posición y no aborta', () => {
    const existingAsset = {
      id: 'a-bin', ticker: 'CASH_EUR', asset_class: 'Cash', currency: 'EUR', current_price: 1,
    };
    const dataSource = [DEPOSIT];
    const netBuys = calculateNetBuys(dataSource, 'binance');
    const refs = collectImportAssetRefs({ netBuys, dataSource, broker: 'binance' });
    expect(refs).toContain('CASH_EUR');
    const existingAssetsByTicker = indexAssetsByTicker([existingAsset]);
    const plan = computeImportPlan({
      dataSource,
      netBuys,
      broker: 'binance',
      existingPositions: [{
        id: 'p-bin', asset_id: existingAsset.id, quantity: 1000, broker_id: 'b1', assets: existingAsset,
      }],
      existingAssetsByTicker,
    });
    expect(plan.assetsToCreate).toHaveLength(0);
    expect(plan.positionsToCreate).toHaveLength(0);
    expect(plan.positionUpdates.some((u) => u.positionId === 'p-bin')).toBe(true);
  });

  it('reimport Binance con CASH_EUR (EUR) reutiliza y no crea cash duplicado', () => {
    const existingAsset = {
      id: 'a-bin-decorated', ticker: 'CASH_EUR (EUR)', asset_class: 'Cash', currency: 'EUR', current_price: 1,
    };
    const dataSource = [DEPOSIT];
    const netBuys = calculateNetBuys(dataSource, 'binance');
    const existingAssetsByTicker = indexAssetsByTicker([existingAsset]);
    const plan = computeImportPlan({
      dataSource,
      netBuys,
      broker: 'binance',
      existingPositions: [{
        id: 'p-bin-decorated',
        asset_id: existingAsset.id,
        quantity: 1000,
        broker_id: 'b1',
        assets: existingAsset,
      }],
      existingAssetsByTicker,
    });
    expect(plan.assetsToCreate.filter((a) => String(a.ref).toUpperCase().includes('CASH'))).toHaveLength(0);
    expect(plan.positionsToCreate.filter((p) => String(p.ref).toUpperCase().includes('CASH'))).toHaveLength(0);
    expect(plan.positionUpdates.some((u) => u.positionId === 'p-bin-decorated')).toBe(true);
  });
});

/** Production non-canonical cash tickers (punto 2 / lista owner). */
export const PROD_CASH_TICKERS = [
  'CASH',
  'CASH_- (-)',
  'CASH_CAD (CAD)',
  'CASH_CHF (CHF)',
  'CASH_DKK (DKK)',
  'CASH_EUR (EUR)',
  'CASH_GBP (GBP)',
  'CASH_NET_EUR',
  'CASH_USD (USD)',
];

describe('reimport con los 9 tickers de producción — no aborta / no duplica posición', () => {
  for (const ticker of PROD_CASH_TICKERS) {
    it(`ya tiene '${ticker}' → plan sin create de cash (o update de la pos)`, () => {
      const cur = (ticker.match(/CASH_([A-Z]{3})\b/) || [])[1]
        || (ticker.includes('EUR') ? 'EUR' : ticker.includes('USD') ? 'USD' : 'EUR');
      // Bare CASH / CASH_- (-) must never be treated as a currency match — the
      // planner may still create a canonical row; ensure it does not abort and
      // does not invent a second position on the SAME bare asset.
      const existingAsset = {
        id: `a-${ticker}`, ticker, asset_class: 'Cash',
        currency: cur === 'NET' ? 'EUR' : cur,
        current_price: 1,
      };
      const dataSource = [{
        type: 'TRANSFER', fecha: '01-01-2026', hora: '09:00', cantidad: 0, precio: 0,
        moneda: existingAsset.currency, total: 100, descripcion: 'Ingreso',
      }];
      const netBuys = calculateNetBuys(dataSource, 'degiro');
      const existingAssetsByTicker = indexAssetsByTicker([existingAsset]);
      // Reusable identity is strict; classification as cash is broader.
      const reusable = CANONICAL_CASH_RE.test(String(ticker).trim().toUpperCase())
        && !ticker.includes('NET');
      const existingPositions = [{
        id: 'p-prod',
        asset_id: existingAsset.id,
        quantity: 100,
        broker_id: 'b1',
        assets: existingAsset,
      }];
      const plan = computeImportPlan({
        dataSource,
        netBuys,
        broker: 'degiro',
        existingPositions,
        existingAssetsByTicker,
      });
      // Never plans two cash positions for the same broker currency when a
      // usable cash position already exists.
      if (reusable) {
        expect(plan.positionsToCreate.filter((p) => String(p.ref).toUpperCase().includes('CASH'))).toHaveLength(0);
        expect(plan.assetsToCreate.filter((a) => String(a.ref).toUpperCase().includes('CASH'))).toHaveLength(0);
        expect(plan.positionUpdates.some((u) => u.positionId === 'p-prod')).toBe(true);
      } else {
        const createsCashAsset = plan.assetsToCreate.some((a) => String(a.ref).toUpperCase().startsWith('CASH_'));
        const createsCashPos = plan.positionsToCreate.some((p) => String(p.ref).toUpperCase().startsWith('CASH_'));
        expect(plan.positionUpdates.some((u) => u.positionId === 'p-prod')).toBe(false);
        expect(createsCashAsset || createsCashPos).toBe(true);
      }
    });
  }
});

describe('buildTransactionRows cash fallback map (Binance/transfer/fees)', () => {
  it('vincula TRANSFER cuando positionIdMap solo tiene CASH_EUR (fallback canónico)', () => {
    const { rowsToInsert } = buildTransactionRows({
      dataSource: [{
        type: 'TRANSFER',
        fecha: '01-01-2026',
        hora: '09:00',
        cantidad: 0,
        precio: 0,
        total: 123,
        moneda: 'EUR',
        descripcion: 'Ingreso',
      }],
      broker: 'degiro',
      positionIdMap: { CASH_EUR: 'pos-cash' },
      existingTransMap: new Map(),
    });
    expect(rowsToInsert).toHaveLength(1);
    expect(rowsToInsert[0].position_id).toBe('pos-cash');
    expect(rowsToInsert[0].transaction_type).toBe('TRANSFER');
  });

  it('vincula FEE/TAX cuando positionIdMap solo tiene CASH_EUR (fallback canónico)', () => {
    const { rowsToInsert } = buildTransactionRows({
      dataSource: [{
        type: 'FEE',
        fecha: '01-01-2026',
        hora: '09:00',
        cantidad: 0,
        precio: 0,
        total: -3.5,
        moneda: 'EUR',
        descripcion: 'Comisión conectividad',
      }],
      broker: 'degiro',
      positionIdMap: { CASH_EUR: 'pos-cash' },
      existingTransMap: new Map(),
    });
    expect(rowsToInsert).toHaveLength(1);
    expect(rowsToInsert[0].position_id).toBe('pos-cash');
    expect(rowsToInsert[0].transaction_type).toBe('FEE');
  });
});
