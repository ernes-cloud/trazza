import { describe, it, expect } from 'vitest';
import { computeImportPlan, buildTransactionRows } from './importPlanner';
import { calculateNetBuys } from './netHoldings';
import { DEDUPE_SELECT_FIELDS, transCheckKey, buildExistingTransMap } from '../../lib/importDedupe';

// ─── Fixture: import DeGiro típico (compra USD + depósito EUR + comisión) ────

const BUY = {
  type: 'BUY', fecha: '02-01-2026', hora: '10:00', cantidad: 2, precio: 100,
  isin: 'US0378331005', id_activo: 'US0378331005', producto: 'AAPL', nombre: 'Apple Inc',
  moneda: 'USD', total: -200, comisiones: 2,
  descripcion: 'Compra 2 Apple Inc@100 USD (US0378331005)',
};
const DEPOSIT = {
  type: 'TRANSFER', fecha: '01-01-2026', hora: '09:00', cantidad: 0, precio: 0,
  moneda: 'EUR', total: 1000, descripcion: 'Ingreso',
};
const FEE = {
  type: 'FEE', fecha: '03-01-2026', hora: '09:00', cantidad: 0, precio: 0,
  moneda: 'EUR', total: -2.5, descripcion: 'Comisión de conectividad NASDAQ',
};
const DATA = [BUY, DEPOSIT, FEE];

const planFresh = () => {
  const netBuys = calculateNetBuys(DATA, 'degiro');
  return {
    netBuys,
    plan: computeImportPlan({
      dataSource: DATA,
      netBuys,
      broker: 'degiro',
      existingPositions: [],
      existingAssetsByTicker: {},
    }),
  };
};

// Simulate applying a plan: returns the DB state the executor would leave behind.
const applyMentally = (plan, dataSource, broker) => {
  const assetsByTicker = {};
  plan.assetsToCreate.forEach(({ ref, row }) => {
    assetsByTicker[ref] = { id: `a-${ref}`, ...row };
  });
  const positions = [];
  const positionIdMap = { ...plan.refToPositionId };
  plan.positionsToCreate.forEach(({ ref, assetId, assetRef }) => {
    const id = `p-${ref}`;
    positions.push({ id, asset_id: assetId ?? `a-${assetRef}` });
    positionIdMap[ref] = id;
  });
  const { rowsToInsert } = buildTransactionRows({
    dataSource, broker, positionIdMap, existingTransMap: new Map(),
  });
  const existingTrans = rowsToInsert.map((r, i) => ({ id: `t-${i}`, ...r }));
  return { assetsByTicker, positions, existingTrans, positionIdMap };
};

describe('computeImportPlan — import nuevo (DB vacía)', () => {
  it('planifica asset + posición para el stock y para la caja de cada divisa', () => {
    const { plan } = planFresh();
    const refs = plan.assetsToCreate.map(a => a.ref);
    expect(refs).toContain('US0378331005 (USD)');
    expect(refs).toContain('CASH_USD (USD)');
    expect(refs).toContain('CASH_EUR (EUR)');
    expect(plan.positionsToCreate).toHaveLength(plan.assetsToCreate.length);
    expect(plan.positionUpdates).toHaveLength(0);
    expect(plan.positionsToClose).toHaveLength(0);
  });

  it('las filas de historial enlazan compra→posición del stock y fee/transfer→caja', () => {
    const { plan } = planFresh();
    const { positionIdMap } = applyMentally(plan, DATA, 'degiro');
    const { rowsToInsert } = buildTransactionRows({
      dataSource: DATA, broker: 'degiro', positionIdMap, existingTransMap: new Map(),
    });
    expect(rowsToInsert).toHaveLength(3);
    const buyRow = rowsToInsert.find(r => r.transaction_type === 'BUY');
    expect(buyRow.position_id).toBe(positionIdMap['US0378331005 (USD)']);
    expect(buyRow.commission).toBe(2);
    expect(buyRow.transaction_currency).toBe('USD'); // derivada de la descripción
    const feeRow = rowsToInsert.find(r => r.transaction_type === 'FEE');
    expect(feeRow.position_id).toBe(positionIdMap['CASH_EUR (EUR)']);
  });
});

