import { describe, it, expect, vi } from 'vitest';
import {
  computeHistoryTotals,
  txCurrencyOf,
  scaleOpenCostToHeldQty,
  computeInvestedHybrid,
  computePositionsFingerprint,
} from './portfolioHistory';

// DB-shaped transaction row (as returned by transactions.select with positions/assets join)
const tx = (over = {}) => ({
  transaction_type: 'BUY',
  quantity: 10,
  price: 100,
  total_amount: 1000,
  transaction_date: '2024-01-10T10:00:00',
  notes: null,
  eur_total: null,
  commission: null,
  transaction_currency: null,
  positions: { broker_id: 'b1', assets: { ticker: 'MSFT', isin: 'US5949181045', currency: 'USD' } },
  ...over,
});

// Offline deps: spot rates from a fixed map, historical rates from a fixed map
const makeDeps = (spot = {}, hist = {}) => ({
  getExchangeRate: vi.fn(async (from) => spot[from] ?? 1),
  getHistoricalRate: vi.fn(async (from, _to, date) => hist[`${from}|${date}`] ?? null),
});

describe('computeHistoryTotals', () => {
  it('returns zeroed totals for empty input', async () => {
    const totals = await computeHistoryTotals([], 'EUR', {}, makeDeps());
    expect(totals).toMatchObject({
      realized: 0, dividends: 0, fees: 0, totalBuyCost: 0,
      openPositionCost: 0, tradeCommissions: 0, firstTransactionDate: null,
    });
  });

  it('uses eur_total as authoritative BUY cost when preferred currency is EUR', async () => {
    const totals = await computeHistoryTotals(
      [tx({ eur_total: 920 })], 'EUR', { USD: 0.9, EUR: 1 }, makeDeps()
    );
    expect(totals.totalBuyCost).toBeCloseTo(920, 10);
    expect(totals.openPositionCost).toBeCloseTo(920, 10);
  });

  it('converts foreign-currency BUYs with the historical rate of the trade date', async () => {
    const deps = makeDeps({}, { 'USD|2024-01-10': 0.85 });
    const totals = await computeHistoryTotals(
      [tx()], 'EUR', { USD: 0.9, EUR: 1 }, deps
    );
    // 10 × 100 × 0.85 historical — NOT 0.9 current
    expect(totals.totalBuyCost).toBeCloseTo(850, 10);
    expect(totals.openPositionCost).toBeCloseTo(850, 10);
    expect(deps.getHistoricalRate).toHaveBeenCalledWith('USD', 'EUR', '2024-01-10');
  });

  it('approximates lots without historical rate at the CURRENT rate (complete cost basis)', async () => {
    // The old sentinel-0 design excluded these lots from openPositionCost, pairing a
    // partial cost with the full market value in latentGain — wildly inflated gains.
    const totals = await computeHistoryTotals(
      [tx()], 'EUR', { USD: 0.9, EUR: 1 }, makeDeps() // no historical rate available
    );
    expect(totals.totalBuyCost).toBeCloseTo(900, 10);     // current-rate approximation
    expect(totals.openPositionCost).toBeCloseTo(900, 10); // included, NOT excluded
  });

  it('consumes FIFO lots proportionally on SELL and realizes profit at current rate', async () => {
    const deps = makeDeps({}, { 'USD|2024-01-10': 0.85 });
    const totals = await computeHistoryTotals([
      tx(),
      tx({ transaction_type: 'SELL', quantity: 5, price: 120, transaction_date: '2024-02-10T10:00:00' }),
    ], 'EUR', { USD: 0.9, EUR: 1 }, deps);
    // profit native = 5 × (120 − 100) = 100 → × current 0.9
    expect(totals.realized).toBeCloseTo(90, 10);
    // open cost = remaining 5/10 of the 850 historical lot
    expect(totals.openPositionCost).toBeCloseTo(425, 10);
  });

  it('prefers the transaction_currency column over parsing notes', async () => {
    const totals = await computeHistoryTotals([
      // Notes claim USD but the column says the trade executed in EUR → no conversion
      tx({ transaction_currency: 'EUR', notes: 'Compra 10 MSFT @100,00 USD (US5949181045)' }),
    ], 'EUR', { USD: 0.9, EUR: 1 }, makeDeps());
    expect(totals.totalBuyCost).toBeCloseTo(1000, 10); // 10 × 100, already EUR
  });

  it('falls back to notes parsing for rows imported before the column existed', () => {
    expect(txCurrencyOf({ notes: 'Compra 10 MSFT @360,65 USD (US5949181045)' }, 'EUR')).toBe('USD');
    expect(txCurrencyOf({ notes: 'Compra Directa (EUR)' }, 'USD')).toBe('EUR');
    expect(txCurrencyOf({ transaction_currency: 'GBP', notes: 'Compra Directa (EUR)' }, 'USD')).toBe('GBP');
    expect(txCurrencyOf({ notes: 'sin formato' }, 'CHF')).toBe('CHF');
  });

  it('skips BUYs whose notes reference a different ISIN (wrong linkage)', async () => {
    const totals = await computeHistoryTotals([
      tx({ notes: 'Compra 10 AAPL @100,00 USD (US0378331005)' }), // ≠ position ISIN
    ], 'EUR', { USD: 0.9, EUR: 1 }, makeDeps());
    expect(totals.totalBuyCost).toBe(0);
    expect(totals.openPositionCost).toBe(0);
  });

  it('accumulates dividends and fees at the asset current rate (legacy rows without column)', async () => {
    const totals = await computeHistoryTotals([
      tx({ transaction_type: 'DIVIDEND', quantity: 0, price: 0, total_amount: 50 }),
      tx({ transaction_type: 'FEE', quantity: 0, price: 0, total_amount: -3 }),
    ], 'EUR', { USD: 0.9, EUR: 1 }, makeDeps());
    expect(totals.dividends).toBeCloseTo(45, 10);
    expect(totals.fees).toBeCloseTo(2.7, 10);
  });

  it('converts dividends/fees with transaction_currency when present (F3: IBKR settles in EUR)', async () => {
    // USD asset, but IBKR pays the dividend ALREADY in EUR → must count 1:1,
    // not × the USD rate (which under-counted IBKR dividends by the FX spread).
    const totals = await computeHistoryTotals([
      tx({ transaction_type: 'DIVIDEND', quantity: 0, price: 0, total_amount: 50, transaction_currency: 'EUR' }),
      tx({ transaction_type: 'FEES', quantity: 0, price: 0, total_amount: -3, transaction_currency: 'EUR' }),
    ], 'EUR', { USD: 0.9, EUR: 1 }, makeDeps());
    expect(totals.dividends).toBeCloseTo(50, 10); // NOT 45
    expect(totals.fees).toBeCloseTo(3, 10);       // NOT 2.7
  });

  it('sums the commission column per broker converted with the EUR rate', async () => {
    const totals = await computeHistoryTotals([
      tx({ commission: 2, eur_total: 900 }),
      tx({ commission: 3, eur_total: 900, positions: { broker_id: 'b2', assets: { ticker: 'SAP', isin: 'DE0007164600', currency: 'EUR' } } }),
    ], 'USD', { USD: 1, EUR: 1.1 }, makeDeps({ EUR: 1.1 }));
    expect(totals.tradeCommissions).toBeCloseTo(5.5, 10); // (2+3) × 1.1
    expect(totals.tradeCommissionsByBroker.b1).toBeCloseTo(2.2, 10);
    expect(totals.tradeCommissionsByBroker.b2).toBeCloseTo(3.3, 10);
  });

  it('fetches missing spot rates (including EUR) through deps', async () => {
    const deps = makeDeps({ USD: 0.9, EUR: 1 });
    await computeHistoryTotals([tx({ eur_total: 900 })], 'EUR', {}, deps);
    const requested = deps.getExchangeRate.mock.calls.map(c => c[0]).sort();
    expect(requested).toEqual(['EUR', 'USD']);
  });

  it('accumulates per-asset all-time buy totals, approximating lots without historical rate', async () => {
    const deps = makeDeps({}, { 'USD|2024-01-10': 0.85 });
    const totals = await computeHistoryTotals([
      tx(),                                                       // 10 × 100 × 0.85 = 850 (historical)
      tx({ transaction_date: '2024-03-15T10:00:00', quantity: 4 }), // no hist rate → 4 × 100 × 0.9 = 360 (current-rate approx)
    ], 'EUR', { USD: 0.9, EUR: 1 }, deps);
    const key = 'US5949181045_USD';
    expect(totals.buyTotalsByAsset[key].totalHistCost).toBeCloseTo(1210, 10);
    expect(totals.buyTotalsByAsset[key].totalBoughtQty).toBeCloseTo(14, 10);
  });

  it('also keys buy totals by position_id (authoritative join for merged rows)', async () => {
    const deps = makeDeps({}, { 'USD|2024-01-10': 0.85 });
    const totals = await computeHistoryTotals([
      tx({ position_id: 'pos-a' }),
      tx({ position_id: 'pos-b', eur_total: 500 }),
    ], 'EUR', { USD: 0.9, EUR: 1 }, deps);
    expect(totals.buyTotalsByPosition['pos-a'].totalHistCost).toBeCloseTo(850, 10);
    expect(totals.buyTotalsByPosition['pos-b'].totalHistCost).toBeCloseTo(500, 10);
    expect(totals.buyTotalsByPosition['pos-b'].totalBoughtQty).toBeCloseTo(10, 10);
  });

  it('reports the earliest transaction date across all types', async () => {
    const totals = await computeHistoryTotals([
      tx({ transaction_date: '2024-05-01T00:00:00' }),
      tx({ transaction_type: 'DIVIDEND', transaction_date: '2023-11-20T00:00:00', total_amount: 10 }),
    ], 'EUR', { USD: 0.9, EUR: 1 }, makeDeps());
    expect(totals.firstTransactionDate).toBe('2023-11-20');
  });
});

