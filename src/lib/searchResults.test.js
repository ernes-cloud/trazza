import { describe, it, expect } from 'vitest';
import { findMatchRange, resultLabels, rankSearchResults, changeTone, prepareSearchResults, typeLabelKey, portfolioSymbols } from './searchResults';

describe('findMatchRange', () => {
  it('encuentra la coincidencia sin distinguir mayúsculas', () => {
    expect(findMatchRange('Vanguard 20+ Yr', 'VANGUARD 20')).toEqual([0, 11]);
  });

  it('ignora los espacios: "s&p500" resalta "S&P 500"', () => {
    expect(findMatchRange('S&P 500', 's&p500')).toEqual([0, 7]);
  });

  it('y al revés: "s&p 500" resalta "S&P500"', () => {
    const text = 'Direxion Daily S&P500 Bull 3X';
    const [a, b] = findMatchRange(text, 's&p 500');
    expect(text.slice(a, b)).toBe('S&P500');
  });

  it('devuelve null si no hay coincidencia o falta texto', () => {
    expect(findMatchRange('Apple Inc.', 'msft')).toBeNull();
    expect(findMatchRange('', 'a')).toBeNull();
    expect(findMatchRange('Apple', '  ')).toBeNull();
  });
});

describe('resultLabels', () => {
  it('un fondo con símbolo opaco (0P…) se titula con su nombre', () => {
    expect(resultLabels({ symbol: '0P00015M0M.F', description: 'Vanguard 20+ Yr € Trs Idx' }))
      .toEqual({ title: 'Vanguard 20+ Yr € Trs Idx', subtitle: '0P00015M0M.F' });
  });

  it('una acción con ticker legible conserva el ticker como título', () => {
    expect(resultLabels({ symbol: 'SPXL', description: 'Direxion Daily S&P500 Bull 3X Shares' }))
      .toEqual({ title: 'SPXL', subtitle: 'Direxion Daily S&P500 Bull 3X Shares' });
  });

  it('usa displaySymbol cuando existe', () => {
    expect(resultLabels({ symbol: 'X', displaySymbol: 'AAPL', description: 'Apple' }).title).toBe('AAPL');
  });

  it('sin nombre, un símbolo opaco sigue siendo el título (no deja la fila vacía)', () => {
    expect(resultLabels({ symbol: '0P0001UDXF.F', description: '' }).title).toBe('0P0001UDXF.F');
  });
});

describe('rankSearchResults', () => {
  const r = (symbol, description) => ({ symbol, description });

  it('lo que EMPIEZA por la búsqueda va antes de lo que solo la contiene', () => {
    const ranked = rankSearchResults([
      r('0P00015M0M.F', 'Vanguard 20+ Yr € Trs Idx Ins Pl € Acc'),
      r('0P0001UDXF.F', 'Standard Lf Vanguard 20+ Yr Euro Trs Idx'),
      r('0P0000CV2T.T', 'Vanguard 20+ Yr € Trs Idx € Acc'),
    ], 'VANGUARD 20');
    expect(ranked.map((x) => x.symbol)).toEqual(['0P00015M0M.F', '0P0000CV2T.T', '0P0001UDXF.F']);
  });

  it('un símbolo exacto va el primero', () => {
    const ranked = rankSearchResults([r('AAPB', 'GraniteShares 2x Long AAPL'), r('AAPL', 'Apple Inc.')], 'aapl');
    expect(ranked[0].symbol).toBe('AAPL');
  });

  it('mantiene el orden de Yahoo entre empatados y no muta la entrada', () => {
    const input = [r('SPXL', 'Direxion Daily S&P500'), r('UPRO', 'ProShares UltraPro S&P500')];
    const ranked = rankSearchResults(input, 's&p500');
    expect(ranked.map((x) => x.symbol)).toEqual(['SPXL', 'UPRO']);
    expect(ranked).not.toBe(input);
  });
});

describe('changeTone', () => {
  it('distingue subida, bajada y sin cambio', () => {
    expect(changeTone(0.59)).toBe('up');
    expect(changeTone(-0.24)).toBe('down');
    expect(changeTone(0)).toBe('flat');
    expect(changeTone(undefined)).toBe('flat');
  });

  it('un +0,00% redondeado no es una subida', () => {
    expect(changeTone(0.004)).toBe('flat');
  });
});

describe('prepareSearchResults', () => {
  const r = (symbol, description, type = 'EQUITY') => ({ symbol, description, type });

  it('quita símbolos repetidos (Yahoo los duplica a veces y rompen las keys de React)', () => {
    const out = prepareSearchResults([r('AAPL', 'Apple Inc.'), r('AAPL', 'Apple Inc.'), r('AAPL.TO', 'Apple Inc.')], 'apple');
    expect(out.map((x) => x.symbol)).toEqual(['AAPL', 'AAPL.TO']);
  });

  it('descarta filas sin símbolo', () => {
    expect(prepareSearchResults([r('', 'x'), { description: 'y' }, r('MSFT', 'Microsoft')], 'm').map((x) => x.symbol))
      .toEqual(['MSFT']);
  });

  it('futuros y opciones van al final aunque coincidan mejor (respuesta real de "apple")', () => {
    const out = prepareSearchResults([
      r('AAPL', 'Apple Inc.'),
      r('SAAPL=F', 'Apple Inc Single Stock futures', 'FUTURE'),
      r('XAAPL=F', 'Micro Apple Inc Stock Futures,D', 'FUTURE'),
      r('APLE', 'Apple Hospitality REIT, Inc.'),
      r('AAPL.TO', 'Apple Inc.'),
    ], 'apple');
    expect(out.map((x) => x.symbol)).toEqual(['AAPL', 'APLE', 'AAPL.TO', 'SAAPL=F', 'XAAPL=F']);
  });
});

describe('typeLabelKey', () => {
  it('traduce los tipos de Yahoo a claves de search_types', () => {
    expect(typeLabelKey('EQUITY')).toBe('search_types.equity');
    expect(typeLabelKey('mutualfund')).toBe('search_types.fund');
    expect(typeLabelKey('CRYPTOCURRENCY')).toBe('search_types.crypto');
    expect(typeLabelKey('ETF')).toBe('search_types.etf');
  });

  it('un tipo desconocido no tiene clave (se enseña tal cual)', () => {
    expect(typeLabelKey('WARRANT')).toBeNull();
    expect(typeLabelKey(undefined)).toBeNull();
  });
});

describe('portfolioSymbols — para la etiqueta "En cartera"', () => {
  const pos = (ticker, quantity = 1, asset_class = 'Fund') => ({
    quantity,
    assets: { ticker, asset_class },
  });

  it('un fondo guardado por su nombre casa con el símbolo 0P… que devuelve Yahoo', () => {
    // VANGUARD 20 (EUR) de MyInvestor es la clase 0P0000CV2T.F que sale en el buscador
    const set = portfolioSymbols([pos('VANGUARD 20 (EUR)')]);
    expect(set.has('0P0000CV2T.F')).toBe(true);
  });

  it('una acción casa por su ticker tal cual', () => {
    expect(portfolioSymbols([pos('AAPL', 3, 'Stock')]).has('AAPL')).toBe(true);
  });

  it('ni la liquidez ni las posiciones cerradas cuentan', () => {
    const set = portfolioSymbols([pos('CASH_EUR', 100, 'Cash'), pos('MSFT', 0, 'Stock')]);
    expect(set.size).toBe(0);
  });
});
