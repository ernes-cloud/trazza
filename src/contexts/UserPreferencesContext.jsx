/**
 * La fila de `user_preferences` del usuario, leída UNA vez y compartida.
 *
 * Antes la leían por su cuenta 13 ficheros (cabecera, privacidad, Gastos, plan,
 * cuota de IA, Dashboard, brokers, Ajustes, rebalanceo…): varias consultas a la
 * misma fila en cada entrada a la app, varias con columnas por nombre —que dan
 * 400 COMPLETO si falta una sola—, y cada pantalla con su propia copia que podía
 * quedarse vieja cuando otra guardaba.
 *
 * Reglas:
 * - Se lee con `select('*')` y comprobando `error` (CLAUDE.md).
 * - Toda escritura pasa por `savePreferences(patch)`: hace el upsert y, SOLO si
 *   va bien, mezcla el cambio en el estado — así todas las superficies ven el
 *   valor nuevo sin releer, y un fallo no deja en pantalla un dato que no existe.
 * - `plan` es una columna de AUTORIZACIÓN que el cliente no puede cambiar (trigger
 *   guard_plan_column); reenviarla con el mismo valor está permitido.
 */
import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '@/lib/customSupabaseClient';
import { useSupabaseAuth } from '@/contexts/SupabaseAuthContext';

const UserPreferencesContext = createContext(null);

/**
 * Qué se expone a los consumidores, dado el estado interno. Pura y testeada:
 * - Sin usuario: nada que cargar (`loading: false`, `preferences: null`).
 * - Si el estado pertenece a OTRO usuario (cambio de cuenta), se comporta como
 *   cargando: nunca se enseñan las preferencias de la sesión anterior.
 */
export function selectPreferencesView(state, userId) {
  if (!userId) return { preferences: null, loading: false, error: null };
  if (state.userId !== userId) return { preferences: null, loading: true, error: null };
  return { preferences: state.preferences, loading: state.loading, error: state.error };
}

export function UserPreferencesProvider({ children }) {
  const { user } = useSupabaseAuth();
  const userId = user?.id || null;
  const [state, setState] = useState({ userId: null, preferences: null, loading: false, error: null });

  const refresh = useCallback(async () => {
    if (!userId) return null;
    setState((s) => ({ ...s, userId, loading: true }));
    const { data, error } = await supabase.from('user_preferences').select('*').eq('user_id', userId).maybeSingle();
    if (error) {
      console.error('[preferences] load:', error.message);
      setState((s) => ({ ...s, userId, loading: false, error }));
      return null;
    }
    const preferences = data || {};
    setState({ userId, preferences, loading: false, error: null });
    return preferences;
  }, [userId]);

  useEffect(() => { refresh(); }, [refresh]);

  const savePreferences = useCallback(async (patch) => {
    if (!userId) return { error: new Error('no session') };
    const { error } = await supabase
      .from('user_preferences')
      .upsert({ ...patch, user_id: userId }, { onConflict: 'user_id' });
    if (error) {
      console.warn('[preferences] save:', error.message);
      return { error };
    }
    setState((s) => (s.userId === userId
      ? { ...s, preferences: { ...(s.preferences || {}), ...patch, user_id: userId } }
      : s));
    return { error: null };
  }, [userId]);

  const view = selectPreferencesView(state, userId);
  const value = useMemo(
    () => ({ ...view, refresh, savePreferences }),
    [view.preferences, view.loading, view.error, refresh, savePreferences], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return <UserPreferencesContext.Provider value={value}>{children}</UserPreferencesContext.Provider>;
}

/** @returns {{ preferences: object|null, loading: boolean, error: object|null,
 *              refresh: () => Promise<object|null>,
 *              savePreferences: (patch: object) => Promise<{ error: object|null }> }} */
export function useUserPreferences() {
  const ctx = useContext(UserPreferencesContext);
  if (!ctx) throw new Error('useUserPreferences fuera de <UserPreferencesProvider>');
  return ctx;
}
