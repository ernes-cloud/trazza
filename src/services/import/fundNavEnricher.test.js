import { describe, it, expect, vi } from 'vitest';
import { enrichFundRows, fundNameMatches, expandAbbreviations, curatedIsinForFundName, resolveFundSymbol, curatedSymbolForFundName } from './fundNavEnricher';

// Enriquecimiento de fondos MyInvestor (filas noQuote: cantidad monetaria, sin
// ISIN): resolver el nombre en Yahoo → NAV histórico en la fecha de compra →
// participaciones reales. Si CUALQUIER paso no da confianza, la fila queda
// intacta (representación monetaria) — nunca se adivina.

const fundBuy = (over = {}) => ({
  fecha: '15-06-2026',
  hora: '00:00',
  type: 'BUY',
  producto: 'ISHARES US INDEX FUND IE EUR',
  isin: '',
  cantidad: 100.64,
  precio: 1,
  total: -100.64,
  moneda: 'EUR',
  comisiones: 0,
  noQuote: true,
  ...over,
});

const NAV_SERIES = [
  { time: '2026-06-12', close: 24.9 },
  { time: '2026-06-15', close: 25.16 },
  { time: '2026-06-16', close: 25.3 },
];

const okDeps = () => ({
  searchTickers: vi.fn().mockResolvedValue([
    { symbol: '0P0000TEST.IR', description: 'iShares US Index Fund (IE) Institutional S Acc EUR', type: 'MUTUALFUND' },
  ]),
  getHistoricalData: vi.fn().mockResolvedValue(NAV_SERIES),
  getQuote: vi.fn().mockResolvedValue({ currency: 'EUR', current: 25.4 }),
  pauseMs: 0, // sin pacing anti-throttle en tests
});

describe('fundNameMatches — validación de coincidencia de nombre', () => {
  it('exige la marca (primer token) y la mayoría del resto', () => {
    expect(fundNameMatches('ISHARES US INDEX FUND IE EUR', 'iShares US Index Fund (IE) Inst Acc EUR')).toBe(true);
    // marca distinta → rechazo aunque el resto coincida
    expect(fundNameMatches('VANGUARD US GOVERNMENT BD INDE', 'iShares US Government Bond Index')).toBe(false);
    // tokens numéricos son obligatorios
    expect(fundNameMatches('VANGUARD 20', 'Vanguard LifeStrategy 20% Equity UCITS ETF')).toBe(true);
    expect(fundNameMatches('VANGUARD 20', 'Vanguard LifeStrategy 80% Equity UCITS ETF')).toBe(false);
  });
});

