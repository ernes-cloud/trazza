import { describe, it, expect, vi } from 'vitest';
import { insertWatchlistItem, persistItemDisplayName, needsNameHealing } from './watchlistItems';

// Supabase falso: insert()/update() encadenables que devuelven el resultado configurado
const fakeSupabase = (responses) => {
  let call = 0;
  const next = () => responses[Math.min(call++, responses.length - 1)];
  return {
    from: () => ({
      insert: () => ({ select: () => ({ single: async () => next() }) }),
      update: () => ({ eq: async () => next() }),
    }),
    _calls: () => call,
  };
};

const COLUMN_MISSING = { data: null, error: { code: 'PGRST204', message: "Could not find the 'display_name' column" } };

describe('insertWatchlistItem', () => {
  it('inserta con display_name cuando la migración está aplicada', async () => {
    const sb = fakeSupabase([{ data: { id: '1', ticker: 'AAPL', display_name: 'Apple Inc' }, error: null }]);
    const { data, error } = await insertWatchlistItem(sb, { watchlistId: 'w1', ticker: 'AAPL', displayName: 'Apple Inc' });
    expect(error).toBeNull();
    expect(data.display_name).toBe('Apple Inc');
  });

  it('si la columna aún no existe, reintenta sin display_name (no rompe el alta)', async () => {
    const sb = fakeSupabase([COLUMN_MISSING, { data: { id: '1', ticker: 'AAPL' }, error: null }]);
    const { data, error } = await insertWatchlistItem(sb, { watchlistId: 'w1', ticker: 'AAPL', displayName: 'Apple Inc' });
    expect(error).toBeNull();
    expect(data.id).toBe('1');
    expect(sb._calls()).toBe(2);
  });

  it('otros errores se devuelven sin reintentar', async () => {
    const sb = fakeSupabase([{ data: null, error: { code: '23505', message: 'duplicate' } }]);
    const { error } = await insertWatchlistItem(sb, { watchlistId: 'w1', ticker: 'AAPL', displayName: null });
    expect(error?.code).toBe('23505');
    expect(sb._calls()).toBe(1);
  });
});

describe('persistItemDisplayName', () => {
  it('actualiza y no lanza aunque la columna falte', async () => {
    const sb = fakeSupabase([COLUMN_MISSING]);
    await expect(persistItemDisplayName(sb, 'item1', 'Fidelity MSCI World')).resolves.toBeUndefined();
  });
});

describe('needsNameHealing — qué items requieren resolver el nombre por búsqueda', () => {
  it('sin display_name y con nombre de quote igual al ticker → sí', () => {
    expect(needsNameHealing({ ticker: '0P00019ORF.F' }, '0P00019ORF.F')).toBe(true);
    expect(needsNameHealing({ ticker: '0P00019ORF.F' }, null)).toBe(true);
  });

  it('con display_name persistido o nombre real de quote → no', () => {
    expect(needsNameHealing({ ticker: '0P00019ORF.F', display_name: 'Fidelity MSCI World' }, '0P00019ORF.F')).toBe(false);
    expect(needsNameHealing({ ticker: 'AAPL' }, 'Apple Inc')).toBe(false);
  });
});
