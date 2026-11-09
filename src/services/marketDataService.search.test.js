import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./yahooFinance', () => ({ yahooFinanceService: { searchTickers: vi.fn() } }));
vi.mock('./eodhd', () => ({ eodhdService: { searchTickers: vi.fn() } }));

import { marketDataService } from './marketDataService';
import { yahooFinanceService } from './yahooFinance';
import { eodhdService } from './eodhd';

const AAPL = [{ symbol: 'AAPL', description: 'Apple Inc.' }];

describe('marketDataService.searchTickers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('devuelve lo de Yahoo sin tocar EODHD (no gasta su cuota)', async () => {
    yahooFinanceService.searchTickers.mockResolvedValue(AAPL);
    await expect(marketDataService.searchTickers('aapl')).resolves.toEqual(AAPL);
    expect(eodhdService.searchTickers).not.toHaveBeenCalled();
  });

  it('pide a Yahoo en modo strict', async () => {
    yahooFinanceService.searchTickers.mockResolvedValue(AAPL);
    await marketDataService.searchTickers('aapl');
    expect(yahooFinanceService.searchTickers).toHaveBeenCalledWith('aapl', undefined, { strict: true });
  });

  it('sin resultados en ninguno: [] (es "no hay resultados", no un error)', async () => {
    yahooFinanceService.searchTickers.mockResolvedValue([]);
    eodhdService.searchTickers.mockResolvedValue([]);
    await expect(marketDataService.searchTickers('zzzz')).resolves.toEqual([]);
  });

  it('Yahoo caído y EODHD sin nada: LANZA, para que la barra diga que no pudo buscar', async () => {
    yahooFinanceService.searchTickers.mockRejectedValue(new Error('Yahoo search unavailable'));
    eodhdService.searchTickers.mockResolvedValue([]);
    await expect(marketDataService.searchTickers('aapl')).rejects.toThrow(/unavailable/);
  });

  it('Yahoo caído pero EODHD responde: usa EODHD', async () => {
    yahooFinanceService.searchTickers.mockRejectedValue(new Error('down'));
    eodhdService.searchTickers.mockResolvedValue(AAPL);
    await expect(marketDataService.searchTickers('aapl')).resolves.toEqual(AAPL);
  });

  it('una búsqueda cancelada se propaga y no cae a EODHD', async () => {
    const controller = new AbortController();
    yahooFinanceService.searchTickers.mockImplementation(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });
    await expect(marketDataService.searchTickers('aapl', controller.signal)).rejects.toThrow(/Abort/);
    expect(eodhdService.searchTickers).not.toHaveBeenCalled();
  });
});
