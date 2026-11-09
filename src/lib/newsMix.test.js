import { describe, it, expect } from 'vitest';
import { interleaveByTicker } from './newsMix';

const n = (ticker, datetime, id = `${ticker}-${datetime}`) => ({ ticker, datetime, url: id });

describe('interleaveByTicker', () => {
  it('reparte entre activos: ya no salen 6 de 6 de Apple', () => {
    const items = [n('AAPL', 100), n('AAPL', 99), n('AAPL', 98), n('AAPL', 97), n('MSFT', 50), n('NVDA', 40)];
    expect(interleaveByTicker(items).slice(0, 3).map((x) => x.ticker)).toEqual(['AAPL', 'MSFT', 'NVDA']);
  });

  it('dentro de cada activo, la más reciente primero; el activo con la noticia más nueva abre cada ronda', () => {
    const items = [n('MSFT', 10), n('AAPL', 5), n('MSFT', 30), n('AAPL', 20)];
    expect(interleaveByTicker(items).map((x) => x.url)).toEqual(['MSFT-30', 'AAPL-20', 'MSFT-10', 'AAPL-5']);
  });

  it('no pierde ni duplica noticias y no muta la entrada', () => {
    const items = [n('A', 3), n('B', 2), n('A', 1)];
    const copy = [...items];
    const out = interleaveByTicker(items);
    expect(out).toHaveLength(3);
    expect(new Set(out.map((x) => x.url)).size).toBe(3);
    expect(items).toEqual(copy);
  });

  it('lista vacía', () => {
    expect(interleaveByTicker([])).toEqual([]);
  });
});
