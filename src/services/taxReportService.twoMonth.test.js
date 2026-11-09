import { describe, it, expect } from 'vitest';
import { buildTaxReport, taxReportToCsv } from './taxReportService';
import { computeProcessedImportData } from './import/processedImportData';
import { collectFxNeeds } from './tax/fxByDate';
import { computeCapitalGains } from './publicTools/capitalGains';

// Informe fiscal + regla de los dos meses (art. 33.5.f LIRPF) con el núcleo
// compartido tax/twoMonthRule. Los datos pasan por el pipeline REAL de la
// pantalla (computeProcessedImportData) y el informe recibe sus `buys`.

const ISIN = 'ES0000000001';
const tx = (type, fecha, cantidad, precio, over = {}) => ({
  type, fecha, hora: '10:00', cantidad, precio,
  total: type === 'BUY' ? -cantidad * precio : cantidad * precio,
  producto: 'ACME', nombre: 'Acme', isin: ISIN, moneda: 'EUR', comisiones: 0,
  ...over,
});
const B = (fecha, q, p, over) => tx('BUY', fecha, q, p, over);
const S = (fecha, q, p, over) => tx('SELL', fecha, q, p, over);

const pipeline = (txs) => computeProcessedImportData({ importedTransactions: txs, dbTransactions: [], exchangeRates: { EUR: 1 } });
const report = (txs, opts = {}) => {
  const pd = pipeline(txs);
  return buildTaxReport({
    sales: pd.salesWithPL, buys: pd.buys, dividends: pd.dividends, commissions: pd.commissions,
    preferredCurrency: 'EUR', ...opts,
  });
};
const okSales = (y) => y.sales.filter((s) => s.status === 'ok');

