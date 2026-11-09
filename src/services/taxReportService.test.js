import { describe, it, expect } from 'vitest';
import { yearOf, buildTaxReport, taxReportToCsv } from './taxReportService';
import { commissionCurrency, computeProcessedImportData } from './import/processedImportData';

// CONTRATO (2026-10-22): buildTaxReport ya no recibe `exchangeRates` (tipos de
// HOY) sino `rates`, la tabla precargada por fecha (tax/fxByDate), y cada venta
// trae sus `lots` FIFO. Los tests de antes conservan sus números: donde usaban
// un tipo de hoy ahora ponen ese mismo tipo en la fecha de cada operación.

const sale = (over = {}) => ({
  fecha: '15-03-2025',
  nombre: 'Microsoft',
  isin: 'US5949181045',
  cantidad: 2,
  precio: 400,
  moneda: 'USD',
  total: 800,
  profit: 100,
  profitPercent: 14.3,
  isMissingBuyData: false,
  lots: [{ date: '10-01-2025', qty: 2, unitCost: 350, fxRate: null }],
  ...over,
});

const div = (over = {}) => ({
  fecha: '10-06-2025',
  nombre: 'Microsoft',
  isin: 'US5949181045',
  moneda: 'USD',
  total: 25,
  ...over,
});

/** Mismo tipo para todas las fechas dadas: { USD: { '2025-01-10': 0.9, … } } */
const flat = (cur, rate, days) => ({ [cur]: Object.fromEntries(days.map(d => [d, rate])) });

describe('yearOf', () => {
  it('soporta los dos formatos de fecha del pipeline', () => {
    expect(yearOf('15-03-2025')).toBe('2025');
    expect(yearOf('2025-03-15')).toBe('2025');
    expect(yearOf('2025-03-15T10:30:00')).toBe('2025');
  });

  it('devuelve null para fechas invalidas', () => {
    expect(yearOf(undefined)).toBe(null);
    expect(yearOf('')).toBe(null);
    expect(yearOf('marzo')).toBe(null);
  });
});

describe('buildTaxReport', () => {
  it('separa ganancias y pérdidas por año fiscal, convertidas a divisa preferida', () => {
    const report = buildTaxReport({
      sales: [
        sale(),                                                     // +100 USD × 0.9 = +90
        sale({ fecha: '20-11-2025', precio: 380, lots: [{ date: '10-01-2025', qty: 2, unitCost: 400 }] }), // −40 × 0.9
        sale({ fecha: '05-01-2024', moneda: 'EUR', lots: [{ date: '02-01-2024', qty: 2, unitCost: 375 }] }), // +50 EUR
      ],
      rates: flat('USD', 0.9, ['2025-01-10', '2025-03-15', '2025-11-20']),
    });
    expect(report.years).toEqual(['2025', '2024']);
    const y25 = report.byYear['2025'];
    expect(y25.gains).toBeCloseTo(90, 10);
    expect(y25.losses).toBeCloseTo(-36, 10);
    expect(y25.net).toBeCloseTo(54, 10);
    expect(y25.salesCount).toBe(2);
    expect(report.byYear['2024'].gains).toBe(50);
  });

  it('cuenta las ventas sin historial de compra como no fiables y las deja FUERA de los totales', () => {
    const report = buildTaxReport({
      sales: [
        sale({ moneda: 'EUR' }),
        // sin lotes, el profit del pipeline es el importe íntegro de la venta
        sale({ moneda: 'EUR', isMissingBuyData: true, lots: [], profit: 800 }),
      ],
    });
    const y = report.byYear['2025'];
    expect(y.unreliableCount).toBe(1);
    expect(y.salesCount).toBe(2);
    expect(y.gains).toBe(100);
    expect(y.sales.find(s => s.status === 'missing_buy_data').profit).toBeNull();
  });

  it('suma dividendos con conversión por divisa de cobro', () => {
    const report = buildTaxReport({
      dividends: [div({ total: 25 }), div({ total: 10, moneda: 'EUR', fecha: '01-02-2025' })],
      rates: flat('USD', 0.8, ['2025-06-10']),
    });
    const y = report.byYear['2025'];
    expect(y.dividendsReceived).toBeCloseTo(25 * 0.8 + 10, 10);
    expect(y.dividendsCount).toBe(2);
  });

  it('las comisiones de compraventa se convierten con el tipo EUR (facturadas en EUR) y en valor absoluto', () => {
    const report = buildTaxReport({
      commissions: [
        { fecha: '01-04-2025', total: -2.5 },
        // De compraventa: hereda la moneda de la acción (USD), pero se factura en EUR.
        { fecha: '02-04-2025', total: 1.0, moneda: 'USD', isTradeCommission: true },
      ],
      preferredCurrency: 'GBP',
      rates: { ...flat('EUR', 1.1, ['2025-04-01', '2025-04-02']), ...flat('USD', 0.5, ['2025-04-02']) },
    });
    expect(report.byYear['2025'].fees).toBeCloseTo(3.5 * 1.1, 10);
  });

  it('el detalle de ventas queda ordenado por fecha ascendente', () => {
    const report = buildTaxReport({
      sales: [sale({ fecha: '20-11-2025', moneda: 'EUR' }), sale({ fecha: '02-01-2025', moneda: 'EUR' })],
    });
    expect(report.byYear['2025'].sales.map(s => s.fecha)).toEqual(['02-01-2025', '20-11-2025']);
  });

  it('filas sin fecha válida se descartan sin romper', () => {
    const report = buildTaxReport({ sales: [sale({ fecha: undefined })] });
    expect(report.years).toEqual([]);
  });
});