describe('computeImportPlan — IDEMPOTENCIA (la garantía del re-sync)', () => {
  it('planificar contra el estado resultante de aplicar el plan produce un plan VACÍO', () => {
    const { netBuys, plan } = planFresh();
    const after = applyMentally(plan, DATA, 'degiro');

    const plan2 = computeImportPlan({
      dataSource: DATA,
      netBuys,
      broker: 'degiro',
      existingPositions: after.positions,
      existingAssetsByTicker: after.assetsByTicker,
    });

    expect(plan2.assetsToCreate).toHaveLength(0);
    expect(plan2.positionsToCreate).toHaveLength(0);
    expect(plan2.positionsToClose).toHaveLength(0);

    const positionIdMap2 = { ...plan2.refToPositionId };
    plan2.positionUpdates.forEach(u => { positionIdMap2[u.ref] = u.positionId; });
    const existingTransMap = new Map(after.existingTrans.map(t => [
      // same key derivation the orchestrator uses over DEDUPE_SELECT_FIELDS rows
      transCheckKey(t), { id: t.id, eur_total: t.eur_total, notes: t.notes, commission: t.commission, transaction_currency: t.transaction_currency },
    ]));
    const { rowsToInsert, rowsToPatch } = buildTransactionRows({
      dataSource: DATA, broker: 'degiro', positionIdMap: positionIdMap2, existingTransMap,
    });
    expect(rowsToInsert).toHaveLength(0);
    expect(rowsToPatch).toHaveLength(0);
  });

  it('el SELECT de dedupe expone todos los campos que usa la clave', () => {
    // total_amount faltó una vez y duplicó dividendos durante meses.
    for (const field of ['transaction_date', 'transaction_type', 'quantity', 'price', 'total_amount', 'position_id', 'notes']) {
      expect(DEDUPE_SELECT_FIELDS).toContain(field);
    }
  });
});

describe('computeImportPlan — el coste base conocido nunca se machaca con 0', () => {
  it('un BUY a precio 0 (depósito en especie) no pisa el entry_price existente', () => {
    // Caso real: BTC comprado en Binance (BEP conocido) + sync de Kraken cuyo
    // único movimiento es el depósito en especie a precio 0 → el update de la
    // posición ponía entry_price 0 y destruía el coste base.
    const inKind = [{
      type: 'BUY', fecha: '29-06-2026', hora: '09:22', cantidad: 0.0152, precio: 0,
      producto: 'BTC-USD', isin: '', moneda: 'USD', total: 0, descripcion: 'CONTRIBUTION XXBT',
    }];
    const netBuys = calculateNetBuys(inKind, 'freeform');
    const asset = { id: 'a-btc', ticker: 'BTC-USD', current_price: 60000 };
    const plan = computeImportPlan({
      dataSource: inKind, netBuys, broker: 'freeform',
      existingPositions: [{ id: 'p-btc', asset_id: 'a-btc', entry_price: 68800 }],
      existingAssetsByTicker: { 'BTC-USD': asset },
    });
    const upd = plan.positionUpdates.find(u => u.positionId === 'p-btc');
    expect(upd.row.entry_price).toBe(68800); // preserved
    expect(upd.row.quantity).toBeCloseTo(0.0152, 6);
  });

  it('con precio real el entry_price sí se actualiza', () => {
    const buy = [{
      type: 'BUY', fecha: '29-06-2026', hora: '09:22', cantidad: 1, precio: 50000,
      producto: 'BTC-USD', isin: '', moneda: 'USD', total: -50000, descripcion: 'Buy',
    }];
    const netBuys = calculateNetBuys(buy, 'freeform');
    const plan = computeImportPlan({
      dataSource: buy, netBuys, broker: 'freeform',
      existingPositions: [{ id: 'p-btc', asset_id: 'a-btc', entry_price: 68800 }],
      existingAssetsByTicker: { 'BTC-USD': { id: 'a-btc', ticker: 'BTC-USD', current_price: 60000 } },
    });
    expect(plan.positionUpdates[0].row.entry_price).toBe(50000);
  });
});