describe('scaleOpenCostToHeldQty — coste FIFO parcial vs cantidad real en cartera', () => {
  it('REGRESIÓN (Amazon de Enric): 1 fill guardado de 2 → el coste escala al doble y el FX deja de inflarse', async () => {
    // Estado dañado por el dedupe antiguo: posición qty 2 @ $163, pero la tabla
    // transactions solo tiene UNO de los dos fills idénticos (eur_total 148.97).
    const totals = await computeHistoryTotals([
      tx({ quantity: 1, price: 163, eur_total: 148.97, positions: { broker_id: 'b1', assets: { ticker: 'AMZN', isin: 'US0231351067', currency: 'USD' } } }),
    ], 'EUR', { USD: 0.8748, EUR: 1 }, makeDeps());

    const metrics = totals.perAssetMetrics['US0231351067_USD'];
    expect(metrics.openQty).toBeCloseTo(1, 10);
    expect(metrics.openPrefCost).toBeCloseTo(148.97, 2);

    // La posición tiene 2 acciones — el coste debe cubrirlas TODAS.
    const scaled = scaleOpenCostToHeldQty(metrics.openPrefCost, metrics.openQty, 2);
    expect(scaled).toBeCloseTo(297.94, 2);

    // Identidad del desglose con precio actual $243.62 y spot 0.8748:
    const valConverted = 2 * 243.62 * 0.8748;          // ≈ 426.24 €
    const gpPotencial = valConverted - scaled;          // con el bug era +277.27 €
    const gpProducto = 2 * (243.62 - 163) * 0.8748;    // ≈ 141.06 €
    const gpMoneda = gpPotencial - gpProducto;
    expect(gpPotencial).toBeCloseTo(128.33, 1);
    // El USD se depreció desde la compra (0.9139 → 0.8748): FX ligeramente NEGATIVO,
    // nunca el falso +136 € que absorbía el coste desaparecido.
    expect(gpMoneda).toBeLessThan(0);
    expect(gpMoneda).toBeGreaterThan(-20);
  });

  it('no reescala cuando las cantidades coinciden (tolerancia relativa a deriva float)', () => {
    expect(scaleOpenCostToHeldQty(850, 10, 10)).toBe(850);
    expect(scaleOpenCostToHeldQty(850, 10.000001, 10)).toBe(850);
    expect(scaleOpenCostToHeldQty(850, 9.9999, 10)).toBe(850);
  });

  it('escala hacia abajo cuando FIFO cubre MÁS cantidad de la que hay en cartera', () => {
    expect(scaleOpenCostToHeldQty(900, 3, 2)).toBeCloseTo(600, 10);
  });

  it('devuelve el coste intacto en los casos degenerados (sin lotes, sin cantidad)', () => {
    expect(scaleOpenCostToHeldQty(0, 0, 2)).toBe(0);
    expect(scaleOpenCostToHeldQty(500, 0, 2)).toBe(500);
    expect(scaleOpenCostToHeldQty(500, 1, 0)).toBe(500);
  });
});

