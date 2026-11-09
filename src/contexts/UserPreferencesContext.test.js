import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/customSupabaseClient', () => ({
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: null } })) } },
}));
vi.mock('@/contexts/SupabaseAuthContext', () => ({ useSupabaseAuth: () => ({ user: null }) }));

const { selectPreferencesView } = await import('./UserPreferencesContext.jsx');

describe('selectPreferencesView', () => {
  const loaded = { userId: 'u1', preferences: { preferred_currency: 'EUR' }, loading: false, error: null };

  it('sin usuario no hay nada que cargar', () => {
    expect(selectPreferencesView(loaded, null)).toEqual({ preferences: null, loading: false, error: null });
  });

  it('expone las preferencias del usuario actual', () => {
    expect(selectPreferencesView(loaded, 'u1').preferences).toEqual({ preferred_currency: 'EUR' });
  });

  it('nunca enseña las de la sesión anterior tras cambiar de cuenta', () => {
    expect(selectPreferencesView(loaded, 'u2')).toEqual({ preferences: null, loading: true, error: null });
  });

  it('propaga el error de carga', () => {
    const err = { message: 'boom' };
    expect(selectPreferencesView({ ...loaded, preferences: null, error: err }, 'u1').error).toBe(err);
  });
});