describe('computeImportPlan — casos de contorno', () => {
  it('ISIN malformado se descarta y queda registrado en skipped', () => {
    const badNet = [{ type: 'BUY', qty: 1, precio: 10, isin: 'ISIN_INVALIDO_XYZ', producto: 'FAKE', moneda: 'EUR' }];
    const plan = computeImportPlan({
      dataSource: [], netBuys: badNet, broker: 'degiro',
      existingPositions: [], existingAssetsByTicker: {},
    });
    expect(plan.assetsToCreate).toHaveLength(0);
    expect(plan.skipped).toEqual([{ isin: 'ISIN_INVALIDO_XYZ', reason: 'malformed-isin' }]);
  });

  it('ISIN con dígito de control no numérico (US037833100A) se salta como el server y el resto sigue', () => {
    // ensure_asset exige /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/: si el planner lo dejara
    // pasar, POST /api/assets daría 'invalid isin' y abortaría el import entero.
    const nets = [
      { type: 'BUY', qty: 1, precio: 10, isin: 'US037833100A', producto: 'BAD', moneda: 'USD' },
      { type: 'BUY', qty: 2, precio: 100, isin: 'US0378331005', producto: 'AAPL', moneda: 'USD' },
    ];
    const rows = [
      { type: 'SELL', fecha: '01-01-2026', cantidad: 1, precio: 5, isin: 'US037833100A', producto: 'BAD2', moneda: 'USD', total: 5 },
    ];
    const plan = computeImportPlan({
      dataSource: rows, netBuys: nets, broker: 'degiro',
      existingPositions: [], existingAssetsByTicker: {},
    });
    expect(plan.skipped).toEqual([{ isin: 'US037833100A', reason: 'malformed-isin' }]);
    expect(plan.assetsToCreate.map(a => a.row.isin)).toEqual(['US0378331005']);
  });

  it('posición duplicada del mismo asset: la no visitada se cierra', () => {
    const { netBuys } = planFresh();
    const asset = { id: 'a-1', ticker: 'US0378331005 (USD)', current_price: 100 };
    const plan = computeImportPlan({
      dataSource: DATA, netBuys, broker: 'degiro',
      existingPositions: [
        { id: 'p-keep', asset_id: 'a-1' },   // first in map wins (reduce overwrites → last actually)
        { id: 'p-dup', asset_id: 'a-1' },
      ],
      existingAssetsByTicker: { 'US0378331005 (USD)': asset },
    });
    // one of the two gets updated, the other closed
    const updated = plan.positionUpdates.map(u => u.positionId);
    expect(updated).toHaveLength(1);
    expect(plan.positionsToClose).toHaveLength(1);
    expect(plan.positionsToClose[0]).not.toBe(updated[0]);
  });

  it('activo comprado y vendido del todo (qty neta 0) recibe posición qty=0 para su historial', () => {
    const soldOut = [
      { type: 'BUY',  fecha: '01-01-2026', hora: '10:00', cantidad: 5, precio: 40, isin: 'NL0010273215', id_activo: 'NL0010273215', producto: 'ASML', moneda: 'EUR', total: -200, descripcion: 'Compra 5 ASML@40 EUR (NL0010273215)' },
      { type: 'SELL', fecha: '02-01-2026', hora: '10:00', cantidad: 5, precio: 50, isin: 'NL0010273215', id_activo: 'NL0010273215', producto: 'ASML', moneda: 'EUR', total: 250,  descripcion: 'Venta 5 ASML@50 EUR (NL0010273215)' },
    ];
    const netBuys = calculateNetBuys(soldOut, 'degiro'); // qty neta 0 → sin fila net para el stock
    expect(netBuys.find(n => n.isin === 'NL0010273215')).toBeUndefined();

    const plan = computeImportPlan({
      dataSource: soldOut, netBuys, broker: 'degiro',
      existingPositions: [], existingAssetsByTicker: {},
    });
    const closedCreate = plan.positionsToCreate.find(p => p.ref === 'NL0010273215 (EUR)');
    expect(closedCreate).toBeDefined();
    expect(closedCreate.row.quantity).toBe(0);
  });
});