describe('informe fiscal — regla de los dos meses (casos AEAT)', () => {
  it('pérdida con recompra en los dos meses POSTERIORES: se aplaza entera y no computa', () => {
    const r = report([B('10-01-2025', 10, 100), S('01-03-2025', 10, 80), B('15-04-2025', 10, 85)]);
    expect(r.twoMonthRuleApplied).toBe(true);
    const y = r.byYear['2025'];
    const [s] = okSales(y);
    expect(s.gain).toBeCloseTo(-200, 9);
    expect(s.deferred).toBeCloseTo(200, 9);
    expect(s.computable).toBeCloseTo(0, 9);
    expect(s.blockedBy).toEqual([expect.objectContaining({ fecha: '15-04-2025', qty: 10 })]);
    // Los totales usan lo computable, no la pérdida bruta.
    expect(y.losses).toBeCloseTo(0, 9);
    expect(y.deferred).toBeCloseTo(200, 9);
    expect(y.net).toBeCloseTo(0, 9);
    expect(y.stillDeferred).toBeCloseTo(200, 9);
  });

  it('pérdida con recompra en los dos meses ANTERIORES que sigue en cartera: se aplaza', () => {
    const r = report([B('01-01-2025', 10, 100), B('01-04-2025', 10, 90), S('01-05-2025', 10, 80)]);
    const [s] = okSales(r.byYear['2025']);
    expect(s.gain).toBeCloseTo(-200, 9);
    expect(s.deferred).toBeCloseTo(200, 9);
    expect(r.byYear['2025'].net).toBeCloseTo(0, 9);
  });

  it('recompra parcial: solo se aplaza la parte proporcional', () => {
    const r = report([B('01-01-2025', 1000, 10), S('01-06-2025', 1000, 8), B('20-06-2025', 300, 8)]);
    const y = r.byYear['2025'];
    expect(okSales(y)[0].deferred).toBeCloseTo(600, 9);
    expect(y.losses).toBeCloseTo(-1400, 9);
    expect(y.net).toBeCloseTo(-1400, 9);
    expect(y.stillDeferred).toBeCloseTo(600, 9);
  });

  it('se libera al vender las de reposición de forma DEFINITIVA', () => {
    const r = report([
      B('10-01-2025', 10, 100), S('01-03-2025', 10, 80), B('15-04-2025', 10, 85),
      S('01-02-2026', 10, 90),
    ]);
    const y26 = r.byYear['2026'];
    expect(okSales(y26)[0].released).toBeCloseTo(200, 9);
    expect(okSales(y26)[0].computable).toBeCloseTo(-150, 9);
    expect(y26.gains).toBeCloseTo(50, 9);
    expect(y26.released).toBeCloseTo(200, 9);
    expect(y26.net).toBeCloseTo(-150, 9);
    expect(y26.stillDeferred).toBeCloseTo(0, 9);
    expect(r.pendingDeferred).toEqual([]);
  });

  it('venta NO definitiva de las de reposición (vuelve a comprar): no libera, la pérdida sigue aplazada', () => {
    const r = report([
      B('10-01-2025', 100, 50), S('15-03-2025', 100, 40), B('02-04-2025', 100, 41),
      S('10-12-2025', 100, 45), B('15-01-2026', 100, 44),
    ]);
    const y = r.byYear['2025'];
    expect(okSales(y)[1].released).toBeCloseTo(0, 9);
    expect(y.net).toBeCloseTo(400, 9);
    expect(y.stillDeferred).toBeCloseTo(1000, 9);
    expect(r.pendingDeferred).toHaveLength(1);
    expect(r.pendingDeferred[0]).toMatchObject({ fecha: '15-01-2026', isin: ISIN, nombre: 'Acme', remainingQty: 100 });
    expect(r.pendingDeferred[0].deferredAmount).toBeCloseTo(1000, 9);
  });

  // Mismos números que capitalGains.test.js (sin comisiones).
  it('caso E por el informe', () => {
    const r = report([
      B('10-01-2025', 100, 50), S('15-03-2025', 100, 40), B('02-04-2025', 100, 41),
      B('01-11-2025', 100, 44), S('10-12-2025', 150, 45),
    ]);
    const y = r.byYear['2025'];
    const s2 = okSales(y)[1];
    expect(s2.gain).toBeCloseTo(450, 9);
    expect(s2.released).toBeCloseTo(500, 9);
    expect(s2.computable).toBeCloseTo(-50, 9);
    expect(y.net).toBeCloseTo(-50, 9);
    expect(y.stillDeferred).toBeCloseTo(500, 9);
  });

  it('caso G por el informe', () => {
    const r = report([
      B('10-01-2025', 100, 50), S('15-03-2025', 100, 40), B('02-04-2025', 100, 41),
      S('10-12-2025', 100, 39), B('15-01-2026', 100, 38), S('01-06-2026', 100, 39),
    ]);
    const s2 = okSales(r.byYear['2025'])[1];
    expect(s2.gain).toBeCloseTo(-200, 9);
    expect(s2.deferred).toBeCloseTo(200, 9);
    expect(s2.released).toBeCloseTo(0, 9);
    expect(okSales(r.byYear['2026'])[0].released).toBeCloseTo(1200, 9);
    expect(r.byYear['2025'].net).toBeCloseTo(0, 9);
    expect(r.byYear['2026'].net).toBeCloseTo(-1100, 9);
    expect(r.byYear['2026'].stillDeferred).toBeCloseTo(0, 9);
  });

  it('caso H por el informe', () => {
    const r = report([
      B('10-01-2025', 5, 50), S('01-02-2025', 5, 40), B('01-03-2025', 10, 41),
      S('01-04-2025', 5, 39), S('01-03-2026', 5, 45),
    ]);
    expect(r.byYear['2025'].net).toBeCloseTo(0, 9);
    expect(r.byYear['2026'].net).toBeCloseTo(-40, 9);
    expect(okSales(r.byYear['2026'])[0].released).toBeCloseTo(60, 9);
    expect(r.byYear['2026'].stillDeferred).toBeCloseTo(0, 9);
  });
});

describe('informe fiscal — ventana de dos meses', () => {
  // 31-mar + 2 meses = 31-may (día incluido); 1-jun ya está fuera.
  it('el día límite está dentro', () => {
    const r = report([B('01-01-2025', 10, 100), S('31-03-2025', 10, 80), B('31-05-2025', 10, 80)]);
    expect(okSales(r.byYear['2025'])[0].deferred).toBeCloseTo(200, 9);
  });

  it('el día siguiente al límite está fuera', () => {
    const r = report([B('01-01-2025', 10, 100), S('31-03-2025', 10, 80), B('01-06-2025', 10, 80)]);
    expect(okSales(r.byYear['2025'])[0].deferred).toBe(0);
    expect(r.byYear['2025'].net).toBeCloseTo(-200, 9);
  });

  it('una recompra a mes y medio bloquea (la ventana es de dos meses, no de uno)', () => {
    const r = report([B('01-01-2025', 10, 100), S('01-03-2025', 10, 80), B('15-04-2025', 10, 80)]);
    expect(okSales(r.byYear['2025'])[0].deferred).toBeCloseTo(200, 9);
  });

  it('en el límite anterior también: 2 meses antes incluido, si sigue en cartera', () => {
    const r = report([B('01-01-2025', 10, 100), B('31-03-2025', 10, 90), S('31-05-2025', 10, 80)]);
    expect(okSales(r.byYear['2025'])[0].deferred).toBeCloseTo(200, 9);
  });
});