describe('enrichFundRows', () => {
  it('resuelve el fondo y reconstruye participaciones desde el NAV de la fecha', async () => {
    const deps = okDeps();
    const { rows, tickerMap, resolved } = await enrichFundRows([fundBuy()], deps);

    const row = rows[0];
    // NAV del 15-06 = 25.16 → precio escala 2, unidades = 100.64 / 25.16 = 4
    expect(row.precio).toBe(25.16);
    expect(row.cantidad).toBeCloseTo(4, 4);
    expect(row.displayTicker).toBe('0P0000TEST.IR');
    expect(row.noQuote).toBeUndefined();
    expect(row.total).toBe(-100.64); // el importe de caja NO cambia
    expect(tickerMap['ISHARES US INDEX FUND IE EUR']).toBe('0P0000TEST.IR');
    expect(resolved).toBe(1);
  });

  it('sin NAV cerca de la fecha (±7 días) → monetaria Y SIN entrada en tickerMap', async () => {
    // Regresión: registrar el símbolo de una fila que queda monetaria haría
    // que el refresco de precios pusiera un NAV real sobre cantidades en EUR.
    const deps = okDeps();
    deps.getHistoricalData.mockResolvedValue([{ time: '2026-01-02', close: 20 }]);
    const { rows, resolved, tickerMap } = await enrichFundRows([fundBuy()], deps);
    expect(rows[0]).toMatchObject({ cantidad: 100.64, precio: 1, noQuote: true });
    expect(resolved).toBe(0);
    expect(tickerMap).toEqual({});
  });

  it('salta candidatos sin histórico útil (listados ETF con 1 punto) hacia la serie NAV 0P*', async () => {
    const deps = okDeps();
    deps.searchTickers.mockResolvedValue([
      { symbol: 'FEP5.MU', description: 'iShares US Index Fund (IE)', type: 'ETF' },
      { symbol: '0P0000TEST.IR', description: 'iShares US Index Fund (IE)', type: 'MUTUALFUND' },
    ]);
    deps.getHistoricalData.mockImplementation(async (sym) =>
      sym === '0P0000TEST.IR' ? NAV_SERIES : [{ time: '2026-07-03', close: 10.27 }]);
    const { rows, resolved } = await enrichFundRows([fundBuy()], deps);
    expect(resolved).toBe(1);
    expect(rows[0].displayTicker).toBe('0P0000TEST.IR');
    expect(rows[0].precio).toBe(25.16);
  });

  it('solo acepta candidatos MUTUALFUND/ETF, nunca EQUITY', async () => {
    const deps = okDeps();
    deps.searchTickers.mockResolvedValue([
      { symbol: 'ISH', description: 'iShares US Index Fund IE S EUR Corp', type: 'EQUITY' },
    ]);
    const { rows } = await enrichFundRows([fundBuy()], deps);
    expect(rows[0]).toMatchObject({ precio: 1, noQuote: true });
  });

  it('nombre que no valida → monetaria (no se adivina)', async () => {
    const deps = okDeps();
    deps.searchTickers.mockResolvedValue([
      { symbol: '0P0000ZZZZ.IR', description: 'Fidelity Global Dividend Fund', type: 'MUTUALFUND' },
    ]);
    const { rows, resolved } = await enrichFundRows([fundBuy()], deps);
    expect(rows[0].noQuote).toBe(true);
    expect(resolved).toBe(0);
  });

  it('errores de red en búsqueda o histórico → monetaria, sin lanzar', async () => {
    const deps = okDeps();
    deps.searchTickers.mockRejectedValue(new Error('429'));
    const { rows } = await enrichFundRows([fundBuy()], deps);
    expect(rows[0]).toMatchObject({ precio: 1, noQuote: true });
  });

  it('fondos MyInvestor con ISIN curado: resuelven por ISIN aunque Yahoo abrevie el nombre', async () => {
    // "iShares EmergMkts Idx" no pasa la validación por tokens del nombre,
    // pero la búsqueda por ISIN identifica la clase exacta → basta tipo+divisa.
    // Desde 2026-10-03 el fondo tiene además símbolo curado (clase S): aquí su
    // primera cotización FALLA (un 429 transitorio), para probar que la vía
    // ISIN sigue siendo el respaldo y llega a la MISMA clase.
    const deps = okDeps();
    let primera = true;
    deps.getQuote.mockImplementation(async () => {
      if (primera) { primera = false; throw new Error('429'); }
      return { currency: 'EUR', current: 14.33 };
    });
    deps.searchTickers.mockImplementation(async (q) =>
      q === 'IE000QAZP7L2'
        ? [{ symbol: '0P0001XF3Z.F', description: 'iShares EmergMkts Idx (IE) S Acc EUR', type: 'MUTUALFUND' }]
        : []
    );
    const { rows, resolved } = await enrichFundRows(
      [fundBuy({ producto: 'ISHARES EMERGING MARKETS INDEX', cantidad: 23.68, total: -23.68 })],
      deps
    );
    expect(resolved).toBe(1);
    expect(rows[0].displayTicker).toBe('0P0001XF3Z.F');
    expect(deps.searchTickers).toHaveBeenCalledWith('IE000QAZP7L2');
  });

  it('iShares Emerging Markets: el símbolo curado (clase S) va primero y no busca', async () => {
    const deps = okDeps();
    const { rows, resolved } = await enrichFundRows(
      [fundBuy({ producto: 'ISHARES EMERGING MARKETS INDEX', cantidad: 23.68, total: -23.68 })],
      deps
    );
    expect(resolved).toBe(1);
    expect(rows[0].displayTicker).toBe('0P0001XF3Z.F');
    expect(deps.searchTickers).not.toHaveBeenCalled();
  });

  it('la vía ISIN mantiene los guards: divisa del quote y cobertura del histórico', async () => {
    const deps = okDeps();
    deps.searchTickers.mockResolvedValue([
      { symbol: '0P0001DCMP', description: 'iShares Em Mkts Govt Bd Idx (LU) D2', type: 'MUTUALFUND' },
    ]);
    deps.getQuote.mockResolvedValue({ currency: 'USD' }); // clase USD → rechazo
    const { rows, resolved } = await enrichFundRows(
      [fundBuy({ producto: 'ISHARES EMERGING MARKETS INDEX', cantidad: 23.68, total: -23.68 })],
      deps
    );
    expect(resolved).toBe(0);
    expect(rows[0]).toMatchObject({ precio: 1, noQuote: true });
  });

  it('fallback EODHD: cuando Yahoo no tiene la clase EUR, resuelve por ISIN en EODHD', async () => {
    // 'FIDELITY MSCI PACFC EXJAPN IDX' está curado (IE00BDZVHT63) pero Yahoo
    // solo tiene la clase USD → EODHD (que sí reporta divisa en la búsqueda)
    // aporta la serie NAV de la clase EUR.
    const deps = okDeps();
    deps.searchTickers.mockResolvedValue([]); // Yahoo sin resultados
    deps.eodhdSearchTickers = vi.fn().mockResolvedValue([
      { symbol: 'IE00BDZVHT63', displaySymbol: 'IE00BDZVHT63.EUFUND', description: 'Fidelity MSCI Pacific ex Japan Index Fund P-ACC-EUR', type: 'FUND', exchange: 'EUFUND', currency: 'EUR' },
    ]);
    deps.eodhdGetHistory = vi.fn().mockResolvedValue(NAV_SERIES);
    const { rows, resolved, tickerMap } = await enrichFundRows(
      [fundBuy({ producto: 'FIDELITY MSCI PACFC EXJAPN IDX', cantidad: 5.96, total: -5.96, fecha: '15-06-2026' })],
      deps
    );
    expect(resolved).toBe(1);
    expect(rows[0].displayTicker).toBe('IE00BDZVHT63.EUFUND');
    expect(rows[0].precio).toBe(25.16);
    expect(rows[0].cantidad).toBeCloseTo(5.96 / 25.16, 4);
    expect(tickerMap['FIDELITY MSCI PACFC EXJAPN IDX']).toBe('IE00BDZVHT63.EUFUND');
    expect(deps.eodhdSearchTickers).toHaveBeenCalledWith('IE00BDZVHT63');
  });

  it('fallback EODHD respeta la divisa: clase USD → monetario', async () => {
    const deps = okDeps();
    deps.searchTickers.mockResolvedValue([]);
    deps.eodhdSearchTickers = vi.fn().mockResolvedValue([
      { symbol: 'X', displaySymbol: 'X.EUFUND', description: 'Fidelity Pacific USD', type: 'FUND', exchange: 'EUFUND', currency: 'USD' },
    ]);
    deps.eodhdGetHistory = vi.fn();
    const { rows, resolved } = await enrichFundRows(
      [fundBuy({ producto: 'FIDELITY MSCI PACFC EXJAPN IDX', cantidad: 5.96, total: -5.96 })],
      deps
    );
    expect(resolved).toBe(0);
    expect(rows[0]).toMatchObject({ precio: 1, noQuote: true });
    expect(deps.eodhdGetHistory).not.toHaveBeenCalled();
  });

  it('sin deps EODHD (usuario sin key) → se comporta como antes', async () => {
    const deps = okDeps();
    deps.searchTickers.mockResolvedValue([]);
    const { rows, resolved } = await enrichFundRows(
      [fundBuy({ producto: 'FIDELITY MSCI PACFC EXJAPN IDX', cantidad: 5.96, total: -5.96 })],
      deps
    );
    expect(resolved).toBe(0);
    expect(rows[0]).toMatchObject({ precio: 1, noQuote: true });
  });

  it('EODHD solo se consulta para fondos con ISIN curado', async () => {
    const deps = okDeps();
    deps.searchTickers.mockResolvedValue([]);
    deps.eodhdSearchTickers = vi.fn();
    deps.eodhdGetHistory = vi.fn();
    await enrichFundRows([fundBuy({ producto: 'FONDO DESCONOCIDO GLOBAL' })], deps);
    expect(deps.eodhdSearchTickers).not.toHaveBeenCalled();
  });

  it('tier proxy USD: sin clase EUR en ningún proveedor, usa la clase USD + FX histórico', async () => {
    // BGIF solo existe en Yahoo como clase USD (0P0001DCMP). Unidades =
    // importe / (NAV_USD / EURUSD): 14.8 / (11.0 / 1.10) = 14.8 / 10 = 1.48.
    const deps = okDeps();
    deps.searchTickers.mockResolvedValue([]); // Yahoo por nombre: nada
    deps.getQuote.mockResolvedValue({ currency: 'USD', current: 11.2 });
    deps.getHistoricalData.mockImplementation(async (sym) =>
      sym === 'EURUSD=X'
        ? [{ time: '2026-06-15', close: 1.10 }]
        : [{ time: '2026-06-15', close: 11.0 }]);
    const { rows, resolved, tickerMap } = await enrichFundRows(
      [fundBuy({ producto: 'BGIF EM MKT GOVER BOND INDEX D', cantidad: 14.8, total: -14.8 })],
      deps
    );
    expect(resolved).toBe(1);
    expect(rows[0]).toMatchObject({ precio: 10, displayTicker: '0P0001DCMP' });
    expect(rows[0].cantidad).toBeCloseTo(1.48, 4);
    expect(rows[0].total).toBe(-14.8); // el impacto de caja EUR no cambia
    expect(tickerMap['BGIF EM MKT GOVER BOND INDEX D']).toBe('0P0001DCMP');
  });

  it('tier proxy USD: si el símbolo proxy no cotiza en USD → monetario (sanidad)', async () => {
    const deps = okDeps();
    deps.searchTickers.mockResolvedValue([]);
    deps.getQuote.mockResolvedValue({ currency: 'EUR', current: 11.2 }); // inesperado
    const { rows, resolved } = await enrichFundRows(
      [fundBuy({ producto: 'BGIF EM MKT GOVER BOND INDEX D', cantidad: 14.8, total: -14.8 })],
      deps
    );
    expect(resolved).toBe(0);
    expect(rows[0]).toMatchObject({ precio: 1, noQuote: true });
  });

  it('tier proxy USD: sin serie FX utilizable → monetario', async () => {
    const deps = okDeps();
    deps.searchTickers.mockResolvedValue([]);
    deps.getQuote.mockResolvedValue({ currency: 'USD', current: 11.2 });
    deps.getHistoricalData.mockImplementation(async (sym) =>
      sym === 'EURUSD=X' ? [] : [{ time: '2026-06-15', close: 11.0 }]);
    const { rows, resolved } = await enrichFundRows(
      [fundBuy({ producto: 'BGIF EM MKT GOVER BOND INDEX D', cantidad: 14.8, total: -14.8 })],
      deps
    );
    expect(resolved).toBe(0);
    expect(rows[0]).toMatchObject({ precio: 1, noQuote: true });
  });

  it('EODHD (NAV EUR real) tiene prioridad sobre el proxy USD', async () => {
    const deps = okDeps();
    deps.searchTickers.mockResolvedValue([]);
    deps.getQuote.mockResolvedValue({ currency: 'USD', current: 27.1 });
    deps.eodhdSearchTickers = vi.fn().mockResolvedValue([
      { symbol: 'IE00BDZVHT63', displaySymbol: 'IE00BDZVHT63.EUFUND', description: 'Fidelity Pacific ex Japan P-ACC-EUR', type: 'FUND', exchange: 'EUFUND', currency: 'EUR' },
    ]);
    deps.eodhdGetHistory = vi.fn().mockResolvedValue(NAV_SERIES);
    const { rows } = await enrichFundRows(
      [fundBuy({ producto: 'FIDELITY MSCI PACFC EXJAPN IDX', cantidad: 5.96, total: -5.96, fecha: '15-06-2026' })],
      deps
    );
    expect(rows[0].displayTicker).toBe('IE00BDZVHT63.EUFUND'); // no el proxy 0P0001COSJ
  });

  it('expande las abreviaturas del broker para buscar y validar', () => {
    expect(expandAbbreviations('BGIF EM MKT GOVER BOND INDEX D'))
      .toBe('blackrock emerging markets government bond index d');
    expect(expandAbbreviations('FIDELITY MSCI PACFC EXJAPN IDX'))
      .toBe('fidelity msci pacific ex japan index');
    // la validación acepta el nombre real completo gracias a la expansión
    expect(fundNameMatches(
      expandAbbreviations('BGIF EM MKT GOVER BOND INDEX D'),
      'BlackRock Global Index Funds - Emerging Markets Government Bond Index Fund'
    )).toBe(true);
  });

  it('verifica la divisa de varios candidatos, no solo el primero', async () => {
    // Las dos primeras clases pasan el nombre pero cotizan en USD;
    // la tercera es la clase EUR correcta.
    const deps = okDeps();
    deps.searchTickers.mockResolvedValue([
      { symbol: '0P0000USD1', description: 'iShares US Index Fund (IE)', type: 'MUTUALFUND' },
      { symbol: '0P0000USD2', description: 'iShares US Index Fund (IE)', type: 'MUTUALFUND' },
      { symbol: '0P0000EUR3.F', description: 'iShares US Index Fund (IE)', type: 'MUTUALFUND' },
    ]);
    deps.getQuote.mockImplementation(async (sym) =>
      sym === '0P0000EUR3.F' ? { currency: 'EUR' } : { currency: 'USD' });
    const { rows, resolved } = await enrichFundRows([fundBuy()], deps);
    expect(resolved).toBe(1);
    expect(rows[0].displayTicker).toBe('0P0000EUR3.F');
  });

  it('reintenta con prefijos del nombre cuando la búsqueda completa devuelve basura', async () => {
    // Yahoo devuelve futuros/divisas para nombres largos truncados; el prefijo
    // de 5 tokens sí encuentra el fondo.
    const deps = okDeps();
    deps.searchTickers.mockImplementation(async (q) =>
      q === 'ishares us index fund ie'
        ? [{ symbol: '0P0000TEST.IR', description: 'iShares US Index Fund (IE) S Acc EUR', type: 'MUTUALFUND' }]
        : [{ symbol: 'SI=F', description: 'Silver Sep 26', type: 'FUTURE' }]
    );
    const { rows, resolved } = await enrichFundRows([fundBuy()], deps);
    expect(resolved).toBe(1);
    expect(rows[0].displayTicker).toBe('0P0000TEST.IR');
  });

  it('rechaza clases del fondo en OTRA divisa (por nombre y por quote)', async () => {
    // Yahoo lista una clase por divisa (PLN/USD/EUR) con NAVs distintos —
    // elegir la clase equivocada corrompería las unidades.
    const deps = okDeps();
    deps.searchTickers.mockResolvedValue([
      { symbol: '0P0001PLN.WA', description: 'iShares US Index Fund IE S PLN Acc', type: 'MUTUALFUND' },
    ]);
    const byName = await enrichFundRows([fundBuy()], deps);
    expect(byName.rows[0]).toMatchObject({ precio: 1, noQuote: true });

    // divisa correcta en el nombre pero el quote real cotiza en USD → rechazo
    const deps2 = okDeps();
    deps2.getQuote.mockResolvedValue({ currency: 'USD', current: 27.1 });
    const byQuote = await enrichFundRows([fundBuy()], deps2);
    expect(byQuote.rows[0]).toMatchObject({ precio: 1, noQuote: true });
  });

  it('varias compras del mismo fondo comparten búsqueda pero usan el NAV de su fecha', async () => {
    const deps = okDeps();
    const { rows } = await enrichFundRows([
      fundBuy(),
      fundBuy({ fecha: '16-06-2026', cantidad: 50.6, total: -50.6 }),
    ], deps);
    expect(deps.searchTickers).toHaveBeenCalledTimes(1);
    expect(rows[0].precio).toBe(25.16);
    expect(rows[1].precio).toBe(25.3);
    expect(rows[1].cantidad).toBeCloseTo(2, 4);
  });

  it('las filas sin noQuote (TRANSFER/CASH) no se tocan', async () => {
    const deps = okDeps();
    const transfer = { fecha: '14-06-2026', type: 'TRANSFER', total: 207.49, moneda: 'EUR' };
    const { rows } = await enrichFundRows([transfer, fundBuy()], deps);
    expect(rows[0]).toEqual(transfer);
    expect(deps.searchTickers).toHaveBeenCalledTimes(1);
  });

  it('filas con unidades ya reales (precio ≠ 1) solo reciben el ticker, no se recalculan', async () => {
    const deps = okDeps();
    const withUnits = fundBuy({ cantidad: 2, precio: 14.21, total: -28.42 });
    const { rows } = await enrichFundRows([withUnits], deps);
    expect(rows[0]).toMatchObject({ cantidad: 2, precio: 14.21, displayTicker: '0P0000TEST.IR' });
    expect(rows[0].noQuote).toBeUndefined();
  });

  it('cobertura parcial de NAV en un fondo multi-compra → TODO el fondo queda monetario', async () => {
    // Enriquecer solo una de las dos compras mezclaría unidades reales con
    // cantidades en EUR dentro de la misma posición.
    const deps = okDeps();
    const { rows, tickerMap, resolved } = await enrichFundRows([
      fundBuy(),
      fundBuy({ fecha: '01-03-2026', cantidad: 30, total: -30 }), // sin NAV en la serie
    ], deps);
    expect(resolved).toBe(0);
    expect(tickerMap).toEqual({});
    expect(rows[0]).toMatchObject({ precio: 1, noQuote: true });
    expect(rows[1]).toMatchObject({ precio: 1, noQuote: true });
  });

  it('fondo con filas "@ unidades" y monetarias SIN resolución → las "@" se degradan a monetario', async () => {
    const deps = okDeps();
    deps.searchTickers.mockResolvedValue([]); // irresoluble
    const { rows } = await enrichFundRows([
      fundBuy({ cantidad: 0.21, precio: 135.33, total: -28.42 }), // "@ units" del parser
      fundBuy({ fecha: '16-06-2026', cantidad: 50, total: -50 }),  // monetaria
    ], deps);
    expect(rows[0]).toMatchObject({ cantidad: 28.42, precio: 1, noQuote: true });
    expect(rows[1]).toMatchObject({ cantidad: 50, precio: 1, noQuote: true });
  });

  it('un SELL enriquecido conserva el total positivo', async () => {
    const deps = okDeps();
    const sell = fundBuy({ type: 'SELL', cantidad: 50.32, total: 50.32 });
    const { rows } = await enrichFundRows([sell], deps);
    expect(rows[0]).toMatchObject({ type: 'SELL', precio: 25.16, total: 50.32 });
    expect(rows[0].cantidad).toBeCloseTo(2, 4);
  });
});