describe('buildTransactionRows — fills parciales idénticos (dedupe multiconjunto)', () => {
  // Caso real (Account (4).csv): una orden DeGiro ejecutada en DOS fills de
  // 1 acción al MISMO precio y minuto → dos filas BUY idénticas legítimas.
  // El dedupe por clave única insertaba solo una → coste base a la mitad.
  const FILL = {
    fecha: '07-04-2025', hora: '15:33', type: 'BUY',
    producto: 'Amazon.com Inc', isin: 'US0231351067',
    cantidad: 1, precio: 163, total: -163, totalEUR: 148.97,
    moneda: 'USD', comisiones: 1,
    descripcion: 'Compra 1 Amazon.com Inc@163 USD (US0231351067)',
  };
  const positionIdMap = { 'US0231351067 (USD)': 'pos-amzn' };

  it('primer import: los DOS fills se insertan', () => {
    const { rowsToInsert } = buildTransactionRows({
      dataSource: [FILL, { ...FILL }], broker: 'degiro', positionIdMap, existingTransMap: new Map(),
    });
    expect(rowsToInsert.filter(r => r.transaction_type === 'BUY')).toHaveLength(2);
  });

  it('re-import con ambos fills ya guardados: 0 inserciones, 0 parches', () => {
    const first = buildTransactionRows({
      dataSource: [FILL, { ...FILL }], broker: 'degiro', positionIdMap, existingTransMap: new Map(),
    });
    const stored = first.rowsToInsert.map((r, i) => ({ id: `t-${i}`, ...r }));
    const { rowsToInsert, rowsToPatch } = buildTransactionRows({
      dataSource: [FILL, { ...FILL }], broker: 'degiro', positionIdMap,
      existingTransMap: buildExistingTransMap(stored),
    });
    expect(rowsToInsert).toHaveLength(0);
    expect(rowsToPatch).toHaveLength(0);
  });

  it('re-import con solo UN fill guardado (BD dañada por el bug): inserta el que falta', () => {
    const first = buildTransactionRows({
      dataSource: [FILL], broker: 'degiro', positionIdMap, existingTransMap: new Map(),
    });
    const stored = first.rowsToInsert.map((r, i) => ({ id: `t-${i}`, ...r }));
    const { rowsToInsert } = buildTransactionRows({
      dataSource: [FILL, { ...FILL }], broker: 'degiro', positionIdMap,
      existingTransMap: buildExistingTransMap(stored),
    });
    expect(rowsToInsert).toHaveLength(1);
  });
});

// ─── Fondos MONETARIOS de MyInvestor (2026-10-03) ────────────────────────────
// Un fondo que el enriquecedor no pudo convertir a participaciones se guarda
// como cantidad = euros, precio = 1. Antes compartía fila de `assets` ("NOMBRE
// (EUR)") con el MISMO fondo valorado con participaciones en otro import, y
// heredaba su NAV: 503,04 € × 33,67 = 16.937 € (+3.267 %) en la cuenta del owner.

