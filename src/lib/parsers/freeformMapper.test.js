import { describe, it, expect, vi } from 'vitest';
import { validateFreeformRow, freeformToTrazza, isoToTrazzaDate, resolveMissingTickers, stripOperationPrefix } from './freeformMapper';
import { calculateNetBuys } from '@/services/import/netHoldings';

const buyRow = (over = {}) => ({
  date: '2026-05-24', ticker: 'AAPL', assetName: 'Apple Inc', type: 'BUY',
  quantity: 10, price: 150.5, amount: null, currency: 'USD',
  sourceLine: '24/05/2026 Compra 10 AAPL @ 150,50 USD', ...over,
});

describe('validateFreeformRow', () => {
  it('accepts a complete BUY row', () => {
    expect(validateFreeformRow(buyRow())).toEqual([]);
  });

  it('flags null/invalid date', () => {
    expect(validateFreeformRow(buyRow({ date: null }))).toContain('date');
    expect(validateFreeformRow(buyRow({ date: '24-05-2026' }))).toContain('date');
  });

  it('flags missing ticker on asset rows even when assetName is present', () => {
    expect(validateFreeformRow(buyRow({ ticker: null }))).toContain('ticker');
  });

  it('does not require ticker for DEPOSIT/WITHDRAWAL', () => {
    const dep = { date: '2026-01-02', ticker: null, assetName: null, type: 'DEPOSIT', quantity: null, price: null, amount: 1000, currency: 'EUR' };
    expect(validateFreeformRow(dep)).toEqual([]);
  });

  it('flags BUY/SELL without quantity or price', () => {
    expect(validateFreeformRow(buyRow({ quantity: null }))).toContain('quantity');
    expect(validateFreeformRow(buyRow({ price: 0 }))).toContain('price');
  });

  it('flags money-only rows without amount (never default to 0)', () => {
    const div = { date: '2026-03-10', ticker: 'KO', assetName: 'Coca-Cola', type: 'DIVIDEND', quantity: null, price: null, amount: null, currency: 'USD' };
    expect(validateFreeformRow(div)).toContain('amount');
  });

  it('flags invalid currency', () => {
    expect(validateFreeformRow(buyRow({ currency: null }))).toContain('currency');
    expect(validateFreeformRow(buyRow({ currency: 'EURUSD' }))).toContain('currency');
  });
});

describe('isoToTrazzaDate', () => {
  it('converts ISO to DD-MM-YYYY', () => {
    expect(isoToTrazzaDate('2026-05-24')).toBe('24-05-2026');
  });
});

