import { describe, it, expect } from 'vitest';
import { resolveQuoteSymbol, isQuotableSymbol, mergeTickerMaps } from './quoteSymbol';
import { groupInvestedByTicker } from './dashboardTotals';

describe('resolveQuoteSymbol', () => {
  it('un fondo curado de MyInvestor se cotiza con su símbolo, no con su nombre', () => {
    expect(resolveQuoteSymbol('VANGUARD 20 (EUR)')).toBe('0P0000CV2T.F');
  });

  it('un fondo resuelto en el import usa el ticker_map persistido', () => {
    const map = { 'FIDELITY MSCI EUROPE INDEX P A': '0P0000YXKB.F' };
    expect(resolveQuoteSymbol('FIDELITY MSCI EUROPE INDEX P A (EUR)', map)).toBe('0P0000YXKB.F');
  });

  it('un fondo monetario [importe] no se cotiza nunca, aunque su nombre esté curado', () => {
    expect(resolveQuoteSymbol('ISHARES US INDEX FUND IE S EUR [importe] (EUR)')).toBeNull();
  });

  it('un fondo valorado con su proxy USD en el import se sigue cotizando con el proxy', () => {
    // Unidades derivadas del NAV del proxy: cotizar la clase EUR Hedged curada
    // inflaba la posición un +9 % (caso real ESG Screened Glb Corp).
    const map = { 'ISHARES ESG SCREENED GLB CORP': '0P0001LKD2' };
    expect(resolveQuoteSymbol('ISHARES ESG SCREENED GLB CORP (EUR)', map)).toBe('0P0001LKD2');
  });

  it('un símbolo persistido que NO es el proxy no le gana al curado', () => {
    // Clase institucional mal resuelta en un import antiguo: manda lo curado.
    const map = { 'VANGUARD 20': '0P0000XXXX.F' };
    expect(resolveQuoteSymbol('VANGUARD 20 (EUR)', map)).toBe('0P0000CV2T.F');
    expect(resolveQuoteSymbol('ISHARES ESG SCREENED GLB CORP (EUR)')).toBe('0P0001JAFO.F');
  });

  it('una acción normal sigue resolviendo por resolveTicker', () => {
    expect(resolveQuoteSymbol('AAPL (USD)')).toBe('AAPL');
  });

  it('un nombre sin resolver no es cotizable', () => {
    expect(isQuotableSymbol(resolveQuoteSymbol('FONDO RARO SIN MAPA (EUR)'))).toBe(false);
    expect(isQuotableSymbol('0P0000CV2T.F')).toBe(true);
  });

  it('mergeTickerMaps une los mapas de varias filas e ignora las vacías', () => {
    expect(mergeTickerMaps([{ ticker_map: { A: 'X' } }, { ticker_map: null }, { ticker_map: { B: 'Y' } }]))
      .toEqual({ A: 'X', B: 'Y' });
  });
});

describe('groupInvestedByTicker con fondos de MyInvestor', () => {
  it('agrupa por el símbolo cotizable, igual que la pantalla de brokers', () => {
    const groups = groupInvestedByTicker([
      { asset_id: 'a1', quantity: '1.16', assets: { ticker: 'VANGUARD 20 (EUR)', company_name: 'VANGUARD 20', currency: 'EUR' } },
    ]);
    expect(groups[0].ticker).toBe('0P0000CV2T.F');
  });

  it('un fondo monetario queda sin ticker (no se cotiza)', () => {
    const groups = groupInvestedByTicker([
      { asset_id: 'a2', quantity: '503.04', assets: { ticker: 'ISHARES US INDEX FUND IE S EUR [importe] (EUR)', currency: 'EUR' } },
    ]);
    expect(groups[0].ticker).toBeNull();
  });
});