describe('determinismo en re-imports — knownSymbols (ticker_map persistido)', () => {
  it('un nombre ya resuelto reutiliza SU símbolo sin buscar (misma clase → mismas filas → dedupe)', async () => {
    // La búsqueda de Yahoo puede devolver OTRA clase EUR del mismo fondo en el
    // re-import → qty/precio distintos → el dedupe no coincide → duplicados.
    const deps = okDeps();
    deps.knownSymbols = { 'ISHARES US INDEX FUND IE EUR': '0P0000TEST.IR' };
    const { rows, resolved } = await enrichFundRows([fundBuy()], deps);
    expect(resolved).toBe(1);
    expect(rows[0].displayTicker).toBe('0P0000TEST.IR');
    expect(rows[0].precio).toBe(25.16);
    expect(deps.searchTickers).not.toHaveBeenCalled();
  });

  it('símbolo conocido muerto (sin quote) → cae a la resolución normal', async () => {
    const deps = okDeps();
    deps.knownSymbols = { 'ISHARES US INDEX FUND IE EUR': '0P000DEAD.F' };
    deps.getQuote.mockImplementation(async (sym) => {
      if (sym === '0P000DEAD.F') throw new Error('404');
      return { currency: 'EUR', current: 25.4 };
    });
    const { rows, resolved } = await enrichFundRows([fundBuy()], deps);
    expect(resolved).toBe(1);
    expect(rows[0].displayTicker).toBe('0P0000TEST.IR'); // vía búsqueda normal
  });
});