describe('informe fiscal — homogéneos por ISIN', () => {
  it('mismo ISIN con nombres distintos = homogéneos', () => {
    const r = report([
      B('01-01-2025', 10, 100, { nombre: 'Acme Corp', producto: 'ACME CORP' }),
      S('01-03-2025', 10, 80, { nombre: 'Acme Corp', producto: 'ACME CORP' }),
      B('15-03-2025', 10, 80, { nombre: 'ACME CORPORATION SA', producto: 'ACME CORPORATION SA' }),
    ]);
    expect(okSales(r.byYear['2025'])[0].deferred).toBeCloseTo(200, 9);
    expect(r.byYear['2025'].noIsinCount).toBe(0);
  });

  it('mismo nombre con ISIN distinto = NO homogéneos', () => {
    const r = report([
      B('01-01-2025', 10, 100), S('01-03-2025', 10, 80),
      B('15-03-2025', 10, 80, { isin: 'ES0000000002' }),
    ]);
    expect(okSales(r.byYear['2025'])[0].deferred).toBe(0);
    expect(r.byYear['2025'].net).toBeCloseTo(-200, 9);
  });

  it('sin ISIN: agrupa por nombre normalizado y lo avisa (noIsinCount + CSV)', () => {
    const noIsin = (nombre) => ({ isin: '', nombre, producto: nombre });
    const r = report([
      B('01-01-2025', 10, 100, noIsin('Acme  Corp')),
      S('01-03-2025', 10, 80, noIsin('Acme  Corp')),
      B('15-03-2025', 10, 80, noIsin(' acme corp ')),
    ]);
    const y = r.byYear['2025'];
    expect(okSales(y)[0].deferred).toBeCloseTo(200, 9);
    expect(y.noIsinCount).toBe(3);
    const csv = taxReportToCsv(y, '2025', { noIsinNote: 'Sin ISIN: por nombre' });
    expect(csv).toContain('Sin ISIN: por nombre;3');
  });
});

describe('informe fiscal — arrastre entre años', () => {
  it('pérdida aplazada en diciembre y liberada en enero computa en el año nuevo', () => {
    const r = report([
      B('01-06-2025', 10, 100), S('10-12-2025', 10, 80), B('20-12-2025', 10, 82),
      S('15-01-2026', 10, 85),
    ]);
    const y25 = r.byYear['2025'];
    const y26 = r.byYear['2026'];
    expect(y25.losses).toBeCloseTo(0, 9);
    expect(y25.deferred).toBeCloseTo(200, 9);
    expect(y25.net).toBeCloseTo(0, 9);
    expect(y25.stillDeferred).toBeCloseTo(200, 9);
    expect(y26.released).toBeCloseTo(200, 9);
    expect(y26.gains).toBeCloseTo(30, 9);
    expect(y26.net).toBeCloseTo(-170, 9);
    expect(y26.stillDeferred).toBeCloseTo(0, 9);
  });
});