describe('freeformToTrazza', () => {
  it('maps BUY with negative total from qty×price when no explicit amount', () => {
    const [t] = freeformToTrazza([buyRow()]);
    expect(t.type).toBe('BUY');
    expect(t.fecha).toBe('24-05-2026');
    expect(t.producto).toBe('AAPL');
    expect(t.nombre).toBe('Apple Inc');
    expect(t.isin).toBe('');
    expect(t.cantidad).toBe(10);
    expect(t.precio).toBe(150.5);
    expect(t.total).toBeCloseTo(-1505, 10);
    expect(t.moneda).toBe('USD');
    expect(t.comisiones).toBe(0);
    expect(t.isAIParsed).toBe(true);
  });

  it('prefers the explicit extracted amount over qty×price', () => {
    const [t] = freeformToTrazza([buyRow({ amount: 1507.25 })]);
    expect(t.total).toBe(-1507.25);
  });

  it('maps SELL with positive total', () => {
    const [t] = freeformToTrazza([buyRow({ type: 'SELL' })]);
    expect(t.total).toBeCloseTo(1505, 10);
  });

  it('maps DIVIDEND amount to positive total with no qty/price', () => {
    const [t] = freeformToTrazza([{ date: '2026-03-10', ticker: 'KO', assetName: 'Coca-Cola', type: 'DIVIDEND', quantity: null, price: null, amount: 12.34, currency: 'USD' }]);
    expect(t.type).toBe('DIVIDEND');
    expect(t.cantidad).toBe(0);
    expect(t.precio).toBe(0);
    expect(t.total).toBe(12.34);
  });

  it('maps FEE to FEES with negative total', () => {
    const [t] = freeformToTrazza([{ date: '2026-03-10', ticker: null, assetName: 'Custodia', type: 'FEE', quantity: null, price: null, amount: 2.5, currency: 'EUR' }]);
    expect(t.type).toBe('FEES');
    expect(t.total).toBe(-2.5);
  });

  it('maps DEPOSIT/WITHDRAWAL to signed TRANSFER', () => {
    const rows = freeformToTrazza([
      { date: '2026-01-02', ticker: null, assetName: null, type: 'DEPOSIT', quantity: null, price: null, amount: 1000, currency: 'EUR' },
      { date: '2026-02-02', ticker: null, assetName: null, type: 'WITHDRAWAL', quantity: null, price: null, amount: 250, currency: 'EUR' },
    ]);
    expect(rows[0].type).toBe('TRANSFER');
    expect(rows[0].total).toBe(1000);
    expect(rows[1].type).toBe('TRANSFER');
    expect(rows[1].total).toBe(-250);
  });

  it('maps HOLDING (position snapshot) to an opening BUY at average cost', () => {
    const holding = {
      date: '2026-06-01', ticker: 'GOOGL', isin: 'US02079K3059', assetName: 'Alphabet Inc Class A',
      type: 'HOLDING', quantity: 21, price: 161.761742, amount: null, currency: 'USD',
    };
    const [t] = freeformToTrazza([holding]);
    expect(t.type).toBe('BUY');
    expect(t.cantidad).toBe(21);
    expect(t.precio).toBe(161.761742);
    // total es DINERO: se redondea a céntimos (el precio conserva los 6
    // decimales) — sin redondeo, el ruido de coma flotante de qty×price
    // (p.ej. 490.00000000000006) rompía las claves de dedupe en re-imports.
    expect(t.total).toBe(-3397.00);
    expect(t.isin).toBe('US02079K3059');
  });

  it('flags HOLDING without average cost or date (never substitutes market price)', () => {
    const noBep = { date: null, ticker: 'GOOGL', assetName: 'Alphabet', type: 'HOLDING', quantity: 21, price: null, amount: null, currency: 'USD' };
    const issues = validateFreeformRow(noBep);
    expect(issues).toContain('price');
    expect(issues).toContain('date');
  });

  it('passes a strictly-valid ISIN through and drops malformed ones', () => {
    const [withIsin] = freeformToTrazza([buyRow({ isin: 'US0378331005' })]);
    expect(withIsin.isin).toBe('US0378331005');
    const [badIsin] = freeformToTrazza([buyRow({ isin: 'ISIN_INVALIDO' })]);
    expect(badIsin.isin).toBe('');
    const [noIsin] = freeformToTrazza([buyRow()]);
    expect(noIsin.isin).toBe('');
  });

  it('skips rows that fail validation instead of defaulting fields', () => {
    const rows = freeformToTrazza([
      buyRow(),
      buyRow({ price: null }),               // incomplete BUY
      { date: '2026-03-10', ticker: 'KO', assetName: null, type: 'DIVIDEND', quantity: null, price: null, amount: null, currency: 'USD' }, // dividend without amount
    ]);
    expect(rows).toHaveLength(1);
  });
});