describe('computeImportPlan — fondos monetarios de MyInvestor', () => {
  const FUND = 'ISHARES US INDEX FUND IE S EUR';
  const monetaryBuy = (fecha, eur) => ({
    type: 'BUY', fecha, hora: '00:00', cantidad: eur, precio: 1, total: -eur,
    isin: '', producto: FUND, nombre: FUND, moneda: 'EUR', comisiones: 0, noQuote: true,
  });
  const DATA_MON = [monetaryBuy('07-07-2026', 338.3), monetaryBuy('03-08-2026', 82.85)];
  // La fila que dejó un import ANTERIOR que sí valoró el fondo con su NAV.
  const navAsset = { id: 'a-nav', ticker: `${FUND} (EUR)`, current_price: 33.67, currency: 'EUR' };

  const plan = () => {
    const netBuys = calculateNetBuys(DATA_MON, 'myinvestor');
    return computeImportPlan({
      dataSource: DATA_MON,
      netBuys,
      broker: 'myinvestor',
      existingPositions: [],
      existingAssetsByTicker: { [navAsset.ticker]: navAsset },
    });
  };

  it('no reutiliza la fila del fondo valorado con NAV: crea un activo monetario propio', () => {
    const p = plan();
    const fundAssets = p.assetsToCreate.filter(a => a.row.company_name === FUND);
    expect(fundAssets).toHaveLength(1);
    expect(fundAssets[0].ref).toBe(`${FUND} [importe] (EUR)`);
    expect(p.assetRpcUpdates.find(u => u.assetId === navAsset.id)).toBeUndefined();
  });

  it('el activo monetario vale 1 por unidad: el valor es lo invertido, no cantidad × NAV', () => {
    const p = plan();
    const fund = p.assetsToCreate.find(a => a.row.company_name === FUND);
    expect(fund.row.current_price).toBe(1);
    const pos = p.positionsToCreate.find(x => x.ref === fund.ref);
    expect(pos.row.quantity).toBeCloseTo(421.15, 2);
    expect(pos.row.entry_price).toBeCloseTo(1, 6);
  });

  it('las operaciones del fondo se enlazan a la posición monetaria', () => {
    const p = plan();
    const { positionIdMap } = applyMentally(p, DATA_MON, 'myinvestor');
    const { rowsToInsert } = buildTransactionRows({
      dataSource: DATA_MON, broker: 'myinvestor', positionIdMap, existingTransMap: new Map(),
    });
    const buys = rowsToInsert.filter(r => r.transaction_type === 'BUY');
    expect(buys).toHaveLength(2);
    expect(new Set(buys.map(r => r.position_id))).toEqual(new Set([positionIdMap[`${FUND} [importe] (EUR)`]]));
  });

  it('reimportar el mismo fichero sobre lo que dejó el primero no planifica nada nuevo', () => {
    const first = plan();
    const { assetsByTicker, positions, existingTrans } = applyMentally(first, DATA_MON, 'myinvestor');
    const fundRef = `${FUND} [importe] (EUR)`;
    const posRows = positions.map(pp => ({
      ...pp,
      quantity: first.positionsToCreate.find(x => `p-${x.ref}` === pp.id).row.quantity,
    }));
    const second = computeImportPlan({
      dataSource: DATA_MON,
      netBuys: calculateNetBuys(DATA_MON, 'myinvestor'),
      broker: 'myinvestor',
      existingPositions: posRows,
      existingAssetsByTicker: { ...assetsByTicker, [navAsset.ticker]: navAsset },
    });
    expect(second.assetsToCreate).toEqual([]);
    expect(second.positionsToCreate).toEqual([]);
    const { rowsToInsert } = buildTransactionRows({
      dataSource: DATA_MON, broker: 'myinvestor',
      positionIdMap: { ...second.refToPositionId },
      existingTransMap: buildExistingTransMap(existingTrans),
    });
    expect(rowsToInsert).toEqual([]);
    expect(second.refToPositionId[fundRef]).toBe(`p-${fundRef}`);
  });

  it('un fondo YA convertido a participaciones sigue usando el ticker de siempre', () => {
    const enriched = { ...monetaryBuy('07-07-2026', 338.3), cantidad: 10.05, precio: 33.66 };
    delete enriched.noQuote;
    const p = computeImportPlan({
      dataSource: [enriched],
      netBuys: calculateNetBuys([enriched], 'myinvestor'),
      broker: 'myinvestor',
      existingPositions: [],
      existingAssetsByTicker: { [navAsset.ticker]: navAsset },
    });
    expect(p.assetsToCreate.find(a => a.row.company_name === FUND)).toBeUndefined();
    // La posición nueva cuelga del asset de siempre. (Hasta el 2026-10-26 esto se
    // comprobaba por la RPC de precio sobre ese asset; el precio ya no lo escribe
    // el cliente y sin metadatos que rellenar no hay RPC.)
    expect(p.positionsToCreate.find(x => x.assetId === navAsset.id)).toBeDefined();
  });
});

