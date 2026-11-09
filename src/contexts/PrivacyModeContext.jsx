import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';

const PrivacyModeContext = createContext({ privacyMode: false, togglePrivacyMode: () => {} });

// `userId` se conserva en la firma por compatibilidad; el usuario lo da ya el
// contexto de preferencias.
export const PrivacyModeProvider = ({ children }) => {
  const { preferences, savePreferences } = useUserPreferences();
  // localStorage solo para pintar al instante; la BD (preferencias compartidas) manda.
  const [privacyMode, setPrivacyMode] = useState(() => {
    try { return localStorage.getItem('wf_privacy_mode') === 'true'; } catch { return false; }
  });

  useEffect(() => {
    const stored = preferences?.privacy_mode;
    if (stored === undefined || stored === null) return;
    setPrivacyMode(stored);
    try { localStorage.setItem('wf_privacy_mode', stored); } catch { /* sin almacenamiento */ }
  }, [preferences?.privacy_mode]);

  const togglePrivacyMode = useCallback(() => {
    setPrivacyMode((prev) => {
      const next = !prev;
      try { localStorage.setItem('wf_privacy_mode', next); } catch { /* sin almacenamiento */ }
      savePreferences({ privacy_mode: next });
      return next;
    });
  }, [savePreferences]);

  return (
    <PrivacyModeContext.Provider value={{ privacyMode, togglePrivacyMode }}>
      {children}
    </PrivacyModeContext.Provider>
  );
};

export const usePrivacyMode = () => useContext(PrivacyModeContext);