describe('resolveMissingTickers — el nombre basta, el ticker se busca solo', () => {
  const search = (results) => vi.fn().mockResolvedValue(results);

  it('rellena el ticker buscando por nombre cuando la IA solo extrajo el nombre', async () => {
    const searchFn = search([
      { symbol: 'IBE.MC', description: 'Iberdrola S.A.', type: 'EQUITY' },
    ]);
    const rows = await resolveMissingTickers(
      [buyRow({ ticker: null, assetName: 'Iberdrola' })],
      searchFn, { pauseMs: 0 }
    );
    expect(rows[0].ticker).toBe('IBE.MC');
    expect(rows[0].autoResolved).toBe(true);
    expect(validateFreeformRow(rows[0])).toEqual([]);
    expect(searchFn).toHaveBeenCalledWith('Iberdrola');
  });

  it('no toca filas que ya traen ticker ni gasta búsquedas en ellas', async () => {
    const searchFn = search([{ symbol: 'X', description: 'X', type: 'EQUITY' }]);
    const rows = await resolveMissingTickers([buyRow()], searchFn, { pauseMs: 0 });
    expect(rows[0].ticker).toBe('AAPL');
    expect(rows[0].autoResolved).toBeUndefined();
    expect(searchFn).not.toHaveBeenCalled();
  });

  it('prefiere el listado cuya divisa coincide con la de la fila', async () => {
    const searchFn = search([
      { symbol: 'SAN', description: 'Banco Santander ADR', type: 'EQUITY' },
      { symbol: 'SAN.MC', description: 'Banco Santander S.A.', type: 'EQUITY' },
    ]);
    const rows = await resolveMissingTickers(
      [buyRow({ ticker: null, assetName: 'Banco Santander', currency: 'EUR' })],
      searchFn, { pauseMs: 0 }
    );
    expect(rows[0].ticker).toBe('SAN.MC');
  });

  it('rechaza resultados cuyo nombre no coincide (no se adivina)', async () => {
    const searchFn = search([
      { symbol: 'GLD', description: 'SPDR Gold Shares', type: 'ETF' },
    ]);
    const rows = await resolveMissingTickers(
      [buyRow({ ticker: null, assetName: 'Iberdrola' })],
      searchFn, { pauseMs: 0 }
    );
    expect(rows[0].ticker).toBeFalsy(); // sigue pendiente en la tabla HITL
  });

  it('errores de red → fila intacta, sin lanzar', async () => {
    const searchFn = vi.fn().mockRejectedValue(new Error('429'));
    const rows = await resolveMissingTickers(
      [buyRow({ ticker: null, assetName: 'Iberdrola' })],
      searchFn, { pauseMs: 0 }
    );
    expect(rows[0].ticker).toBeFalsy();
  });

  it('cachea por nombre (misma empresa en varias filas = una búsqueda) y salta filas de caja', async () => {
    const searchFn = search([{ symbol: 'IBE.MC', description: 'Iberdrola S.A.', type: 'EQUITY' }]);
    const rows = await resolveMissingTickers([
      buyRow({ ticker: null, assetName: 'Iberdrola' }),
      buyRow({ ticker: null, assetName: 'Iberdrola', date: '2026-05-25' }),
      { date: '2026-05-24', type: 'DEPOSIT', amount: 100, currency: 'EUR' },
    ], searchFn, { pauseMs: 0 });
    expect(rows[0].ticker).toBe('IBE.MC');
    expect(rows[1].ticker).toBe('IBE.MC');
    expect(searchFn).toHaveBeenCalledTimes(1);
    expect(rows[2].ticker).toBeUndefined();
  });
});

describe('resolveMissingTickers — regresiones del primer uso real', () => {
  it('acepta instrumentos tipo ETC (ETC Group Physical Bitcoin → BTCE)', async () => {
    const searchFn = vi.fn().mockResolvedValue([
      { symbol: 'BTCE.DE', description: 'ETC Group Physical Bitcoin', type: 'ETC' },
    ]);
    const rows = await resolveMissingTickers(
      [buyRow({ ticker: null, assetName: 'ETC Group Physical Bitcoin', currency: 'EUR' })],
      searchFn, { pauseMs: 0 }
    );
    expect(rows[0].ticker).toBe('BTCE.DE');
  });

  it('la divisa de la COMPRA decide el listado para todas las filas del mismo activo', async () => {
    // El dividendo llega convertido a EUR pero la posición se compró en USD:
    // todas las filas de "Tesla Inc" deben resolver al MISMO ticker (TSLA),
    // o el dividendo crearía un activo separado (TL0.DE) partiendo la posición.
    const searchFn = vi.fn().mockResolvedValue([
      { symbol: 'TL0.DE', description: 'Tesla Inc', type: 'EQUITY' },
      { symbol: 'TSLA', description: 'Tesla Inc', type: 'EQUITY' },
    ]);
    const rows = await resolveMissingTickers([
      { date: '2026-06-10', type: 'DIVIDEND', assetName: 'Tesla Inc', amount: 773.41, currency: 'EUR' },
      buyRow({ ticker: null, assetName: 'Tesla Inc', currency: 'USD' }),
    ], searchFn, { pauseMs: 0 });
    expect(rows[0].ticker).toBe('TSLA');
    expect(rows[1].ticker).toBe('TSLA');
    expect(searchFn).toHaveBeenCalledTimes(1);
  });
});

