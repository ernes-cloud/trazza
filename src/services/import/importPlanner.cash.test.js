/**
 * TDD (RED): cash ticker dual convention between writers.
 *
 * - ensureCashPosition / CarteraPage write assets.ticker = `CASH_${cur}` (e.g. CASH_EUR)
 * - importPlanner + getAssetIdentifiers (degiro/myinvestor/freeform cash) write
 *   `CASH_${cur} (${cur})` (e.g. CASH_EUR (EUR)) — see assetIdentity.js
 * - isCashPosition (positionKind.js) treats ANY ticker starting with CASH as liquidez
 *
 * Reimport keyed only on the DeGiro-style ref therefore creates a SECOND cash
 * position when the broker already has the ensureCashPosition form (or bare CASH).
 * Failures below must be "planned a second cash create", not mock/setup errors.
 */
import { describe, it, expect } from 'vitest';
import { computeImportPlan } from './importPlanner';
import { calculateNetBuys } from './netHoldings';
import { getAssetIdentifiers } from './assetIdentity';
import { collectImportAssetRefs, indexAssetsByTicker } from './existingAssets';

const DEPOSIT = {
  type: 'TRANSFER', fecha: '01-01-2026', hora: '09:00', cantidad: 0, precio: 0,
  moneda: 'EUR', total: 1000, descripcion: 'Ingreso',
};
const DATA = [DEPOSIT];

const cashRef = (broker = 'degiro') => getAssetIdentifiers({
  isin: 'CASH_EUR', producto: 'CASH_EUR', moneda: 'EUR', type: 'CASH',
}, broker).dbTicker;

describe('computeImportPlan — reimport no debe duplicar liquidez (TDD RED)', () => {
  it("(b) con liquidez CASH_EUR (ensureCashPosition) existente, reimport EUR no crea otra posicion CASH_EUR (EUR)", () => {
    // Mirror of useManualEntries.cash (a): the OTHER alias is already in DB.
    // Import's canonical ref today is `CASH_EUR (EUR)` (see cashRef()); the
    // position written by ensureCashPosition uses ticker `CASH_EUR`. Exact-key
    // lookup misses it → assetsToCreate + positionsToCreate for cash.
    const existingAsset = {
      id: 'a-cash-std',
      ticker: 'CASH_EUR',
      asset_class: 'Cash',
      currency: 'EUR',
      current_price: 1,
    };
    const existingPos = { id: 'p-cash-std', asset_id: existingAsset.id, quantity: 1000 };

    const netBuys = calculateNetBuys(DATA, 'degiro');
    expect(netBuys.some((n) => n.type === 'CASH' && n.moneda === 'EUR')).toBe(true);
    // Sanity: import still keys cash as DeGiro-style (the mismatch under test)
    expect(cashRef('degiro')).toBe('CASH_EUR (EUR)');

    // Same path as useImportFlow: collectImportAssetRefs → loadExistingAssetsByTicker
    // (here: indexAssetsByTicker on the rows that would come back for those refs).
    const refs = collectImportAssetRefs({ netBuys, dataSource: DATA, broker: 'degiro' });
    expect(refs).toContain(existingAsset.ticker);
    const existingAssetsByTicker = indexAssetsByTicker([existingAsset]);

    const plan = computeImportPlan({
      dataSource: DATA,
      netBuys,
      broker: 'degiro',
      existingPositions: [existingPos],
      existingAssetsByTicker,
    });

    const cashCreates = plan.positionsToCreate.filter((p) =>
      String(p.ref).toUpperCase().startsWith('CASH')
    );
    const cashAssetCreates = plan.assetsToCreate.filter((a) =>
      String(a.ref).toUpperCase().startsWith('CASH')
    );

    expect(cashAssetCreates).toHaveLength(0);
    expect(cashCreates).toHaveLength(0);
    expect(plan.positionUpdates.find((u) => u.positionId === existingPos.id)?.positionId).toBe(existingPos.id);
    expect(plan.refToPositionId[cashRef('degiro')]).toBe(existingPos.id);
  });

  it("(b') con 'CASH_EUR (EUR)' existente el reimport sigue reutilizando (control; ya pasa hoy)", () => {
    const existingAsset = {
      id: 'a-cash-degiro',
      ticker: 'CASH_EUR (EUR)',
      asset_class: 'Cash',
      currency: 'EUR',
      current_price: 1,
    };
    const existingPos = { id: 'p-cash-degiro', asset_id: existingAsset.id, quantity: 1000 };
    const netBuys = calculateNetBuys(DATA, 'degiro');
    const ref = cashRef('degiro');

    const plan = computeImportPlan({
      dataSource: DATA,
      netBuys,
      broker: 'degiro',
      existingPositions: [existingPos],
      existingAssetsByTicker: { [ref]: existingAsset },
    });

    expect(plan.assetsToCreate.filter((a) => String(a.ref).startsWith('CASH'))).toHaveLength(0);
    expect(plan.positionsToCreate.filter((p) => String(p.ref).startsWith('CASH'))).toHaveLength(0);
    expect(plan.refToPositionId[ref]).toBe(existingPos.id);
  });

  it('(c) simetrico USD: con CASH_USD estandar existente, reimport no debe crear CASH_USD (USD)', () => {
    const buyUsd = {
      type: 'BUY', fecha: '02-01-2026', hora: '10:00', cantidad: 1, precio: 50,
      isin: 'US0378331005', id_activo: 'US0378331005', producto: 'AAPL', nombre: 'Apple',
      moneda: 'USD', total: -50, comisiones: 0,
      descripcion: 'Compra 1 Apple@50 USD (US0378331005)',
    };
    // Ending-cash / transfer path that materialises CASH_USD in netBuys:
    const data = [
      buyUsd,
      { type: 'TRANSFER', fecha: '01-01-2026', hora: '09:00', cantidad: 0, precio: 0, moneda: 'USD', total: 500, descripcion: 'Deposit' },
    ];
    const existingCash = {
      id: 'a-cash-usd',
      ticker: 'CASH_USD',
      asset_class: 'Cash',
      currency: 'USD',
      current_price: 1,
    };
    const existingPos = { id: 'p-cash-usd', asset_id: existingCash.id, quantity: 500 };
    const stockAsset = {
      id: 'a-aapl',
      ticker: 'US0378331005 (USD)',
      currency: 'USD',
      current_price: 50,
    };
    const stockPos = { id: 'p-aapl', asset_id: stockAsset.id, quantity: 1 };

    const netBuys = calculateNetBuys(data, 'degiro');
    const plan = computeImportPlan({
      dataSource: data,
      netBuys,
      broker: 'degiro',
      existingPositions: [existingPos, stockPos],
      existingAssetsByTicker: {
        [existingCash.ticker]: existingCash,
        [stockAsset.ticker]: stockAsset,
      },
    });

    const cashCreates = plan.positionsToCreate.filter((p) =>
      String(p.ref).toUpperCase().includes('CASH_USD')
    );
    expect(cashCreates).toHaveLength(0);
  });
});
