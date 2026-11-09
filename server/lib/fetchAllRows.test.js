import { describe, it, expect } from 'vitest';
import { fetchAllRows } from './fetchAllRows.js';

const fakeTable = (n, failAt = null) => () => ({
  range: async (from, to) => (failAt !== null && from >= failAt
    ? { data: null, error: { message: 'boom' } }
    : { data: Array.from({ length: Math.max(0, Math.min(to, n - 1) - from + 1) }, (_, i) => from + i), error: null }),
});

describe('fetchAllRows', () => {
  it('junta todas las páginas (antes se cortaba en la 1.000)', async () => {
    const { data } = await fetchAllRows(fakeTable(2500), 1000);
    expect(data).toHaveLength(2500);
    expect(data.at(-1)).toBe(2499);
  });
  it('una tabla con múltiplo exacto del tamaño de página termina', async () => {
    expect((await fetchAllRows(fakeTable(2000), 1000)).data).toHaveLength(2000);
  });
  it('un error en cualquier página se propaga, no devuelve datos a medias', async () => {
    const r = await fetchAllRows(fakeTable(2500, 1000), 1000);
    expect(r.data).toBe(null);
    expect(r.error.message).toBe('boom');
  });
});