// DB-shaped position row (as returned by positions.select('*, assets(*)'))
const pos = (over = {}) => ({
  id: 'p1',
  quantity: 10,
  entry_price: 100,
  assets: { ticker: 'MSFT', isin: 'US5949181045', currency: 'USD', asset_class: 'Stock' },
  ...over,
});

describe('computeInvestedHybrid', () => {
  it('usa el coste FIFO de la cola cuando la historia está en la tabla de transacciones', () => {
    const history = {
      perAssetMetrics: { US5949181045_USD: { openPrefCost: 850, openQty: 10 } },
      buyTotalsByPosition: {},
      buyTotalsByAsset: {},
    };
    expect(computeInvestedHybrid([pos()], history, { USD: 0.9 })).toBeCloseTo(850, 10);
  });

  it('reconcilia el coste FIFO a la cantidad en cartera (historias dañadas)', () => {
    // FIFO solo cubre 1 acción de las 2 en cartera → coste escalado ×2 (AVCO),
    // nunca coste parcial contra valor completo (el bug del +186% de Amazon).
    const history = {
      perAssetMetrics: { US5949181045_USD: { openPrefCost: 150, openQty: 1 } },
      buyTotalsByPosition: {},
      buyTotalsByAsset: {},
    };
    expect(computeInvestedHybrid([pos({ quantity: 2 })], history, {})).toBeCloseTo(300, 10);
  });

  it('consume cada cola FIFO UNA vez para el mismo activo en varios brokers', () => {
    const history = {
      perAssetMetrics: { US5949181045_USD: { openPrefCost: 900, openQty: 10 } },
      buyTotalsByPosition: {},
      buyTotalsByAsset: {},
    };
    const rows = [pos({ id: 'p1', quantity: 6 }), pos({ id: 'p2', quantity: 4 })];
    // 6+4 = 10 = openQty → coste íntegro una sola vez, no 900×2
    expect(computeInvestedHybrid(rows, history, {})).toBeCloseTo(900, 10);
  });

  it('cae a AVCO (buyTotalsByPosition) cuando no hay cola FIFO abierta', () => {
    const history = {
      perAssetMetrics: {},
      buyTotalsByPosition: { p1: { totalHistCost: 2000, totalBoughtQty: 20 } },
      buyTotalsByAsset: {},
    };
    // 10 en cartera de 20 compradas → mitad del coste histórico
    expect(computeInvestedHybrid([pos()], history, {})).toBeCloseTo(1000, 10);
  });

  it('cae a entry_price × qty × rate como último recurso', () => {
    const history = { perAssetMetrics: {}, buyTotalsByPosition: {}, buyTotalsByAsset: {} };
    expect(computeInvestedHybrid([pos()], history, { USD: 0.9 })).toBeCloseTo(10 * 100 * 0.9, 10);
  });

  it('ignora posiciones de cash y posiciones cerradas (qty 0)', () => {
    const history = { perAssetMetrics: {}, buyTotalsByPosition: {}, buyTotalsByAsset: {} };
    const rows = [
      pos({ id: 'cash', quantity: 5000, entry_price: 1, assets: { ticker: 'CASH_EUR', currency: 'EUR', asset_class: 'Cash' } }),
      pos({ id: 'closed', quantity: 0 }),
      pos({ id: 'open', quantity: 1, entry_price: 50, assets: { ticker: 'SAN', isin: 'ES0113900J37', currency: 'EUR' } }),
    ];
    expect(computeInvestedHybrid(rows, history, { EUR: 1 })).toBeCloseTo(50, 10);
  });
});