describe('informe fiscal — divisas y datos incompletos con la regla', () => {
  const usd = { moneda: 'USD' };

  it('compras y ventas en USD al tipo de SU fecha antes de aplicar la regla', () => {
    const rates = { USD: { '2025-01-10': 0.9, '2025-03-03': 0.95, '2025-03-20': 0.92 } };
    const txs = [B('10-01-2025', 10, 100, usd), S('03-03-2025', 10, 80, usd), B('20-03-2025', 10, 81, usd)];
    const pd = pipeline(txs);
    // collectFxNeeds pide también el tipo de las compras (la de reposición no está en ningún lote)
    expect(collectFxNeeds({ sales: pd.salesWithPL, buys: pd.buys }).map((n) => n.date)).toContain('2025-03-20');
    const r = report(txs, { rates });
    const [s] = okSales(r.byYear['2025']);
    // 800 × 0,95 − 1000 × 0,9 = −140
    expect(s.gain).toBeCloseTo(-140, 9);
    expect(s.deferred).toBeCloseTo(140, 9);
    expect(r.byYear['2025'].net).toBeCloseTo(0, 9);
  });

  it('una recompra sin tipo de cambio sigue bloqueando (solo cuenta su cantidad)', () => {
    const rates = { USD: { '2025-01-10': 0.9, '2025-03-03': 0.95 } };
    const r = report([B('10-01-2025', 10, 100, usd), S('03-03-2025', 10, 80, usd), B('20-03-2025', 10, 81, usd)], { rates });
    expect(okSales(r.byYear['2025'])[0].deferred).toBeCloseTo(140, 9);
  });

  it('una venta sin tipo queda fuera, marcada, y no inventa aplazamientos', () => {
    const rates = { USD: { '2025-01-10': 0.9, '2025-03-20': 0.92 } };
    const r = report([B('10-01-2025', 10, 100, usd), S('03-03-2025', 10, 80, usd), B('20-03-2025', 10, 81, usd)], { rates });
    const y = r.byYear['2025'];
    expect(y.sales[0].status).toBe('missing_fx');
    expect(y.sales[0].profit).toBeNull();
    expect(y.missingFxCount).toBe(1);
    expect(y.deferred).toBe(0);
    expect(y.net).toBe(0);
  });

  // CONTRATO (2026-10-22, revisión F1F2 punto 3): antes una venta con PARTE de
  // las acciones sin compra se excluía ENTERA (escondía pérdidas y ganancias de
  // la parte conocida). Ahora computa la parte conocida y lo que falta sale en
  // `partialHistory` del año (unidades sin coste e importe excluido).
  it('venta con PARTE sin historial: computa las conocidas y lista las que faltan', () => {
    const r = report([B('01-01-2025', 5, 100), S('01-03-2025', 8, 120)]);
    const y = r.byYear['2025'];
    const [s] = y.sales;
    expect(s.status).toBe('partial_history');
    expect(s.missingShares).toBe(3);
    // 960 × 5/8 − 500
    expect(s.profit).toBeCloseTo(100, 9);
    expect(s.proceeds).toBeCloseTo(600, 9);
    expect(s.acquisition).toBeCloseTo(500, 9);
    expect(y.gains).toBeCloseTo(100, 9);
    expect(y.net).toBeCloseTo(100, 9);
    expect(y.unreliableCount).toBe(0);
    expect(y.partialHistory).toEqual([
      expect.objectContaining({ fecha: '01-03-2025', isin: ISIN, missingShares: 3, excludedProceeds: 360 }),
    ]);
  });

  it('caso R8F-3: 9 compradas a 100 y 10 vendidas a 50 → −450 € en los totales, 1 unidad en el aviso', () => {
    const r = report([B('01-01-2025', 9, 100), S('01-03-2025', 10, 50)]);
    const y = r.byYear['2025'];
    expect(y.losses).toBeCloseTo(-450, 9);
    expect(y.net).toBeCloseTo(-450, 9);
    expect(y.proceeds).toBeCloseTo(450, 9);
    expect(y.acquisition).toBeCloseTo(900, 9);
    expect(y.partialHistoryCount).toBe(1);
    expect(y.partialHistory[0]).toMatchObject({ isoDay: '2025-03-01', missingShares: 1, excludedProceeds: 50 });
    const csv = taxReportToCsv(y, '2025', {
      partialHistorySection: 'Unidades sin coste (fuera de los totales)', missingShares: 'Sin coste', excludedProceeds: 'Excluido',
    });
    expect(csv).toContain('Unidades sin coste (fuera de los totales);1');
    expect(csv).toMatch(/01-03-2025;Acme;ES0000000001;1,00;50,00/);
  });

  it('historial parcial con recompra: solo se aplaza la pérdida de las conocidas', () => {
    const r = report([B('01-01-2025', 9, 100), S('01-03-2025', 10, 50), B('01-04-2025', 9, 40)]);
    const y = r.byYear['2025'];
    expect(y.sales[0].deferred).toBeCloseTo(450, 9);
    expect(y.net).toBeCloseTo(0, 9);
  });

  it('historial parcial con comisión de venta: se prorratea también la comisión', () => {
    const r = report([B('01-01-2025', 9, 100), S('01-03-2025', 10, 50, { comisiones: 10 })]);
    const y = r.byYear['2025'];
    // (500 − 10) × 9/10 − 900
    expect(y.net).toBeCloseTo(441 - 900, 9);
    expect(y.partialHistory[0].excludedProceeds).toBeCloseTo(49, 9);
  });

  it('venta con parte sin historial también sin `buys` (sin la regla)', () => {
    const pd = pipeline([B('01-01-2025', 5, 100), S('01-03-2025', 8, 120)]);
    const y = buildTaxReport({ sales: pd.salesWithPL }).byYear['2025'];
    expect(y.sales[0].status).toBe('partial_history');
    expect(y.unreliableCount).toBe(1);
    expect(y.gains).toBe(0);
  });

  // CONTRATO (2026-10-22, revisión F1F2 punto 2): con `buys` el informe ya NO
  // mira el FIFO de la pantalla (cola por ISIN+divisa, fifoAnalytics). Valores
  // homogéneos = mismo ISIN (art. 37.2 LIRPF), sea cual sea el mercado o la
  // divisa. Desaparecen fifoMismatch/profitScreen: el informe y la pantalla
  // pueden diferir con mercados mezclados, a propósito (docs/claude/finance.md).
  it('mismo ISIN comprado en EUR y en USD: un solo FIFO por ISIN, sin marcas de «pantalla»', () => {
    const r = report([
      B('01-01-2025', 10, 100),
      B('02-01-2025', 10, 50, usd),
      S('01-03-2025', 10, 60, usd),
    ], { rates: { USD: { '2025-01-02': 1, '2025-03-01': 1 } } });
    const y = r.byYear['2025'];
    const [s] = y.sales;
    // Consume primero el lote en EUR (el más antiguo del ISIN): 600 − 1000.
    expect(s.status).toBe('ok');
    expect(s.gain).toBeCloseTo(-400, 9);
    expect(s.profit).toBeCloseTo(-400, 9);
    expect(s).not.toHaveProperty('fifoMismatch');
    expect(s).not.toHaveProperty('profitScreen');
    expect(y).not.toHaveProperty('fifoMismatchCount');
    expect(s.lots).toEqual([expect.objectContaining({ date: '01-01-2025', qty: 10, unitCost: 100, rateSource: 'eur' })]);
  });

  it('caso R8F-2: compra en Xetra (EUR) y venta en NYSE (USD) del mismo ISIN → +350 €, no «sin historial»', () => {
    // La pantalla no encuentra lotes (otra cola por divisa): isMissingBuyData.
    // El informe decide con el FIFO por ISIN del núcleo.
    const ie = { isin: 'IE00X0000001', nombre: 'Fondo X', producto: 'FONDO X' };
    const txs = [B('10-01-2025', 10, 100, ie), S('01-03-2025', 10, 150, { ...ie, ...usd })];
    const pd = pipeline(txs);
    expect(pd.salesWithPL[0].isMissingBuyData).toBe(true); // la pantalla, intacta
    const y = report(txs, { rates: { USD: { '2025-03-01': 0.9 } } }).byYear['2025'];
    const [s] = y.sales;
    expect(s.status).toBe('ok');
    expect(s.proceeds).toBeCloseTo(1350, 9);
    expect(s.acquisition).toBeCloseTo(1000, 9);
    expect(s.gain).toBeCloseTo(350, 9);
    expect(y.gains).toBeCloseTo(350, 9);
    expect(y.net).toBeCloseTo(350, 9);
    expect(y.unreliableCount).toBe(0);
  });

  it('venta en USD sin tipo de su fecha aunque la pantalla no tenga lotes: missing_fx, no «sin historial»', () => {
    const ie = { isin: 'IE00X0000001', nombre: 'Fondo X', producto: 'FONDO X' };
    const y = report([B('10-01-2025', 10, 100, ie), S('01-03-2025', 10, 150, { ...ie, ...usd })], { rates: {} }).byYear['2025'];
    expect(y.sales[0].status).toBe('missing_fx');
    expect(y.missingFx[0]).toMatchObject({ kind: 'sale', date: '2025-03-01', reason: 'no_rate' });
    expect(y.unreliableCount).toBe(0);
    expect(y.net).toBe(0);
  });

  it('una compra sin tipo de su fecha deja la venta que la consume en missing_fx con la fecha de ESA compra', () => {
    const y = report([B('10-01-2025', 10, 100, usd), S('01-03-2025', 10, 150, usd)], { rates: { USD: { '2025-03-01': 0.9 } } }).byYear['2025'];
    expect(y.sales[0].status).toBe('missing_fx');
    expect(y.missingFx[0]).toMatchObject({ kind: 'sale', date: '2025-01-10', reason: 'no_rate' });
  });

  it('tolerancia de «sin ninguna compra»: 0,001 acciones compradas ya es historial parcial, no «sin historial»', () => {
    // Fija SHARE_EPS (1e-8): una tolerancia mayor tragaría compras fraccionarias
    // (cripto, fondos) y sacaría la venta entera de los totales.
    const y = report([B('01-01-2025', 0.001, 100), S('01-03-2025', 10, 50)]).byYear['2025'];
    expect(y.sales[0].status).toBe('partial_history');
    expect(y.sales[0].profit).toBeCloseTo(500 * 0.0001 - 0.1, 9);
    expect(y.unreliableCount).toBe(0);
  });

  it('venta sin NINGUNA compra del ISIN: missing_buy_data, fuera de los totales', () => {
    const y = report([S('01-03-2025', 10, 150)]).byYear['2025'];
    expect(y.sales[0].status).toBe('missing_buy_data');
    expect(y.sales[0].profit).toBeNull();
    expect(y.unreliableCount).toBe(1);
    expect(y.net).toBe(0);
  });
});