describe('buildTaxReport — tipo de cambio de la fecha de cada operación (AEAT)', () => {
  // Compra 10 USD×100 con EUR/USD a 1,10 y venta 10×120 con EUR/USD a 1,20.
  // Tipos de la tabla en sentido USD → EUR.
  const usdSale = (over = {}) => sale({
    fecha: '14-03-2025', cantidad: 10, precio: 120, total: 1200, profit: 200,
    lots: [{ date: '10-01-2024', qty: 10, unitCost: 100, fxRate: null }],
    ...over,
  });
  const rates = { USD: { '2024-01-10': 1 / 1.1, '2025-03-14': 1 / 1.2 } };

  it('venta al tipo del día de venta y coste al tipo del día de compra', () => {
    const y = buildTaxReport({ sales: [usdSale()], rates }).byYear['2025'];
    // 1200/1,20 − 1000/1,10 = 1000 − 909,0909… = 90,9090…
    expect(y.gains).toBeCloseTo(1000 - 1000 / 1.1, 9);
    expect(y.proceeds).toBeCloseTo(1000, 9);
    expect(y.acquisition).toBeCloseTo(1000 / 1.1, 9);
    // y NO es convertir el beneficio neto al tipo de la venta (166,67)
    expect(Math.abs(y.gains - 200 / 1.2)).toBeGreaterThan(70);
    const row = y.sales[0];
    expect(row.rate).toBeCloseTo(1 / 1.2, 12);
    expect(row.rateSource).toBe('historical');
    expect(row.lots[0]).toMatchObject({ date: '10-01-2024', qty: 10, rateSource: 'historical' });
    expect(row.lots[0].rate).toBeCloseTo(1 / 1.1, 12);
  });

  it('varios lotes, cada uno a su tipo', () => {
    const y = buildTaxReport({
      sales: [usdSale({
        lots: [
          { date: '10-01-2024', qty: 4, unitCost: 100 },
          { date: '11-01-2024', qty: 6, unitCost: 110 },
        ],
      })],
      rates: { USD: { '2024-01-10': 0.9, '2024-01-11': 0.8, '2025-03-14': 0.85 } },
    }).byYear['2025'];
    expect(y.gains).toBeCloseTo(1200 * 0.85 - (400 * 0.9 + 660 * 0.8), 9);
  });

  it('el fx_rate del bróker en el lote gana a la tabla', () => {
    const y = buildTaxReport({
      sales: [usdSale({ lots: [{ date: '10-01-2024', qty: 10, unitCost: 100, fxRate: 0.95 }] })],
      rates,
    }).byYear['2025'];
    expect(y.acquisition).toBeCloseTo(950, 9);
    expect(y.sales[0].lots[0].rateSource).toBe('broker');
  });

  it('el fx_rate del bróker en la venta gana a la tabla', () => {
    const y = buildTaxReport({ sales: [usdSale({ fxRate: 0.8 })], rates }).byYear['2025'];
    expect(y.proceeds).toBeCloseTo(960, 9);
    expect(y.sales[0].rateSource).toBe('broker');
  });

  it('venta en domingo → tipo del viernes anterior', () => {
    const y = buildTaxReport({
      sales: [usdSale({ fecha: '16-03-2025' })],
      rates: { USD: { '2024-01-10': 1 / 1.1, '2025-03-14': 1 / 1.2, '2025-03-17': 0.5 } },
    }).byYear['2025'];
    expect(y.proceeds).toBeCloseTo(1000, 9);
    expect(y.sales[0].rateDate).toBe('2025-03-14');
  });

  it('nunca un tipo posterior: con solo el lunes siguiente, la venta queda sin tipo', () => {
    const y = buildTaxReport({
      sales: [usdSale({ fecha: '16-03-2025' })],
      rates: { USD: { '2024-01-10': 1 / 1.1, '2025-03-17': 0.5 } },
    }).byYear['2025'];
    expect(y.missingFxCount).toBe(1);
    expect(y.gains).toBe(0);
  });

  it('sin tipo → missingFx con motivo, fuera de los totales, y nunca el de hoy', () => {
    const report = buildTaxReport({
      sales: [usdSale(), usdSale({ fecha: '20-03-2025', moneda: 'EUR', precio: 110, lots: [{ date: '10-01-2024', qty: 10, unitCost: 100 }] })],
      dividends: [div({ fecha: '10-06-2025' })],
      commissions: [{ fecha: '01-02-2025', type: 'FEE', total: -3, moneda: 'USD' }],
      // ni rastro del tipo de hoy: aunque alguien lo pase, no se usa
      exchangeRates: { USD: 0.9 },
      rates: { USD: { '2025-03-14': 1 / 1.2 } }, // falta el del lote
    });
    const y = report.byYear['2025'];
    expect(y.missingFxCount).toBe(3);
    expect(y.missingFx.map(m => m.kind).sort()).toEqual(['dividend', 'fee', 'sale']);
    expect(y.missingFx.find(m => m.kind === 'sale')).toMatchObject({ reason: 'no_rate', currency: 'USD', date: '2024-01-10' });
    // solo cuenta la venta en EUR: 1100 − 1000
    expect(y.gains).toBe(100);
    expect(y.dividendsReceived).toBe(0);
    expect(y.fees).toBe(0);
    expect(y.sales.find(s => s.status === 'missing_fx').profit).toBeNull();
  });

  it('dividendos y comisiones al tipo de su fecha', () => {
    const y = buildTaxReport({
      dividends: [div({ fecha: '10-03-2025', total: 10 }), div({ fecha: '10-06-2025', total: 10 })],
      commissions: [
        { fecha: '10-03-2025', type: 'FEE', total: -2, moneda: 'USD' },
        { fecha: '10-06-2025', type: 'TAX', total: -1.5, moneda: 'USD' },
      ],
      rates: { USD: { '2025-03-10': 0.9, '2025-06-10': 0.8 } },
    }).byYear['2025'];
    expect(y.dividendsReceived).toBeCloseTo(10 * 0.9 + 10 * 0.8, 10);
    expect(y.fees).toBeCloseTo(1.8, 10);
    expect(y.withholding).toBeCloseTo(1.2, 10);
    expect(y.dividends[0]).toMatchObject({ rateSource: 'historical', rateDate: '2025-03-10' });
  });
});