describe('computeImportPlan — el mismo fondo en las dos representaciones', () => {
  // Un fondo guardado en euros (`[importe]`) que en el siguiente import se
  // convierte a participaciones cambia de ticker: sin este aviso se crearía
  // una segunda posición y el fondo contaría dos veces.
  const FUND = 'ISHARES US INDEX FUND IE S EUR';
  const base = {
    type: 'BUY', fecha: '07-07-2026', hora: '00:00', isin: '', producto: FUND, nombre: FUND,
    moneda: 'EUR', comisiones: 0,
  };
  const monetary = { ...base, cantidad: 338.3, precio: 1, total: -338.3, noQuote: true };
  const units = { ...base, cantidad: 28.1448, precio: 12.02, total: -338.3 };
  const monAsset = { id: 'a-mon', ticker: `${FUND} [importe] (EUR)`, current_price: 1 };
  const unitAsset = { id: 'a-units', ticker: `${FUND} (EUR)`, current_price: 12.48 };

  const planFor = (row, existingPositions) => computeImportPlan({
    dataSource: [row],
    netBuys: calculateNetBuys([row], 'myinvestor'),
    broker: 'myinvestor',
    existingPositions,
    existingAssetsByTicker: { [monAsset.ticker]: monAsset, [unitAsset.ticker]: unitAsset },
  });

  it('euros → participaciones con la posición en euros abierta: conflicto', () => {
    const p = planFor(units, [{ id: 'p-mon', asset_id: 'a-mon', quantity: 338.3 }]);
    expect(p.representationConflicts).toEqual([
      { name: FUND, ref: unitAsset.ticker, twinRef: monAsset.ticker },
    ]);
  });

  it('participaciones → euros con la posición en participaciones abierta: conflicto', () => {
    const p = planFor(monetary, [{ id: 'p-units', asset_id: 'a-units', quantity: 28.14 }]);
    expect(p.representationConflicts).toHaveLength(1);
    expect(p.representationConflicts[0].twinRef).toBe(unitAsset.ticker);
  });

  it('la misma representación de siempre no es conflicto (resincronizar normal)', () => {
    const p = planFor(units, [{ id: 'p-units', asset_id: 'a-units', quantity: 28.14 }]);
    expect(p.representationConflicts).toEqual([]);
  });

  it('una posición gemela ya cerrada (cantidad 0) no es conflicto', () => {
    const p = planFor(units, [{ id: 'p-mon', asset_id: 'a-mon', quantity: 0 }]);
    expect(p.representationConflicts).toEqual([]);
  });

  it('con el modo reemplazo (sin posiciones previas) no hay conflicto', () => {
    expect(planFor(units, []).representationConflicts).toEqual([]);
  });

  it('otros brokers nunca tienen gemelo', () => {
    const p = computeImportPlan({
      dataSource: [BUY], netBuys: calculateNetBuys([BUY], 'degiro'), broker: 'degiro',
      existingPositions: [], existingAssetsByTicker: {},
    });
    expect(p.representationConflicts).toEqual([]);
  });
});