describe('informe fiscal — comisiones de compraventa dentro de los valores (art. 35 LIRPF)', () => {
  it('compra 10×100 con 5 € y venta 10×110 con 5 € → +90 €, y no van a «fees»', () => {
    const r = report([B('10-01-2025', 10, 100, { comisiones: 5 }), S('10-03-2025', 10, 110, { comisiones: 5 })]);
    const y = r.byYear['2025'];
    const [s] = okSales(y);
    expect(s.proceeds).toBeCloseTo(1095, 9);
    expect(s.acquisition).toBeCloseTo(1005, 9);
    expect(s.gain).toBeCloseTo(90, 9);
    expect(y.net).toBeCloseTo(90, 9);
    expect(y.proceeds).toBeCloseTo(1095, 9);
    expect(y.acquisition).toBeCloseTo(1005, 9);
    expect(y.fees).toBe(0);
  });

  it('venta parcial: la comisión de compra se prorratea por FIFO con el coste unitario del lote', () => {
    const r = report([
      B('10-01-2025', 10, 100, { comisiones: 10 }), // 101 €/acción
      S('10-03-2025', 4, 120, { comisiones: 2 }),   // 480 − 2 − 4×101 = 74
      S('10-04-2025', 6, 90, { comisiones: 3 }),    // 540 − 3 − 6×101 = −69
    ]);
    const [s1, s2] = okSales(r.byYear['2025']);
    expect(s1.gain).toBeCloseTo(74, 9);
    expect(s2.gain).toBeCloseTo(-69, 9);
    expect(s1.lots[0].unitCost).toBeCloseTo(101, 9);
  });

  it('la pérdida aplazada de los dos meses lleva las comisiones dentro', () => {
    const r = report([
      B('10-01-2025', 10, 100, { comisiones: 5 }), S('01-03-2025', 10, 80, { comisiones: 5 }), B('15-04-2025', 10, 85, { comisiones: 5 }),
    ]);
    const y = r.byYear['2025'];
    // 795 − 1005 = −210, aplazada entera
    expect(okSales(y)[0].gain).toBeCloseTo(-210, 9);
    expect(y.deferred).toBeCloseTo(210, 9);
    expect(y.stillDeferred).toBeCloseTo(210, 9);
  });

  it('acción en USD: cada importe a su tipo y la comisión (EUR) al tipo EUR de su fecha', () => {
    const usd = { moneda: 'USD' };
    const rates = { USD: { '2025-01-10': 0.9, '2025-03-10': 0.8 } };
    const y = report([B('10-01-2025', 10, 100, { ...usd, comisiones: 2 }), S('10-03-2025', 10, 120, { ...usd, comisiones: 2 })], { rates }).byYear['2025'];
    // (960 − 2) − (900 + 2)
    expect(y.net).toBeCloseTo(56, 9);
  });

  it('en GBP la comisión EUR necesita el tipo EUR→GBP de su fecha; sin él, la venta queda sin tipo', () => {
    const rates = { EUR: { '2025-01-10': 0.85, '2025-03-10': 0.86 } };
    const y = report([B('10-01-2025', 10, 100, { comisiones: 5 }), S('10-03-2025', 10, 110, { comisiones: 5 })], { rates, preferredCurrency: 'GBP' }).byYear['2025'];
    expect(y.net).toBeCloseTo((1100 - 5) * 0.86 - (1000 + 5) * 0.85, 9);
    const noFeeRate = report([B('10-01-2025', 10, 100, { moneda: 'GBP', comisiones: 5 }), S('10-03-2025', 10, 110, { moneda: 'GBP', comisiones: 5 })], {
      rates: { EUR: { '2025-01-10': 0.85 } }, preferredCurrency: 'GBP',
    }).byYear['2025'];
    expect(noFeeRate.sales[0].status).toBe('missing_fx');
    expect(noFeeRate.missingFx[0]).toMatchObject({ kind: 'sale', date: '2025-03-10' });
    expect(noFeeRate.net).toBe(0);
  });

  it('«fees» solo lleva los gastos no imputables a una operación (custodia, conectividad)', () => {
    const r = report([
      B('10-01-2025', 10, 100, { comisiones: 5 }), S('10-03-2025', 10, 110, { comisiones: 5 }),
      tx('FEE', '31-12-2025', 0, 0, { total: -2.5 }),
    ]);
    expect(r.byYear['2025'].fees).toBeCloseTo(2.5, 9);
  });
});