describe('buildTaxReport — cuadre con la pantalla (cartera solo en EUR)', () => {
  const tx = (over) => ({
    hora: '10:00', producto: 'SAN', isin: 'ES0113900J37', nombre: 'Santander', moneda: 'EUR', comisiones: 0, ...over,
  });
  const pdOf = () => computeProcessedImportData({
    importedTransactions: [
      tx({ type: 'BUY', fecha: '10-01-2024', cantidad: 100, precio: 3.137, total: -313.7, comisiones: 2 }),
      tx({ type: 'BUY', fecha: '11-02-2024', cantidad: 50, precio: 3.9, total: -195, comisiones: 2 }),
      tx({ type: 'SELL', fecha: '15-03-2025', cantidad: 120, precio: 4.41, total: 529.2, comisiones: 2 }),
      tx({ type: 'SELL', fecha: '15-04-2025', cantidad: 30, precio: 3.5, total: 105, comisiones: 2 }),
      tx({ type: 'BUY', fecha: '01-02-2025', producto: 'ITX', isin: 'ES0148396007', cantidad: 10, precio: 40.33, total: -403.3 }),
      tx({ type: 'SELL', fecha: '03-02-2025', producto: 'ITX', isin: 'ES0148396007', cantidad: 10, precio: 38.1, total: 381 }),
      tx({ type: 'DIVIDEND', fecha: '02-05-2025', total: 12.4, cantidad: 0, precio: 0 }),
      tx({ type: 'TAX', fecha: '02-05-2025', total: -2.36, cantidad: 0, precio: 0 }),
      tx({ type: 'FEE', fecha: '31-12-2025', total: -2.5, cantidad: 0, precio: 0 }),
    ],
    dbTransactions: [],
    exchangeRates: { EUR: 1 },
  });

  // CONTRATO (2026-10-22, revisión F1F2 punto 1): con `buys` (lo que usa el
  // diálogo) las comisiones de compraventa van DENTRO de los valores (art. 35
  // LIRPF) y el informe difiere de la pantalla exactamente en ellas, a
  // propósito. `fees` se queda con los gastos sueltos (custodia: 2,5).
  it('con `buys`: neto = realizado de la pantalla − comisiones de compraventa; fees solo los gastos sueltos', () => {
    const pd = pdOf();
    const report = buildTaxReport({
      sales: pd.salesWithPL, buys: pd.buys, dividends: pd.dividends, commissions: pd.commissions, preferredCurrency: 'EUR',
    });
    const all = Object.values(report.byYear);
    const sum = (k) => all.reduce((s, y) => s + y[k], 0);
    expect(sum('net')).toBeCloseTo(pd.totals.salesTotal - 8, 10);
    // 2024 solo tenía las comisiones de las dos compras: ahora van en el valor de
    // adquisición de las ventas de 2025, así que 2024 ni aparece.
    expect(report.years).toEqual(['2025']);
    expect(report.byYear['2025'].fees).toBeCloseTo(2.5, 10);
    expect(report.byYear['2025'].withholding).toBeCloseTo(2.36, 10);
    expect(sum('dividendsReceived')).toBeCloseTo(pd.totals.dividendsTotal, 10);
  });

  // Ruta sin `buys` (legacy, sin regla): sigue cuadrando al céntimo con la
  // pantalla, comisiones aparte en `fees`.
  it('sin `buys` (legacy): ganancias, pérdidas, dividendos y comisiones = totales de processedImportData', () => {
    const pd = computeProcessedImportData({
      importedTransactions: [
        tx({ type: 'BUY', fecha: '10-01-2024', cantidad: 100, precio: 3.137, total: -313.7, comisiones: 2 }),
        tx({ type: 'BUY', fecha: '11-02-2024', cantidad: 50, precio: 3.9, total: -195, comisiones: 2 }),
        tx({ type: 'SELL', fecha: '15-03-2025', cantidad: 120, precio: 4.41, total: 529.2, comisiones: 2 }),
        tx({ type: 'SELL', fecha: '15-04-2025', cantidad: 30, precio: 3.5, total: 105, comisiones: 2 }),
        tx({ type: 'BUY', fecha: '01-02-2025', producto: 'ITX', isin: 'ES0148396007', cantidad: 10, precio: 40.33, total: -403.3 }),
        tx({ type: 'SELL', fecha: '03-02-2025', producto: 'ITX', isin: 'ES0148396007', cantidad: 10, precio: 38.1, total: 381 }),
        tx({ type: 'DIVIDEND', fecha: '02-05-2025', total: 12.4, cantidad: 0, precio: 0 }),
        tx({ type: 'TAX', fecha: '02-05-2025', total: -2.36, cantidad: 0, precio: 0 }),
        tx({ type: 'FEE', fecha: '31-12-2025', total: -2.5, cantidad: 0, precio: 0 }),
      ],
      dbTransactions: [],
      exchangeRates: { EUR: 1 },
    });
    const report = buildTaxReport({
      sales: pd.salesWithPL, dividends: pd.dividends, commissions: pd.commissions, preferredCurrency: 'EUR',
    });
    const all = Object.values(report.byYear);
    const sum = (k) => all.reduce((s, y) => s + y[k], 0);

    expect(sum('gains') + sum('losses')).toBeCloseTo(pd.totals.salesTotal, 10);
    expect(sum('gains')).toBeCloseTo(
      pd.salesWithPL.filter(s => s.profit > 0).reduce((s, x) => s + x.profit, 0), 10);
    expect(sum('losses')).toBeCloseTo(
      pd.salesWithPL.filter(s => s.profit < 0).reduce((s, x) => s + x.profit, 0), 10);
    expect(sum('dividendsReceived')).toBeCloseTo(pd.totals.dividendsTotal, 10);
    expect(sum('fees') + sum('withholding')).toBeCloseTo(pd.totals.commissionsTotal, 10);
    expect(sum('missingFxCount')).toBe(0);
    // y los números a mano: 120×4,41 − (100×3,137 + 20×3,9) = 137,5 ; 30×3,5 − 30×3,9 = −12 ; 381 − 403,3 = −22,3
    expect(report.byYear['2025'].gains).toBeCloseTo(137.5, 10);
    expect(report.byYear['2025'].losses).toBeCloseTo(-34.3, 10);
    // comisiones de las dos compras de 2024 en 2024; las de 2025: 3 ventas×2 + custodia 2,5
    expect(report.byYear['2024'].fees).toBeCloseTo(4, 10);
    expect(report.byYear['2025'].fees).toBeCloseTo(2 + 2 + 2.5, 10);
    expect(report.byYear['2025'].withholding).toBeCloseTo(2.36, 10);
  });
});

