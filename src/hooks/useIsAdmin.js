import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/customSupabaseClient';
import { useSupabaseAuth } from '@/contexts/SupabaseAuthContext';

/**
 * Resolves admin status via GET /api/admin/health (200 = admin, 403 = not).
 */
export function useIsAdmin() {
  const { user, isDemoMode } = useSupabaseAuth();
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!user) {
      setIsAdmin(false);
      setLoading(false);
      return;
    }
    if (isDemoMode) {
      setIsAdmin(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setIsAdmin(false);
        return;
      }
      const resp = await fetch('/api/admin/health', {
        headers: { Authorization: `Bearer ${token}` },
      });
      setIsAdmin(resp.ok);
    } catch {
      setIsAdmin(false);
    } finally {
      setLoading(false);
    }
  }, [user, isDemoMode]);

  useEffect(() => { refresh(); }, [refresh]);

  return { isAdmin, loading, refresh };
}
