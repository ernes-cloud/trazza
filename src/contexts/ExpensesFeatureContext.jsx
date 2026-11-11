import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { isExpensesFeatureAllowed } from '@/lib/expensesAccess';

// Opt-in flag for the personal expenses/savings module. The DB write happens in
// SettingsPage's save (upsert of user_preferences); this context only mirrors the
// value so the nav item and page react without a reload.
//
// OSS: sin lista de cuentas (`lib/expensesAccess` acepta cualquier email no vacío).
// Esta es la ÚNICA puerta — nav, ruta y el bloque de Ajustes cuelgan de
// `expensesEnabled` / `expensesAllowed`. `expensesEnabled` = permitido Y opt-in.
const ExpensesFeatureContext = createContext({
  expensesEnabled: false,
  expensesAllowed: false,
  setExpensesEnabled: () => {},
  loading: true,
});

export const ExpensesFeatureProvider = ({ children, userId, userEmail }) => {
  const allowed = isExpensesFeatureAllowed(userEmail);
  const [prefEnabled, setEnabled] = useState(() => {
    try { return localStorage.getItem('wf_expenses_enabled') === 'true'; } catch { return false; }
  });
  const { preferences, loading: prefsLoading } = useUserPreferences();
  const loading = allowed && !!userId && prefsLoading;

  // La BD (preferencias compartidas) manda; localStorage solo pinta al instante.
  useEffect(() => {
    if (!allowed || !preferences) return;
    const value = !!preferences.expenses_enabled;
    setEnabled(value);
    try { localStorage.setItem('wf_expenses_enabled', value); } catch { /* sin almacenamiento */ }
  }, [allowed, preferences?.expenses_enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const setExpensesEnabled = useCallback((value) => {
    const next = !!value;
    setEnabled(next);
    try { localStorage.setItem('wf_expenses_enabled', next); } catch { /* sin almacenamiento */ }
  }, []);

  return (
    <ExpensesFeatureContext.Provider
      value={{ expensesEnabled: allowed && prefEnabled, expensesAllowed: allowed, setExpensesEnabled, loading }}
    >
      {children}
    </ExpensesFeatureContext.Provider>
  );
};

export const useExpensesFeature = () => useContext(ExpensesFeatureContext);