describe('taxReportToCsv', () => {
  const labels = {
    title: 'Informe fiscal', summary: 'Resumen', gains: 'Ganancias', losses: 'Pérdidas',
    net: 'Neto', dividendsReceived: 'Dividendos cobrados', withholding: 'Retenciones', fees: 'Comisiones', salesSection: 'Ventas',
    dividendsSection: 'Dividendos', date: 'Fecha', asset: 'Activo', quantity: 'Cantidad',
    price: 'Precio', currency: 'Divisa', amount: 'Importe', pnl: 'G/P',
    missingFxSection: 'Sin tipo de cambio', missingFxNote: 'No computa',
  };

  it('genera CSV con separador ; y decimales con coma (Excel ES)', () => {
    const report = buildTaxReport({
      sales: [sale({ lots: [{ date: '10-01-2025', qty: 2, unitCost: 349.75 }] })],
      rates: flat('USD', 1, ['2025-01-10', '2025-03-15']),
    });
    const csv = taxReportToCsv(report.byYear['2025'], '2025', labels);
    expect(csv).toContain('Informe fiscal;2025');
    expect(csv).toContain('Ganancias;100,50');
    expect(csv.split('\n').some(l => l.startsWith('15-03-2025;Microsoft;US5949181045'))).toBe(true);
  });

  it('redondea al céntimo (x,xx5 sube), no trunca', () => {
    // 10,125 y 0,005 son exactos en binario: Math.round(1012,5) = 1013 → 10,13;
    // Math.trunc daría 10,12 y 0,00.
    const report = buildTaxReport({
      dividends: [div({ moneda: 'EUR', total: 10.125 })],
      commissions: [{ fecha: '01-02-2025', type: 'FEE', total: -0.005, moneda: 'EUR' }],
    });
    const csv = taxReportToCsv(report.byYear['2025'], '2025', labels);
    expect(csv).toContain('Dividendos cobrados;10,13');
    expect(csv).toContain('Comisiones;0,01');
    expect(csv).toMatch(/Microsoft;US5949181045;EUR;1,000000;[^;]*;10,13$/m);
  });

  it('escapa campos con ; o comillas', () => {
    const report = buildTaxReport({ sales: [sale({ nombre: 'Fondo; "raro"', moneda: 'EUR' })] });
    const csv = taxReportToCsv(report.byYear['2025'], '2025', labels);
    expect(csv).toContain('"Fondo; ""raro"""');
  });

  it('las filas sin tipo de cambio salen en su sección y no como G/P 0', () => {
    const report = buildTaxReport({ sales: [sale()], dividends: [div()] });
    const csv = taxReportToCsv(report.byYear['2025'], '2025', labels);
    expect(csv).toContain('Sin tipo de cambio;2');
    // tipo, fuente, transmisión, adquisición y G/P vacíos: nada de un 0 que parezca dato
    expect(csv).toMatch(/15-03-2025;Microsoft;US5949181045;2,00;400,00;USD;800,00;;;;;;No computa/);
  });
});