describe('curatedIsinForFundName — el ISIN curado no puede saltar de fondo', () => {
  it('resuelve el nombre COMPLETO contra la clave truncada del extracto', () => {
    // La clave curada es 'FIDELITY MSCI JAPAN INDEX P AC'; desde la pantalla de
    // órdenes el mismo fondo llega con su nombre entero.
    expect(curatedIsinForFundName('Fidelity MSCI Japan Index Fund P-ACC-EUR')).toBe('IE00BYX5N771');
    expect(curatedIsinForFundName('Fidelity MSCI Europe Index Fund P-ACC-EUR')).toBe('IE00BYX5MD61');
    expect(curatedIsinForFundName('Vanguard US Government Bond Index Fund EUR Hedged')).toBe('IE0007471471');
  });

  it('NO le da a un "ex-Japan" el ISIN del fondo de Japón', () => {
    // Regresión real: el matcher difuso contaba "japan" como acierto aunque el
    // nombre lo EXCLUYA, y los dos fondos acababan con el mismo ticker — es
    // decir, uno de ellos valorado con el NAV del otro.
    const pacifico = curatedIsinForFundName('Fidelity MSCI Pacific ex-Japan Index Fund P-ACC-USD');
    expect(pacifico).not.toBe('IE00BYX5N771');
  });

  it('la clave exacta del extracto sigue funcionando', () => {
    expect(curatedIsinForFundName('FIDELITY MSCI PACFC EXJAPN IDX')).toBe('IE00BDZVHT63');
    // Clase S Acc EUR desde 2026-10-03 (antes IE00BYWYCC39, la clase D)
    expect(curatedIsinForFundName('ISHARES EMERGING MARKETS INDEX')).toBe('IE000QAZP7L2');
  });

  it('un fondo desconocido no se cuela', () => {
    expect(curatedIsinForFundName('Amundi MSCI World UCITS ETF')).toBeNull();
    expect(curatedIsinForFundName('')).toBeNull();
    expect(curatedIsinForFundName(null)).toBeNull();
  });
});