describe('informe fiscal ↔ calculadora pública: el mismo caso da lo mismo', () => {
  // Una sola definición (regla 1): app y web pública pasan por tax/twoMonthRule
  // con los gastos dentro de los valores.
  const ops = [
    ['buy', '2025-01-10', 100, 50, 3], ['sell', '2025-03-15', 100, 40, 3], ['buy', '2025-04-02', 100, 41, 2],
    ['buy', '2025-11-01', 100, 44, 1.5], ['sell', '2025-12-10', 150, 45, 4], ['sell', '2026-02-20', 50, 47, 1],
    ['buy', '2025-02-01', 10, 100, 5], ['sell', '2025-02-20', 10, 110, 5],
  ];
  const toPipe = ([type, iso, q, p, fee], i) => {
    const [yy, mm, dd] = iso.split('-');
    const isin = i >= 6 ? 'ES0000000009' : ISIN;
    return tx(type === 'buy' ? 'BUY' : 'SELL', `${dd}-${mm}-${yy}`, q, p, { comisiones: fee, isin, producto: isin, nombre: isin });
  };
  const toCalc = ([type, date, qty, price, fee], i) => ({ id: `o${i}`, asset: i >= 6 ? 'ES0000000009' : ISIN, type, date, qty, price, fee });

  it('ganancia, aplazada, integrada y computable por venta, y neto por año', () => {
    const app = report(ops.map(toPipe));
    const calc = computeCapitalGains(ops.map(toCalc));
    const appSales = Object.values(app.byYear).flatMap((y) => okSales(y)).sort((a, b) => a.isoDay.localeCompare(b.isoDay) || a.cantidad - b.cantidad);
    const calcSales = [...calc.sales].sort((a, b) => a.date.localeCompare(b.date) || a.qty - b.qty);
    expect(appSales).toHaveLength(calcSales.length);
    // La calculadora redondea a céntimos al pintar; aquí, el mismo redondeo.
    const r2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
    appSales.forEach((s, i) => {
      expect(r2(s.gain)).toBe(calcSales[i].gain);
      expect(r2(s.deferred)).toBe(calcSales[i].deferred);
      expect(r2(s.released)).toBe(calcSales[i].released);
      expect(r2(s.computable)).toBe(calcSales[i].computable);
      expect(r2(s.proceeds)).toBe(calcSales[i].proceeds);
    });
    for (const cy of calc.years) expect(r2(app.byYear[String(cy.year)].net)).toBe(cy.net);
    expect(Object.values(app.byYear).some((y) => y.deferred > 0)).toBe(true); // el caso ejerce la regla
  });

  it('el caso de la revisión: +90 € en los dos lados', () => {
    const app = report([B('10-01-2025', 10, 100, { comisiones: 5 }), S('10-03-2025', 10, 110, { comisiones: 5 })]);
    const calc = computeCapitalGains([
      { id: 'a', asset: 'X', type: 'buy', date: '2025-01-10', qty: 10, price: 100, fee: 5 },
      { id: 'b', asset: 'X', type: 'sell', date: '2025-03-10', qty: 10, price: 110, fee: 5 },
    ]);
    expect(calc.years[0].net).toBe(90);
    expect(app.byYear['2025'].net).toBeCloseTo(calc.years[0].net, 9);
  });
});