describe('buildTaxReport — moneda de las comisiones', () => {
  // Caso de la demo (2026-10-16): "Broker fee" 1,50 $ + custodia 12,50 €. La
  // pantalla decía 13,83 € y el informe 14,00 €: sumaba los dólares como euros.
  const rates = flat('USD', 0.8867, ['2024-03-01', '2024-05-05']);

  it('una comisión suelta en USD se convierte con su moneda', () => {
    const r = buildTaxReport({
      commissions: [
        { fecha: '01-03-2024', type: 'FEE', total: -1.5, moneda: 'USD' },
        { fecha: '01-01-2024', type: 'FEE', total: -12.5, moneda: 'EUR' },
      ],
      rates,
    });
    expect(r.byYear[2024].fees).toBeCloseTo(13.83, 2);
  });

  it('la comisión de una compraventa sigue en EUR aunque la acción cotice en USD', () => {
    const r = buildTaxReport({
      commissions: [{ fecha: '05-05-2024', type: 'FEE', total: -2, moneda: 'USD', isTradeCommission: true }],
      rates,
    });
    expect(r.byYear[2024].fees).toBeCloseTo(2, 6);
  });
});

describe('commissionCurrency', () => {
  it('compraventa → EUR (DEGIRO/IBKR la facturan en euros); suelta → su moneda', () => {
    expect(commissionCurrency({ moneda: 'USD', isTradeCommission: true })).toBe('EUR');
    expect(commissionCurrency({ moneda: 'USD' })).toBe('USD');
    expect(commissionCurrency({})).toBe('EUR');
  });
});