describe('clase de participación — el mismo fondo con NAV distinto', () => {
  // Caso real: "VANGUARD 20" devuelve de Yahoo la clase Institucional Plus
  // ANTES que la del particular. Las dos son el mismo fondo, pero cotizan a
  // 61,15 € y 125,89 € el mismo día: con la institucional, una posición de
  // 146,77 € se enseñaba como 70,93 €.
  const CLASES = [
    { symbol: '0P00015M0M.F', description: 'Vanguard 20+ Yr € Trs Idx Ins Pl € Acc', type: 'MUTUALFUND' },
    { symbol: '0P0000CV2T.F', description: 'Vanguard 20+ Yr € Trs Idx € Acc', type: 'MUTUALFUND' },
  ];
  const serie = (nav) => [{ time: '2026-07-06', close: nav }, { time: '2026-07-07', close: nav }];

  const deps = {
    pauseMs: 0,
    searchTickers: async () => CLASES,
    getQuote: async () => ({ currency: 'EUR' }),
    getHistoricalData: async (s) => serie(s === '0P0000CV2T.F' ? 135.1 : 61.15),
  };

  it('elige la clase del particular, no la institucional', async () => {
    const fila = {
      fecha: '06-07-2026', hora: '00:00', type: 'BUY', producto: 'VANGUARD 20', isin: '',
      cantidad: 98.62, precio: 1, total: -98.62, moneda: 'EUR', comisiones: 0, noQuote: true,
    };
    const { rows, tickerMap } = await enrichFundRows([fila], deps);
    expect(tickerMap['VANGUARD 20']).toBe('0P0000CV2T.F');
    // 98,62 / 135,10 ≈ 0,73 participaciones — lo que dice el propio extracto
    expect(rows[0].cantidad).toBeCloseTo(0.73, 2);
  });
});