describe('resolveMissingTickers — resolución por ISIN cuando la IA lo extrajo', () => {
  it('ISIN en el mapa estático → ticker sin tocar la red', async () => {
    const searchFn = vi.fn();
    const rows = await resolveMissingTickers(
      // DE000A27Z304 = BTCE.DE en TICKER_MAP — el caso "producto renombrado"
      // (ETC Group → Bitwise) irresoluble por nombre
      [buyRow({ ticker: null, assetName: 'ETC Group Physical Bitcoin', isin: 'DE000A27Z304', currency: 'EUR' })],
      searchFn, { pauseMs: 0 }
    );
    expect(rows[0].ticker).toBe('BTCE.DE');
    expect(searchFn).not.toHaveBeenCalled();
  });

  it('ISIN fuera del mapa → búsqueda por ISIN antes que por nombre', async () => {
    const searchFn = vi.fn().mockImplementation(async (q) =>
      q === 'IE00TEST0018'
        ? [{ symbol: 'IWDA.AS', description: 'iShares Core MSCI World', type: 'ETF' }]
        : []
    );
    const rows = await resolveMissingTickers(
      [buyRow({ ticker: null, assetName: 'Un Fondo Cualquiera', isin: 'IE00TEST0018', currency: 'EUR' })],
      searchFn, { pauseMs: 0 }
    );
    expect(rows[0].ticker).toBe('IWDA.AS');
    expect(searchFn).toHaveBeenCalledWith('IE00TEST0018');
  });
});

describe('freeformToTrazza — normalización GBX (peniques) determinista', () => {
  it('precio GBX → GBP ÷100; importe en libras se respeta', () => {
    // DeGiro: "Compra 200 Rolls-Royce @520 GBX" con Variación -1.040,00 GBP
    const [row] = freeformToTrazza([buyRow({
      ticker: 'RR.L', assetName: 'Rolls-Royce', quantity: 200, price: 520,
      amount: 1040, currency: 'GBX',
    })]);
    expect(row).toMatchObject({ moneda: 'GBP', precio: 5.20, cantidad: 200, total: -1040 });
  });

  it('importe expresado en peniques se detecta por aritmética y se divide', () => {
    // 64 × 1690 GBX = 108160 peniques = 1081.60 £
    const [row] = freeformToTrazza([buyRow({
      ticker: 'ZEG.L', assetName: 'Zegona', quantity: 64, price: 1690,
      amount: 108160, currency: 'GBX',
    })]);
    expect(row).toMatchObject({ moneda: 'GBP', precio: 16.90, total: -1081.60 });
  });

  it('sin importe explícito → total = qty × precio en libras', () => {
    const [row] = freeformToTrazza([buyRow({
      ticker: 'RR.L', assetName: 'Rolls-Royce', quantity: 100, price: 490,
      amount: null, currency: 'GBX',
    })]);
    expect(row).toMatchObject({ moneda: 'GBP', precio: 4.90, total: -490 });
  });
});