describe('computePositionsFingerprint', () => {
  it('es independiente del orden de las filas', () => {
    const a = [pos({ id: 'p1' }), pos({ id: 'p2', quantity: 3 })];
    const b = [pos({ id: 'p2', quantity: 3 }), pos({ id: 'p1' })];
    expect(computePositionsFingerprint(a)).toBe(computePositionsFingerprint(b));
  });

  it('cambia cuando cambia quantity o entry_price (mutaciones sin transacción)', () => {
    const base = computePositionsFingerprint([pos()]);
    expect(computePositionsFingerprint([pos({ quantity: 11 })])).not.toBe(base);
    expect(computePositionsFingerprint([pos({ entry_price: 101 })])).not.toBe(base);
    expect(computePositionsFingerprint([pos(), pos({ id: 'p2' })])).not.toBe(base);
  });

  it('es estable para listas vacías', () => {
    expect(computePositionsFingerprint([])).toBe(computePositionsFingerprint([]));
    expect(computePositionsFingerprint([])).toMatch(/^0-/);
  });
});

describe('realizedSales — el detalle por venta que alimenta la cartera compartida', () => {
  it('devuelve [] cuando no hay ventas', async () => {
    const totals = await computeHistoryTotals([tx()], 'EUR', { USD: 0.9, EUR: 1 }, makeDeps());
    expect(totals.realizedSales).toEqual([]);
  });

  it('INVARIANTE: la suma de profitPref es exactamente `realized`', async () => {
    const txs = [
      tx({ quantity: 10, price: 100, transaction_date: '2024-01-10T10:00:00' }),
      tx({ transaction_type: 'SELL', quantity: 4, price: 150, transaction_date: '2024-03-01T10:00:00' }),
      tx({ transaction_type: 'SELL', quantity: 3, price: 90,  transaction_date: '2024-04-01T10:00:00' }),
    ];
    const totals = await computeHistoryTotals(txs, 'EUR', { USD: 0.9, EUR: 1 }, makeDeps());
    const suma = totals.realizedSales.reduce((s, v) => s + v.profitPref, 0);
    expect(totals.realizedSales).toHaveLength(2);
    expect(suma).toBeCloseTo(totals.realized, 10);
  });

  it('una venta con ganancia y otra con pérdida conservan su signo por separado', async () => {
    const txs = [
      tx({ quantity: 10, price: 100, transaction_date: '2024-01-10T10:00:00' }),
      tx({ transaction_type: 'SELL', quantity: 4, price: 150, transaction_date: '2024-03-01T10:00:00' }),
      tx({ transaction_type: 'SELL', quantity: 3, price: 90,  transaction_date: '2024-04-01T10:00:00' }),
    ];
    const { realizedSales } = await computeHistoryTotals(txs, 'EUR', { USD: 0.9, EUR: 1 }, makeDeps());
    expect(realizedSales[0].profit).toBeGreaterThan(0);  // vendida a 150 con coste 100
    expect(realizedSales[1].profit).toBeLessThan(0);     // vendida a 90
  });

  it('lleva ticker, fecha, cantidad, precio y coste medio de cada venta', async () => {
    const txs = [
      tx({ quantity: 10, price: 100, transaction_date: '2024-01-10T10:00:00' }),
      tx({ transaction_type: 'SELL', quantity: 4, price: 150, transaction_date: '2024-03-01T10:00:00' }),
    ];
    const { realizedSales } = await computeHistoryTotals(txs, 'EUR', { USD: 0.9, EUR: 1 }, makeDeps());
    expect(realizedSales[0]).toMatchObject({
      date: '2024-03-01', ticker: 'MSFT', currency: 'USD', quantity: 4, price: 150, avgBuyPrice: 100,
    });
  });

  it('convierte profitPref con el rate de la divisa del activo, no 1:1', async () => {
    const txs = [
      tx({ quantity: 10, price: 100, transaction_date: '2024-01-10T10:00:00' }),
      tx({ transaction_type: 'SELL', quantity: 4, price: 150, transaction_date: '2024-03-01T10:00:00' }),
    ];
    const { realizedSales } = await computeHistoryTotals(txs, 'EUR', { USD: 0.9, EUR: 1 }, makeDeps());
    // 4 × (150 − 100) = 200 USD → 180 EUR al rate 0,9
    expect(realizedSales[0].profit).toBeCloseTo(200, 10);
    expect(realizedSales[0].profitPref).toBeCloseTo(180, 10);
  });

  it('marca isMissingBuyData cuando se vende sin compra previa registrada', async () => {
    const txs = [tx({ transaction_type: 'SELL', quantity: 5, price: 150, transaction_date: '2024-03-01T10:00:00' })];
    const { realizedSales } = await computeHistoryTotals(txs, 'EUR', { USD: 0.9, EUR: 1 }, makeDeps());
    expect(realizedSales).toHaveLength(1);
    expect(realizedSales[0].isMissingBuyData).toBe(true);
  });
});