describe('iShares US Index de MyInvestor — símbolo curado (2026-10-03)', () => {
  // Por búsqueda no se resolvía nunca y la posición se quedaba en euros
  // invertidos. Yahoo lista varias clases del mismo fondo con NAV distinto;
  // la del extracto es la S Acc EUR.
  const CLASES = [
    { symbol: '0P0001AG9Q', description: 'iShares US Index (IE) D Acc USD', type: 'MUTUALFUND' },
    { symbol: '0P0001XF42.F', description: 'iShares US Index (IE) S Acc EUR', type: 'MUTUALFUND' },
  ];
  const deps = {
    pauseMs: 0,
    searchTickers: async () => CLASES,
    getQuote: async (s) => ({ currency: s === '0P0001XF42.F' ? 'EUR' : 'USD' }),
    getHistoricalData: async () => [{ time: '2026-07-07', close: 12.022 }],
  };

  it('convierte el importe a participaciones con el NAV de la clase S Acc EUR', async () => {
    const fila = {
      fecha: '07-07-2026', hora: '00:00', type: 'BUY', producto: 'ISHARES US INDEX FUND IE S EUR', isin: '',
      cantidad: 338.3, precio: 1, total: -338.3, moneda: 'EUR', comisiones: 0, noQuote: true,
    };
    const { rows, tickerMap } = await enrichFundRows([fila], deps);
    expect(tickerMap['ISHARES US INDEX FUND IE S EUR']).toBe('0P0001XF42.F');
    expect(rows[0].noQuote).toBeUndefined();
    // El precio va a escala 2 (como transactions.price) y las participaciones
    // salen de ese precio: 338,30 / 12,02 ≈ 28,14
    expect(rows[0].precio).toBe(12.02);
    expect(rows[0].cantidad).toBeCloseTo(338.3 / 12.02, 4);
  });

  it('el refresco de precios lo cotiza con ese mismo símbolo', () => {
    expect(curatedSymbolForFundName('ISHARES US INDEX FUND IE S EUR (EUR)')).toBe('0P0001XF42.F');
  });
});