describe('freeformToTrazza — HOLDING no debe generar margen (regresión 2026-07-26)', () => {
  // Tabla de posiciones real pegada por el usuario en el import IA: solo tenencias,
  // sin ingresos ni movimientos de caja. Antes cada fila se replicaba como compra y
  // el ledger acababa en -23.949 € → la cabecera mostraba "Margen utilizado".
  const holdings = [
    { date: '2026-07-24', ticker: 'GOOGL', assetName: 'Alphabet Inc Class A', type: 'HOLDING',
      quantity: 24, price: 184.787775, amount: null, currency: 'USD' },
    { date: '2026-07-24', ticker: 'AMZN', assetName: 'Amazon.com Inc', type: 'HOLDING',
      quantity: 17, price: 209.630294, amount: null, currency: 'USD' },
    { date: '2026-07-24', ticker: 'MSFT', assetName: 'Microsoft Corp', type: 'HOLDING',
      quantity: 21, price: 421.622757, amount: null, currency: 'USD' },
  ];

  it('marca las filas HOLDING como consolidadas', () => {
    const rows = freeformToTrazza(holdings);
    expect(rows).toHaveLength(3);
    rows.forEach(r => {
      expect(r.isConsolidated).toBe(true);
      expect(r.type).toBe('BUY');
    });
  });

  it('NO marca como consolidada una compra real', () => {
    const [row] = freeformToTrazza([buyRow()]);
    expect(row.isConsolidated).toBeUndefined();
  });

  it('conserva cantidad y precio medio de cada posición', () => {
    const rows = freeformToTrazza(holdings);
    expect(rows[0]).toMatchObject({ producto: 'GOOGL', cantidad: 24, precio: 184.787775, moneda: 'USD' });
  });
});