describe('buildTaxReport — retenciones aparte de las comisiones', () => {
  // DEGIRO/IBKR apuntan la retención del dividendo como una línea TAX propia.
  // Antes caía dentro de "Comisiones y tasas" y el informe llamaba "netos" a
  // unos dividendos que eran brutos: para declarar, bruto y retención van aparte.
  it('una fila TAX va a withholding, no a fees', () => {
    const r = buildTaxReport({
      dividends: [{ fecha: '15-02-2025', total: 100, moneda: 'EUR' }],
      commissions: [
        { fecha: '15-02-2025', type: 'TAX', total: -15, moneda: 'EUR' },
        { fecha: '01-03-2025', type: 'FEE', total: -2, moneda: 'EUR' },
      ],
    });
    expect(r.byYear['2025'].withholding).toBeCloseTo(15, 6);
    expect(r.byYear['2025'].fees).toBeCloseTo(2, 6);
    expect(r.byYear['2025'].dividendsReceived).toBeCloseTo(100, 6);
  });

  it('una retención en USD se convierte con su moneda', () => {
    const r = buildTaxReport({
      commissions: [{ fecha: '15-02-2025', type: 'TAX', total: -10, moneda: 'USD' }],
      rates: flat('USD', 0.9, ['2025-02-15']),
    });
    expect(r.byYear['2025'].withholding).toBeCloseTo(9, 6);
  });

  it('el CSV lleva su línea de retenciones', () => {
    const r = buildTaxReport({
      commissions: [{ fecha: '15-02-2025', type: 'TAX', total: -15, moneda: 'EUR' }],
    });
    const csv = taxReportToCsv(r.byYear['2025'], '2025', { withholding: 'Retenciones' });
    expect(csv).toMatch(/Retenciones;15/);
  });
});