describe('informe fiscal — difiere de la pantalla en las comisiones de compraventa, a propósito', () => {
  // La pantalla (processedImportData) lleva las comisiones aparte; el informe las
  // mete en los valores (art. 35 LIRPF). La diferencia es EXACTAMENTE la suma de
  // las comisiones de las compras y ventas vendidas.
  it('neto del informe = realizado de la pantalla − comisiones imputadas', () => {
    const t = (over) => ({ hora: '10:00', producto: 'SAN', isin: 'ES0113900J37', nombre: 'Santander', moneda: 'EUR', comisiones: 0, ...over });
    const pd = pipeline([
      t({ type: 'BUY', fecha: '10-01-2024', cantidad: 100, precio: 3.137, total: -313.7, comisiones: 2 }),
      t({ type: 'BUY', fecha: '11-02-2024', cantidad: 50, precio: 3.9, total: -195, comisiones: 2 }),
      t({ type: 'SELL', fecha: '15-03-2025', cantidad: 120, precio: 4.41, total: 529.2, comisiones: 2 }),
      t({ type: 'SELL', fecha: '15-04-2025', cantidad: 30, precio: 3.5, total: 105, comisiones: 2 }),
      t({ type: 'BUY', fecha: '01-02-2025', producto: 'ITX', isin: 'ES0148396007', cantidad: 10, precio: 40.33, total: -403.3 }),
      t({ type: 'SELL', fecha: '03-02-2025', producto: 'ITX', isin: 'ES0148396007', cantidad: 10, precio: 38.1, total: 381 }),
    ]);
    const r = buildTaxReport({ sales: pd.salesWithPL, buys: pd.buys, commissions: pd.commissions });
    const all = Object.values(r.byYear);
    const sum = (k) => all.reduce((s, y) => s + y[k], 0);
    // Las 150 acciones compradas se venden: entran las 4 comisiones (8 €).
    expect(sum('net')).toBeCloseTo(pd.totals.salesTotal - 8, 10);
    expect(sum('deferred')).toBe(0);
    // 120×4,41 − 2 − (100×3,137 + 2 + 20×(3,9 + 2/50)) = 132,7 ; 30×3,5 − 2 − 30×3,94 = −15,2 ; −22,3
    expect(r.byYear['2025'].gains).toBeCloseTo(132.7, 10);
    expect(r.byYear['2025'].losses).toBeCloseTo(-37.5, 10);
    // Ya no hay gastos sueltos: las 4 comisiones están dentro de los valores.
    expect(sum('fees')).toBe(0);
  });
});

describe('taxReportToCsv — columnas de la regla', () => {
  it('lleva aplazado, liberado y computable por venta, resumen y pendientes con su compra', () => {
    const r = report([
      B('10-01-2025', 100, 50), S('15-03-2025', 100, 40), B('02-04-2025', 100, 41),
    ]);
    const csv = taxReportToCsv(r.byYear['2025'], '2025', {
      deferred: 'Aplazadas', released: 'Liberadas', computable: 'Computable', stillDeferred: 'Pendientes al cierre',
      pendingSection: 'Pérdidas aplazadas pendientes', pnl: 'G/P',
    }, { pendingDeferred: r.pendingDeferred });
    expect(csv).toContain('Aplazadas;1000,00');
    expect(csv).toContain('Pendientes al cierre;1000,00');
    // venta: … G/P −1000, aplazada 1000, liberada 0, computable 0
    expect(csv).toMatch(/15-03-2025;Acme;ES0000000001;.*;-1000,00;1000,00;0,00;0,00/);
    expect(csv).toContain('Pérdidas aplazadas pendientes;1');
    expect(csv).toMatch(/02-04-2025;Acme;ES0000000001;100,00;100,00;100,00;1000,00/);
  });
});