describe('calculateNetBuys sobre un snapshot de cartera', () => {
  const broker = { name: 'DeGiro' };
  const snapshot = freeformToTrazza([
    { date: '2026-07-24', ticker: 'GOOGL', assetName: 'Alphabet Inc Class A', type: 'HOLDING',
      quantity: 24, price: 184.787775, amount: null, currency: 'USD' },
    { date: '2026-07-24', ticker: 'MSFT', assetName: 'Microsoft Corp', type: 'HOLDING',
      quantity: 21, price: 421.622757, amount: null, currency: 'USD' },
  ]);

  it('no crea NINGUNA posición de efectivo (ni positiva ni negativa)', () => {
    const net = calculateNetBuys(snapshot, broker);
    expect(net.filter(n => n.type === 'CASH')).toEqual([]);
  });

  it('crea las posiciones con su cantidad y coste medio', () => {
    const net = calculateNetBuys(snapshot, broker).filter(n => n.type !== 'CASH');
    expect(net).toHaveLength(2);
    expect(net.find(n => n.producto === 'GOOGL')).toMatchObject({ qty: 24, precio: 184.787775 });
    expect(net.find(n => n.producto === 'MSFT')).toMatchObject({ qty: 21, precio: 421.622757 });
  });

  it('una compra real SÍ sigue moviendo la caja (no se ha roto el caso normal)', () => {
    const trades = freeformToTrazza([buyRow({ quantity: 10, price: 100, currency: 'USD' })]);
    const cash = calculateNetBuys(trades, broker).filter(n => n.type === 'CASH');
    expect(cash).toHaveLength(1);
    expect(cash[0].qty).toBeCloseTo(-1000, 2);
  });

  it('los depósitos pegados junto a las tenencias sí financian la caja', () => {
    const mixed = freeformToTrazza([
      { date: '2026-01-02', ticker: null, assetName: null, type: 'DEPOSIT',
        quantity: null, price: null, amount: 5000, currency: 'USD' },
      { date: '2026-07-24', ticker: 'GOOGL', assetName: 'Alphabet Inc Class A', type: 'HOLDING',
        quantity: 24, price: 184.787775, amount: null, currency: 'USD' },
    ]);
    const cash = calculateNetBuys(mixed, broker).filter(n => n.type === 'CASH');
    expect(cash[0].qty).toBeCloseTo(5000, 2);
  });
});
describe('resolveMissingTickers — un fondo NUNCA se resuelve a un hermano de su familia', () => {
  const search = (results) => vi.fn().mockResolvedValue(results);

  /* Caso real reportado (cartera gestionada de MyInvestor pegada como texto).
     La marca de un fondo —"Vanguard", "iShares", "Fidelity"— la comparten
     cientos de productos, así que exigir solo la marca dejaba pasar cualquier
     hermano: el resultado fue VOO (S&P 500) asignado a un fondo de deuda a 20
     años Y a otro de bonos de gobierno, y FBGRX (Blue Chip Growth) a un
     Pacific ex-Japan. Un ticker equivocado no se ve: valora la posición con el
     NAV de otro producto para siempre. */

  it('no acepta VOO para el fondo de deuda a 20 años', async () => {
    const searchFn = search([
      { symbol: 'VOO', description: 'Vanguard S&P 500 ETF', type: 'ETF' },
      { symbol: 'VTI', description: 'Vanguard Total Stock Market ETF', type: 'ETF' },
    ]);
    const rows = await resolveMissingTickers(
      [buyRow({ ticker: null, assetName: 'VANGUARD 20+ YEAR EURO TREASURY INDEX', currency: 'EUR' })],
      searchFn, { pauseMs: 0 }
    );
    expect(rows[0].ticker).toBeNull();
    expect(validateFreeformRow(rows[0])).toContain('ticker');
  });

  it('no acepta FBGRX para el Pacific ex-Japan', async () => {
    const SIBLINGS = [{ symbol: 'FBGRX', description: 'Fidelity Blue Chip Growth Fund', type: 'MUTUALFUND' }];
    // El ISIN curado no lo encuentra el proveedor, así que la resolución cae a
    // la búsqueda por NOMBRE — que es lo que este test vigila.
    const searchFn = vi.fn(async (q) => (/^[A-Z]{2}[A-Z0-9]{10}$/.test(q) ? [] : SIBLINGS));

    const rows = await resolveMissingTickers(
      [buyRow({ ticker: null, assetName: 'FIDELITY MSCI PACFC EXJAPN IDX', currency: 'EUR' })],
      searchFn, { pauseMs: 0 }
    );
    expect(rows[0].ticker).toBeNull();
  });

  it('no da el MISMO ticker a dos fondos distintos de la misma gestora', async () => {
    const SIBLINGS = [{ symbol: 'VOO', description: 'Vanguard S&P 500 ETF', type: 'ETF' }];
    // El ISIN curado no lo encuentra el proveedor, así que la resolución cae a
    // la búsqueda por NOMBRE — que es lo que este test vigila.
    const searchFn = vi.fn(async (q) => (/^[A-Z]{2}[A-Z0-9]{10}$/.test(q) ? [] : SIBLINGS));

    const rows = await resolveMissingTickers([
      buyRow({ ticker: null, assetName: 'VANGUARD 20+ YEAR EURO TREASURY INDEX', currency: 'EUR' }),
      buyRow({ ticker: null, assetName: 'VANGUARD US GOVERNMENT BD INDE', currency: 'EUR' }),
    ], searchFn, { pauseMs: 0 });
    expect(rows.map((r) => r.ticker)).toEqual([null, null]);
  });

  it('sí acepta el fondo cuando el nombre concuerda de verdad', async () => {
    const searchFn = search([
      { symbol: 'VOO', description: 'Vanguard S&P 500 ETF', type: 'ETF' },
      { symbol: '0P0001ABCD', description: 'Vanguard 20+ Year Euro Treasury Index Fund EUR Acc', type: 'MUTUALFUND' },
    ]);
    const rows = await resolveMissingTickers(
      [buyRow({ ticker: null, assetName: 'VANGUARD 20+ YEAR EURO TREASURY INDEX', currency: 'EUR' })],
      searchFn, { pauseMs: 0 }
    );
    expect(rows[0].ticker).toBe('0P0001ABCD');
  });

  it('tolera las abreviaturas del extracto ("GOVER BOND" → "Government Bond")', async () => {
    const searchFn = search([
      { symbol: '0P0000XYZ1', description: 'Vanguard U.S. Government Bond Index Fund EUR Hedged Acc', type: 'MUTUALFUND' },
    ]);
    const rows = await resolveMissingTickers(
      [buyRow({ ticker: null, assetName: 'VANGUARD US GOVERNMENT BD INDE', currency: 'EUR' })],
      searchFn, { pauseMs: 0 }
    );
    expect(rows[0].ticker).toBe('0P0000XYZ1');
  });

  it('usa el ISIN curado del fondo antes de buscar por nombre', async () => {
    // El nombre truncado del extracto es una clave conocida de la plataforma:
    // no hay que adivinar la clase, se busca por su ISIN verificado.
    const searchFn = vi.fn(async (q) =>
      q === 'IE00BYX5N771'
        ? [{ symbol: '0P0001ABCD', description: 'Fidelity MSCI Japan Index Fund P-ACC-EUR', type: 'MUTUALFUND' }]
        : [{ symbol: 'FBGRX', description: 'Fidelity Blue Chip Growth Fund', type: 'MUTUALFUND' }]
    );
    const rows = await resolveMissingTickers(
      [buyRow({ ticker: null, assetName: 'FIDELITY MSCI JAPAN INDEX P AC', currency: 'EUR' })],
      searchFn, { pauseMs: 0 }
    );
    expect(rows[0].ticker).toBe('0P0001ABCD');
    expect(searchFn).toHaveBeenCalledWith('IE00BYX5N771');
  });
});

