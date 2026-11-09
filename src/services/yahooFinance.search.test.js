import { describe, it, expect } from 'vitest';
import { mapYahooSearchResponse } from './yahooFinance';

// Formas reales de /v1/finance/search y /v1/finance/lookup (proxy de dev, 2026-10-15).
const SEARCH = {
  quotes: [
    {
      exchange: 'FRA', shortname: '0P0000CV2T.F', quoteType: 'MUTUALFUND', symbol: '0P0000CV2T.F',
      typeDisp: 'Fund', longname: 'Vanguard 20+ Yr € Trs Idx € Acc', exchDisp: 'Frankfurt', isYahooFinance: true,
    },
    { exchange: 'NMS', shortname: 'Apple Inc.', quoteType: 'EQUITY', symbol: 'AAPL', exchDisp: 'NASDAQ', isYahooFinance: true },
    { index: 'quotes', name: 'Sin símbolo (p. ej. una empresa de Crunchbase)', isYahooFinance: false },
  ],
  news: [],
};

const LOOKUP = {
  finance: {
    result: [{
      documents: [
        { symbol: 'AAPL', quoteType: 'equity', exchange: 'NMS', shortName: 'Apple Inc.' },
        { symbol: 'AAPU', quoteType: 'etf', exchange: 'NGM', shortName: 'Direxion Daily AAPL Bull 2X' },
      ],
    }],
    error: null,
  },
};

describe('mapYahooSearchResponse', () => {
  it('mapea /search con el nombre largo y el mercado legible', () => {
    const [fund, apple] = mapYahooSearchResponse(SEARCH);
    expect(fund).toMatchObject({
      symbol: '0P0000CV2T.F',
      description: 'Vanguard 20+ Yr € Trs Idx € Acc',
      type: 'MUTUALFUND',
      exchange: 'FRA',
      exchangeName: 'Frankfurt',
    });
    expect(apple.exchangeName).toBe('NASDAQ');
  });

  it('descarta las filas que no son cotizaciones (sin símbolo)', () => {
    expect(mapYahooSearchResponse(SEARCH)).toHaveLength(2);
  });

  it('entiende la forma de /lookup (finance.result[0].documents) con el tipo en mayúsculas', () => {
    const out = mapYahooSearchResponse(LOOKUP);
    expect(out.map((r) => r.symbol)).toEqual(['AAPL', 'AAPU']);
    expect(out[0]).toMatchObject({ description: 'Apple Inc.', type: 'EQUITY', exchange: 'NMS' });
    expect(out[1].type).toBe('ETF');
  });

  it('una respuesta vacía o de error da []', () => {
    expect(mapYahooSearchResponse({ finance: { result: null, error: { code: 'Bad Request' } } })).toEqual([]);
    expect(mapYahooSearchResponse({})).toEqual([]);
    expect(mapYahooSearchResponse(null)).toEqual([]);
  });
});