describe('curatedIsinForFundName — un nombre sin palabras propias no identifica nada', () => {
  it('NO le da el ISIN del Emerging Markets al iShares US Index', () => {
    // Caso real: "ISHARES US INDEX FUND IE S EUR" no aporta ni una palabra
    // discriminante ("us"/"ie"/"s" son cortas, "index"/"fund" genéricas, "eur"
    // divisa), así que casaba con cualquier fondo de la casa y se llevaba el
    // ISIN del iShares Emerging Markets — otro fondo, −42% de valor.
    // Desde 2026-10-03 el nombre exacto tiene SU entrada curada (verificada en
    // Yahoo): resuelve a su propio ISIN, nunca al de otro fondo.
    const isin = curatedIsinForFundName('ISHARES US INDEX FUND IE S EUR');
    expect(isin).not.toBe('IE000QAZP7L2');
    expect(isin).toBe('IE000N4ZYX28');
  });

  it('la clave del US Index no captura por similitud a otros fondos de iShares', () => {
    // Sin palabras discriminantes, la clave nunca puede casar en difuso: un
    // fondo de la casa que no esté en la lista sigue sin resolverse.
    expect(curatedIsinForFundName('ISHARES EUROPE INDEX FUND IE')).toBeNull();
    expect(curatedIsinForFundName('ISHARES JAPAN INDEX FUND IE D EUR')).toBeNull();
  });

  it('sigue resolviendo los que SÍ traen una palabra propia', () => {
    expect(curatedIsinForFundName('Fidelity MSCI Japan Index Fund P-ACC-EUR')).toBe('IE00BYX5N771');
    expect(curatedIsinForFundName('Vanguard US Government Bond Index Fund EUR Hedged')).toBe('IE0007471471');
  });
});

describe('resolveFundSymbol — volver a resolver un fondo ya importado', () => {
  const deps = (resultados, precios) => ({
    pauseMs: 0,
    currency: 'EUR',
    searchTickers: async () => resultados,
    getQuote: async (s) => precios[s] || null,
  });

  it('prefiere la clase del particular a la institucional', async () => {
    const r = await resolveFundSymbol('VANGUARD 20', deps(
      [
        { symbol: '0P00015M0M.F', description: 'Vanguard 20+ Yr € Trs Idx Ins Pl € Acc', type: 'MUTUALFUND' },
        { symbol: '0P0000CV2T.F', description: 'Vanguard 20+ Yr € Trs Idx € Acc', type: 'MUTUALFUND' },
      ],
      { '0P00015M0M.F': { price: 61.15, currency: 'EUR' }, '0P0000CV2T.F': { price: 125.89, currency: 'EUR' } }
    ));
    expect(r.symbol).toBe('0P0000CV2T.F');
  });

  it('devuelve null antes que adivinar, si nada encaja', async () => {
    const r = await resolveFundSymbol('ISHARES US INDEX FUND IE S EUR', deps(
      [{ symbol: 'BTC-USD', description: 'Bitcoin USD', type: 'CRYPTOCURRENCY' }],
      { 'BTC-USD': { price: 60000, currency: 'USD' } }
    ));
    expect(r).toBeNull();
  });

  it('rechaza un símbolo que no cotiza en la divisa de la posición', async () => {
    const r = await resolveFundSymbol('FIDELITY MSCI JAPAN INDEX P AC', deps(
      [{ symbol: '0P0000XXXX.F', description: 'Fidelity MSCI Japan Index Fund P-ACC-USD', type: 'MUTUALFUND' }],
      { '0P0000XXXX.F': { price: 10, currency: 'USD' } }
    ));
    expect(r).toBeNull();
  });

  it('no explota sin dependencias', async () => {
    expect(await resolveFundSymbol('X', {})).toBeNull();
    expect(await resolveFundSymbol('', { searchTickers: async () => [], getQuote: async () => null })).toBeNull();
  });
});

