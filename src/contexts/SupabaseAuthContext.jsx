import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';

import { realSupabase } from '@/lib/customSupabaseClient';
import { applyDemoPersona } from '@/lib/mockSupabaseClient';
import { DEMO_USER_IDS, isDemoCredentialLogin, getDemoCredentials } from '@/lib/demoAuth';
import { useToast } from '@/components/ui/use-toast';
import i18n from '@/i18n';

const AuthContext = createContext(undefined);

const DEMO_PUBLIC_EMAIL = 'demo@example.com';

export const SupabaseAuthProvider = ({ children }) => {
  const { toast } = useToast();

  const [user, setUser] = useState(null);
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isDemoMode, setIsDemoMode] = useState(localStorage.getItem('trazza_demo_mode') === 'true');
  const [isRecoveryMode, setIsRecoveryMode] = useState(false);

  const handleSession = useCallback((session) => {
    const nextUser = session?.user ?? null;
    // If a real authenticated user arrives while the demo flag is still set
    // (e.g. the user used demo mode earlier and the localStorage persisted),
    // clear the flag so the Supabase Proxy routes to the real client.
    if (nextUser && !DEMO_USER_IDS.has(nextUser.id)) {
      localStorage.removeItem('trazza_demo_mode');
      setIsDemoMode(false);
    }
    // Keep the same object reference when the user ID hasn't changed.
    // Supabase fires both getSession() and INITIAL_SESSION in onAuthStateChange,
    // which would otherwise create two different objects for the same user and
    // double-trigger any useEffect([user]) in consumers.
    setUser(prev => (prev?.id && prev.id === nextUser?.id ? prev : nextUser));
    setSession(session);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!realSupabase) {
      // No credentials — fall through to demo mode if the flag is set,
      // otherwise just stay loading=false with no user.
      setLoading(false);
      return;
    }

    const getSession = async () => {
      const { data: { session } } = await realSupabase.auth.getSession();
      handleSession(session);
    };

    getSession();

    const { data: { subscription } } = realSupabase.auth.onAuthStateChange(
      async (event, session) => {
        if (event === 'PASSWORD_RECOVERY') {
          setIsRecoveryMode(true);
        } else if (event === 'USER_UPDATED' || event === 'SIGNED_OUT') {
          setIsRecoveryMode(false);
        }
        handleSession(session);
      }
    );

    return () => subscription.unsubscribe();
  }, [handleSession]);

  const signUp = useCallback(async (email, password, options) => {
    if (!realSupabase) return { error: { message: i18n.t('auth.supabase_not_configured') } };
    const { error } = await realSupabase.auth.signUp({
      email,
      password,
      options: {
        ...options,
        // `lang` en primer nivel: la plantilla del correo de confirmación de
        // Supabase (supabase/templates/confirm_signup.html) elige idioma con
        // `.Data.lang`, y un campo anidado que falte rompe la plantilla.
        data: {
          ...(options?.data || {}),
          lang: String(i18n.language || 'es').startsWith('en') ? 'en' : 'es',
        },
      },
    });

    if (error) {
      toast({
        variant: "destructive",
        title: i18n.t('auth.toast_signup_failed'),
        description: error.message || i18n.t('auth.toast_generic_error_desc'),
      });
    }

    return { error };
  }, [toast]);

  const signInWithGoogle = useCallback(async () => {
    if (!realSupabase) { toast({ variant: 'destructive', title: i18n.t('auth.toast_no_credentials_title'), description: i18n.t('auth.toast_no_credentials_desc') }); return { error: true }; }
    const { error } = await realSupabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/app` },
    });
    if (error) toast({ variant: 'destructive', title: i18n.t('auth.toast_google_failed'), description: error.message });
    return { error };
  }, [toast]);

  const forgotPassword = useCallback(async (email) => {
    if (!realSupabase) return { error: { message: i18n.t('auth.supabase_not_configured') } };
    const { error } = await realSupabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth`,
    });
    return { error };
  }, []);

  const signIn = useCallback(async (email, password) => {
    if (isDemoCredentialLogin(email, password)) {
      const cred = getDemoCredentials();
      setLoading(true);
      applyDemoPersona('demoSample');
      localStorage.setItem('trazza_demo_mode', 'true');
      setIsDemoMode(true);
      const demoSession = { user: { id: 'demo-sample-user-id', email: cred?.email || 'demoSample@example.com' } };
      setSession(demoSession);
      setUser(demoSession.user);
      setLoading(false);
      return { error: null };
    }

    if (!realSupabase) return { error: { message: i18n.t('auth.supabase_not_configured') } };
    const { error } = await realSupabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      toast({
        variant: "destructive",
        title: i18n.t('auth.toast_signin_failed'),
        description: error.message || i18n.t('auth.toast_generic_error_desc'),
      });
    }

    return { error };
  }, [toast]);

  const signInAsDemo = useCallback(async () => {
    setLoading(true);
    // "Explorar demo" siempre es la demo pública. Solo en desarrollo o en el
    // build del CI (VITE_E2E=1), /auth?demo_persona=empty entra con una cuenta
    // vacía (smoke E2E del onboarding). En el build de producción la condición
    // es siempre falsa (ni DEV ni VITE_E2E): el parámetro no hace nada.
    const devPersona = (import.meta.env.DEV || import.meta.env.VITE_E2E === '1') ? new URLSearchParams(window.location.search).get('demo_persona') : null;
    const freshAccount = devPersona === 'empty';
    applyDemoPersona(freshAccount ? 'empty' : 'default');
    localStorage.setItem('trazza_demo_mode', 'true');
    setIsDemoMode(true);
    
    // Simulate session
    // La cuenta vacía se comporta como recién creada, para que el smoke vea
    // también la bienvenida (lib/welcomeSetup).
    const demoSession = {
      user: freshAccount
        ? { id: 'demo-user-id', email: DEMO_PUBLIC_EMAIL, created_at: new Date().toISOString(), user_metadata: { demo_fresh_account: true } }
        : { id: 'demo-user-id', email: DEMO_PUBLIC_EMAIL },
    };
    setSession(demoSession);
    setUser(demoSession.user);
    setLoading(false);
    
    toast({
      title: i18n.t('auth.demo_welcome_title'),
      description: i18n.t('auth.demo_welcome_desc'),
    });
  }, [toast]);

  const updatePassword = useCallback(async (newPassword) => {
    if (!realSupabase) return { error: { message: i18n.t('auth.supabase_not_configured') } };
    const { error } = await realSupabase.auth.updateUser({ password: newPassword });
    if (!error) setIsRecoveryMode(false);
    if (error) {
      toast({
        variant: 'destructive',
        title: i18n.t('auth.toast_error_title'),
        description: error.message,
      });
    }
    return { error };
  }, [toast]);

  const signOut = useCallback(async () => {
    if (!realSupabase) { localStorage.removeItem('trazza_demo_mode'); setIsDemoMode(false); setSession(null); setUser(null); return { error: null }; }
    const { error } = await realSupabase.auth.signOut();
    localStorage.removeItem('trazza_demo_mode');
    setIsDemoMode(false);
    setSession(null);
    setUser(null);

    if (error) {
      toast({
        variant: "destructive",
        title: "Sign out Failed",
        description: error.message || "Something went wrong",
      });
    }

    return { error };
  }, [toast]);


  const value = useMemo(() => ({
    user,
    session,
    loading,
    isDemoMode,
    isRecoveryMode,
    signUp,
    signIn,
    signInWithGoogle,
    forgotPassword,
    updatePassword,
    signInAsDemo,
    signOut,
  }), [user, session, loading, isDemoMode, isRecoveryMode, signUp, signIn, signInWithGoogle, forgotPassword, updatePassword, signInAsDemo, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useSupabaseAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useSupabaseAuth must be used within a SupabaseAuthProvider');
  }
  return context;
};