describe('stripOperationPrefix — la etiqueta de la operación no es el activo', () => {
  it('quita la cabecera larga de unas órdenes de fondos', () => {
    expect(stripOperationPrefix('Suscripción Fondos de Inversión Fidelity MSCI Japan Index Fund P-ACC-EUR'))
      .toBe('Fidelity MSCI Japan Index Fund P-ACC-EUR');
  });

  it('quita la cabecera corta de un libro de movimientos', () => {
    expect(stripOperationPrefix('Suscripcion Iic ISHARES EMERGING MARKETS INDEX'))
      .toBe('ISHARES EMERGING MARKETS INDEX');
  });

  it('NO toca un fondo que de verdad se llama "Fondo …"', () => {
    expect(stripOperationPrefix('Fondo Ibercaja Selección Capital')).toBe('Fondo Ibercaja Selección Capital');
  });

  it('deja intacto un nombre que ya viene limpio', () => {
    expect(stripOperationPrefix('Fidelity MSCI Japan Index Fund P-ACC-EUR'))
      .toBe('Fidelity MSCI Japan Index Fund P-ACC-EUR');
  });

  it('si el nombre ERA solo la etiqueta, lo devuelve entero en vez de vaciarlo', () => {
    expect(stripOperationPrefix('Suscripción de Fondos')).toBe('Suscripción de Fondos');
  });

  it('tolera vacío y nulo', () => {
    expect(stripOperationPrefix('')).toBe('');
    expect(stripOperationPrefix(null)).toBe('');
  });
});

describe('resolveMissingTickers — el prefijo de la operación no puede impedir el ticker', () => {
  it('resuelve por ISIN curado aunque el nombre llegue con "Suscripcion Iic" delante', async () => {
    const searchFn = vi.fn(async (q) =>
      q === 'IE000QAZP7L2'
        ? [{ symbol: '0P0001XF3Z.F', description: 'iShares EmergMkts Idx (IE) S Acc EUR', type: 'MUTUALFUND' }]
        : []
    );
    const rows = await resolveMissingTickers(
      [buyRow({ ticker: null, assetName: 'Suscripcion Iic ISHARES EMERGING MARKETS INDEX', currency: 'EUR' })],
      searchFn, { pauseMs: 0 }
    );
    expect(rows[0].ticker).toBe('0P0001XF3Z.F');
    expect(searchFn).toHaveBeenCalledWith('IE000QAZP7L2');
  });

  it('publica el nombre ya limpio, para que la posición no se llame "Suscripción Fondos…"', async () => {
    const searchFn = vi.fn().mockResolvedValue([]);
    const rows = await resolveMissingTickers(
      [buyRow({ ticker: null, assetName: 'Suscripción Fondos de Inversión Fidelity MSCI Japan Index Fund P-ACC-EUR', currency: 'EUR' })],
      searchFn, { pauseMs: 0 }
    );
    expect(rows[0].assetName).toBe('Fidelity MSCI Japan Index Fund P-ACC-EUR');
  });
});