describe('precedencia: lo curado manda sobre lo persistido', () => {
  it('un símbolo curado gana al que quedó guardado de un import anterior', async () => {
    // Éste era el fallo que hacía el error PERMANENTE: knownSymbols (el mapa
    // persistido) se comprobaba primero, así que la clase institucional mal
    // resuelta se reinyectaba en cada reimport y nunca se corregía.
    const serie = (nav) => [{ time: '2026-07-06', close: nav }, { time: '2026-07-07', close: nav }];
    const { rows, tickerMap } = await enrichFundRows(
      [{
        fecha: '06-07-2026', hora: '00:00', type: 'BUY', producto: 'VANGUARD 20', isin: '',
        cantidad: 98.62, precio: 1, total: -98.62, moneda: 'EUR', comisiones: 0, noQuote: true,
      }],
      {
        pauseMs: 0,
        knownSymbols: { 'VANGUARD 20': '0P00015M0M.F' }, // la clase institucional, mal
        searchTickers: async () => [],
        getQuote: async () => ({ currency: 'EUR' }),
        getHistoricalData: async (s) => serie(s === '0P0000CV2T.F' ? 135.1 : 61.15),
      }
    );
    expect(tickerMap['VANGUARD 20']).toBe('0P0000CV2T.F');
    expect(rows[0].cantidad).toBeCloseTo(0.73, 2);
  });

  it('sin símbolo curado, el persistido sigue mandando (determinismo del reimport)', async () => {
    const serie = [{ time: '2026-07-06', close: 10 }, { time: '2026-07-07', close: 10 }];
    const { tickerMap } = await enrichFundRows(
      [{
        fecha: '06-07-2026', hora: '00:00', type: 'BUY', producto: 'FONDO SIN CURAR', isin: '',
        cantidad: 100, precio: 1, total: -100, moneda: 'EUR', comisiones: 0, noQuote: true,
      }],
      {
        pauseMs: 0,
        knownSymbols: { 'FONDO SIN CURAR': '0P0000AAAA.F' },
        searchTickers: async () => [],
        getQuote: async () => ({ currency: 'EUR' }),
        getHistoricalData: async () => serie,
      }
    );
    expect(tickerMap['FONDO SIN CURAR']).toBe('0P0000AAAA.F');
  });

  it('curatedSymbolForFundName tolera el sufijo de divisa del activo guardado', () => {
    expect(curatedSymbolForFundName('VANGUARD 20 (EUR)')).toBe('0P0000CV2T.F');
    expect(curatedSymbolForFundName('VANGUARD 20')).toBe('0P0000CV2T.F');
    expect(curatedSymbolForFundName('CUALQUIER OTRO')).toBeNull();
  });
});

describe('iShares ESG Screened Global Corp — clase EUR cubierta (2026-10-03)', () => {
  // Se valoraba con la clase USD + tipo de cambio: un movimiento de divisa que
  // un fondo cubierto no tiene. MyInvestor muestra el NAV de la EUR Hedged.
  it('resuelve por su símbolo curado, sin pasar por el proxy USD', async () => {
    const deps = {
      pauseMs: 0,
      searchTickers: vi.fn().mockResolvedValue([]),
      getQuote: vi.fn(async (s) => ({ currency: s === '0P0001JAFO.F' ? 'EUR' : 'USD' })),
      getHistoricalData: vi.fn(async () => [{ time: '2026-07-07', close: 9.725 }]),
    };
    const fila = {
      fecha: '07-07-2026', hora: '00:00', type: 'BUY', producto: 'ISHARES ESG SCREENED GLB CORP', isin: '',
      cantidad: 75.12, precio: 1, total: -75.12, moneda: 'EUR', comisiones: 0, noQuote: true,
    };
    const { rows, tickerMap } = await enrichFundRows([fila], deps);
    expect(tickerMap['ISHARES ESG SCREENED GLB CORP']).toBe('0P0001JAFO.F');
    expect(rows[0].precio).toBe(9.73);
    expect(deps.getQuote).not.toHaveBeenCalledWith('0P0001LKD2');
  });
});

describe('alias de nombre — MyInvestor escribe el mismo fondo de dos formas (2026-10-15)', () => {
  // Reimport real: "ISHARES US INDEX FUND IE S EUR" se convertía a participaciones
  // y "ISHARES US INDEX FUND (IE) - S" (la misma clase S Acc EUR, 0P0001XF42.F)
  // se quedaba en una SEGUNDA posición, en euros: el fondo partido en dos.
  const deps = {
    pauseMs: 0,
    searchTickers: async () => [],
    getQuote: async () => ({ currency: 'EUR' }),
    getHistoricalData: async () => [{ time: '2026-09-15', close: 12.5 }],
  };
  const fila = (producto, total) => ({
    fecha: '15-09-2026', hora: '00:00', type: 'BUY', producto, isin: '',
    cantidad: Math.abs(total), precio: 1, total, moneda: 'EUR', comisiones: 0, noQuote: true,
  });

  it('las dos grafías acaban en el MISMO fondo, convertido con la clase curada', async () => {
    const { rows, tickerMap } = await enrichFundRows(
      [fila('ISHARES US INDEX FUND IE S EUR', -100), fila('ISHARES US INDEX FUND (IE) - S', -75)], deps);
    expect(rows.map((r) => r.producto)).toEqual(['ISHARES US INDEX FUND IE S EUR', 'ISHARES US INDEX FUND IE S EUR']);
    expect(rows.every((r) => r.displayTicker === '0P0001XF42.F' && r.noQuote === undefined)).toBe(true);
    expect(tickerMap).toEqual({ 'ISHARES US INDEX FUND IE S EUR': '0P0001XF42.F' });
  });

  it('si no se puede convertir, la variante tampoco abre una posición aparte', async () => {
    const { rows } = await enrichFundRows([fila('ISHARES US INDEX FUND (IE) - S', -75)], { ...deps, getHistoricalData: async () => [] });
    expect(rows[0]).toMatchObject({ producto: 'ISHARES US INDEX FUND IE S EUR', precio: 1, noQuote: true });
  });

  it('el refresco de precios cotiza también el nombre de la variante', () => {
    expect(curatedSymbolForFundName('ISHARES US INDEX FUND (IE) - S [importe] (EUR)')).toBe('0P0001XF42.F');
  });
});
