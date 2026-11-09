import React, { useState, useEffect } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Helmet } from 'react-helmet';
import { useTranslation } from 'react-i18next';
import { Mail, Lock, Eye, EyeOff, TrendingUp, CheckCircle2 } from 'lucide-react';
import { useSupabaseAuth } from '@/contexts/SupabaseAuthContext';
import { useToast } from '@/components/ui/use-toast';
import { BETA_GATE_ENABLED } from '@/lib/featureFlags';
import { ensureAppTranslations } from '@/i18n';

// ── Password strength ─────────────────────────────────────────────────────────
function getStrength(pw) {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 8)               s++;
  if (/[A-Z]/.test(pw))             s++;
  if (/[0-9]/.test(pw))             s++;
  if (/[^a-zA-Z0-9]/.test(pw))     s++;
  return s;
}
const STRENGTH_COLORS = ['', '#f43f5e', '#f59e0b', '#14b8a6', '#10b981'];
const STRENGTH_KEYS   = ['', 'strength_weak', 'strength_fair', 'strength_good', 'strength_strong'];

function PasswordStrength({ password, t }) {
  const s = getStrength(password);
  if (!password) return null;
  return (
    <div className="mt-2 space-y-1">
      <div className="flex gap-1">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="flex-1 h-1 rounded-full transition-colors duration-300"
            style={{ backgroundColor: i <= s ? STRENGTH_COLORS[s] : '#e2e8f0' }} />
        ))}
      </div>
      <p className="text-[11px] font-medium" style={{ color: STRENGTH_COLORS[s] }}>
        {t(`auth.${STRENGTH_KEYS[s]}`)}
      </p>
    </div>
  );
}

// ── Google logo SVG ───────────────────────────────────────────────────────────
function GoogleIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  );
}

// ── Left brand panel ──────────────────────────────────────────────────────────
function BrandPanel({ t }) {
  const props = [
    t('auth.value_prop_1'),
    t('auth.value_prop_2'),
    t('auth.value_prop_3'),
  ];
  return (
    <div className="hidden lg:flex flex-col justify-between h-full px-12 py-14">
      <div className="flex items-center gap-3">
        <div className="bg-blue-500 p-2 rounded-xl">
          <TrendingUp className="w-6 h-6 text-white" />
        </div>
        <span className="text-xl font-extrabold text-white tracking-tight">Trazza</span>
      </div>

      <div className="space-y-6">
        <h2 className="text-4xl font-extrabold text-white leading-tight tracking-tight">
          Tu cartera.<br />
          <span className="text-blue-400">A nivel institucional.</span>
        </h2>
        <ul className="space-y-4">
          {props.map((prop, i) => (
            <li key={i} className="flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
              <span className="text-slate-300 text-sm leading-relaxed">{prop}</span>
            </li>
          ))}
        </ul>
      </div>

      <p className="text-slate-500 text-xs">© 2026 Trazza. Todos los derechos reservados.</p>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
const AuthPage = () => {
  const { t } = useTranslation();
  const { user, isRecoveryMode, signIn, signUp, signInWithGoogle, forgotPassword, updatePassword, signInAsDemo } = useSupabaseAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [mode, setMode]               = useState(() => searchParams.get('mode') === 'signup' ? 'signup' : 'signin');
  const [email, setEmail]             = useState('');
  const [password, setPassword]       = useState('');
  const [confirmPw, setConfirmPw]     = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading]         = useState(false);
  const [forgotSent, setForgotSent]   = useState(false);
  const [resetDone, setResetDone]     = useState(false);
  const [signupDone, setSignupDone]   = useState(false);
  const [signupEmail, setSignupEmail] = useState('');

  // Precarga el chunk i18n de /app mientras se ve el login (demo o sesión).
  useEffect(() => {
    ensureAppTranslations().catch(() => {});
  }, []);

  // Recovery mode: show new-password form instead of redirecting to /app
  if (user && !isRecoveryMode) return <Navigate to="/app" replace />;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (mode === 'signup' && password !== confirmPw) {
      toast({ title: t('auth.passwords_no_match'), variant: 'destructive' });
      return;
    }
    setLoading(true);
    try {
      if (mode === 'signup') {
        const { error } = await signUp(email, password);
        if (!error) {
          setSignupEmail(email);
          setSignupDone(true);
        }
      } else {
        await signIn(email, password);
        toast({ title: t('auth.toast_signin_title'), description: t('auth.toast_signin_desc') });
      }
    } catch (err) {
      toast({ title: t('auth.toast_error_title'), description: err.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const handleForgot = async (e) => {
    e.preventDefault();
    setLoading(true);
    const { error } = await forgotPassword(email);
    setLoading(false);
    if (error) {
      toast({ title: t('auth.toast_error_title'), description: error.message, variant: 'destructive' });
    } else {
      setForgotSent(true);
    }
  };

  const handleReset = async (e) => {
    e.preventDefault();
    if (password !== confirmPw) {
      toast({ title: t('auth.passwords_no_match'), variant: 'destructive' });
      return;
    }
    setLoading(true);
    const { error } = await updatePassword(password);
    setLoading(false);
    if (!error) {
      setResetDone(true);
      setTimeout(() => navigate('/app', { replace: true }), 2000);
    }
  };

  const handleGoogle = async () => {
    setLoading(true);
    await signInWithGoogle();
    setLoading(false);
  };

  const switchMode = (next) => {
    setMode(next);
    setPassword('');
    setConfirmPw('');
    setForgotSent(false);
  };

  return (
    <div className="min-h-screen flex">
      <Helmet>
        <title>{mode === 'signup' ? t('auth.title_signup') : t('auth.title_signin')}</title>
        <meta name="description" content={t('auth.meta_description')} />
      </Helmet>

      {/* ── Left brand panel ── */}
      <div className="hidden lg:block lg:w-[52%] bg-slate-900 relative overflow-hidden">
        {/* Subtle grid pattern */}
        <div className="absolute inset-0 opacity-[0.04]"
          style={{ backgroundImage: 'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize: '40px 40px' }} />
        <div className="relative h-full">
          <BrandPanel t={t} />
        </div>
      </div>

      {/* ── Right form panel ── */}
      <div className="flex-1 flex items-center justify-center bg-white dark:bg-slate-900 px-6 py-12">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
          className="w-full max-w-sm"
        >
          {/* Logo — mobile only */}
          <div className="flex lg:hidden items-center justify-center gap-2.5 mb-8">
            <div className="bg-blue-600 p-2 rounded-xl">
              <TrendingUp className="w-5 h-5 text-white" />
            </div>
            <span className="text-xl font-extrabold text-slate-900 dark:text-white tracking-tight">Trazza</span>
          </div>

          {/* ── Reset password flow (PASSWORD_RECOVERY event) ── */}
          <AnimatePresence mode="wait">
            {isRecoveryMode ? (
              <motion.div key="reset"
                initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.25 }}
              >
                {resetDone ? (
                  <div className="text-center space-y-4">
                    <div className="w-14 h-14 bg-emerald-100 dark:bg-emerald-900/30 rounded-2xl flex items-center justify-center mx-auto">
                      <CheckCircle2 className="w-7 h-7 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <h2 className="text-xl font-extrabold text-slate-900 dark:text-white">{t('auth.reset_success_title')}</h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400">{t('auth.reset_success_desc')}</p>
                  </div>
                ) : (
                  <>
                    <div className="mb-7">
                      <div className="w-12 h-12 bg-amber-100 dark:bg-amber-900/30 rounded-2xl flex items-center justify-center mb-4">
                        <Lock className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                      </div>
                      <h2 className="text-2xl font-extrabold text-slate-900 dark:text-white mb-1">{t('auth.reset_title')}</h2>
                      <p className="text-sm text-slate-500 dark:text-slate-400">{t('auth.reset_subtitle')}</p>
                    </div>

                    <form onSubmit={handleReset} className="space-y-4">
                      {/* New password */}
                      <div>
                        <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1.5">{t('auth.reset_new_label')}</label>
                        <div className="relative">
                          <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                          <input type={showPassword ? 'text' : 'password'} required minLength={8}
                            value={password} onChange={e => setPassword(e.target.value)}
                            placeholder={t('auth.password_placeholder')}
                            className="w-full pl-10 pr-11 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white text-sm focus:ring-2 focus:ring-amber-500 focus:border-transparent outline-hidden transition" />
                          <button type="button" onClick={() => setShowPassword(s => !s)}
                            className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition">
                            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                        <PasswordStrength password={password} t={t} />
                      </div>

                      {/* Confirm password */}
                      <div>
                        <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1.5">{t('auth.reset_confirm_label')}</label>
                        <div className="relative">
                          <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                          <input type={showConfirm ? 'text' : 'password'} required
                            value={confirmPw} onChange={e => setConfirmPw(e.target.value)}
                            placeholder={t('auth.confirm_password_placeholder')}
                            className={`w-full pl-10 pr-11 py-3 rounded-xl border text-sm focus:ring-2 focus:ring-amber-500 focus:border-transparent outline-hidden transition bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white ${
                              confirmPw && confirmPw !== password
                                ? 'border-rose-400 dark:border-rose-500'
                                : 'border-slate-200 dark:border-slate-700'
                            }`} />
                          <button type="button" onClick={() => setShowConfirm(s => !s)}
                            className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition">
                            {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                        {confirmPw && confirmPw !== password && (
                          <p className="text-[11px] text-rose-500 mt-1 ml-1">{t('auth.passwords_no_match')}</p>
                        )}
                      </div>

                      <button type="submit" disabled={loading || (confirmPw && confirmPw !== password)}
                        className="w-full py-3 rounded-xl bg-amber-500 hover:bg-amber-600 active:bg-amber-700 text-white font-bold text-sm transition shadow-xs disabled:opacity-60">
                        {loading ? t('auth.btn_processing') : t('auth.reset_btn')}
                      </button>
                    </form>
                  </>
                )}
              </motion.div>

            ) : mode === 'forgot' ? (
              <motion.div key="forgot"
                initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.25 }}
              >
                {forgotSent ? (
                  <div className="text-center space-y-4">
                    <div className="w-14 h-14 bg-emerald-100 dark:bg-emerald-900/30 rounded-2xl flex items-center justify-center mx-auto">
                      <CheckCircle2 className="w-7 h-7 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <h2 className="text-xl font-extrabold text-slate-900 dark:text-white">{t('auth.forgot_sent_title')}</h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400">{t('auth.forgot_sent_desc')}</p>
                    <button onClick={() => switchMode('signin')}
                      className="text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline mt-2">
                      {t('auth.forgot_back')}
                    </button>
                  </div>
                ) : (
                  <>
                    <h2 className="text-2xl font-extrabold text-slate-900 dark:text-white mb-1">{t('auth.forgot_title')}</h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mb-7">{t('auth.forgot_hint')}</p>
                    <form onSubmit={handleForgot} className="space-y-4">
                      <div className="relative">
                        <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4.5 h-4.5 text-slate-400" />
                        <input type="email" required value={email} onChange={e => setEmail(e.target.value)}
                          placeholder={t('auth.email_placeholder')}
                          className="w-full pl-10 pr-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-hidden transition" />
                      </div>
                      <button type="submit" disabled={loading}
                        className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm transition disabled:opacity-60">
                        {loading ? '...' : t('auth.forgot_btn')}
                      </button>
                    </form>
                    <button onClick={() => switchMode('signin')}
                      className="mt-5 text-sm font-medium text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition">
                      ← {t('auth.forgot_back')}
                    </button>
                  </>
                )}
              </motion.div>

            ) : signupDone ? (
              <motion.div key="signup-done"
                initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.25 }}
              >
                <div className="text-center space-y-4">
                  <div className="w-14 h-14 bg-blue-100 dark:bg-blue-900/30 rounded-2xl flex items-center justify-center mx-auto">
                    <Mail className="w-7 h-7 text-blue-600 dark:text-blue-400" />
                  </div>
                  <h2 className="text-xl font-extrabold text-slate-900 dark:text-white">
                    {t('auth.signup_confirm_title')}
                  </h2>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    {/* Con la beta abierta no hay aprobación que esperar: decirlo
                        espantaba justo en el último paso del alta. */}
                    {t(BETA_GATE_ENABLED ? 'auth.signup_confirm_desc' : 'auth.signup_confirm_desc_open', { email: signupEmail })}
                  </p>
                  <p className="text-xs text-slate-400 dark:text-slate-500">
                    {t('auth.signup_confirm_hint')}
                  </p>
                  <button
                    onClick={() => { setSignupDone(false); switchMode('signin'); }}
                    className="text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline block mx-auto mt-2"
                  >
                    {t('auth.signup_confirm_back')}
                  </button>
                </div>
              </motion.div>

            ) : (
              <motion.div key="main"
                initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }}
                transition={{ duration: 0.25 }}
              >
                {/* Tabs */}
                <div className="flex gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl mb-7">
                  {(['signin', 'signup']).map(m => (
                    <button key={m} onClick={() => switchMode(m)}
                      className={`flex-1 py-2 rounded-lg text-sm font-bold transition-all ${
                        mode === m
                          ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs'
                          : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
                      }`}>
                      {m === 'signin' ? t('auth.tab_signin') : t('auth.tab_signup')}
                    </button>
                  ))}
                </div>

                {/* Google button */}
                <button onClick={handleGoogle} disabled={loading}
                  className="w-full flex items-center justify-center gap-3 py-3 px-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700/80 text-slate-700 dark:text-slate-200 font-semibold text-sm transition shadow-xs disabled:opacity-60">
                  <GoogleIcon />
                  {t('auth.btn_google')}
                </button>

                {/* Divider */}
                <div className="flex items-center gap-3 my-5">
                  <div className="flex-1 h-px bg-slate-200 dark:bg-slate-700" />
                  <span className="text-[11px] font-medium text-slate-400 whitespace-nowrap">{t('auth.or_divider')}</span>
                  <div className="flex-1 h-px bg-slate-200 dark:bg-slate-700" />
                </div>

                {/* Form */}
                <form onSubmit={handleSubmit} className="space-y-4">
                  {/* Email */}
                  <div className="relative">
                    <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input type="email" required value={email} onChange={e => setEmail(e.target.value)}
                      placeholder={t('auth.email_placeholder')}
                      className="w-full pl-10 pr-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-hidden transition" />
                  </div>

                  {/* Password */}
                  <div>
                    <div className="relative">
                      <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <input type={showPassword ? 'text' : 'password'} required minLength={8}
                        value={password} onChange={e => setPassword(e.target.value)}
                        placeholder={t('auth.password_placeholder')}
                        className="w-full pl-10 pr-11 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-hidden transition" />
                      <button type="button" onClick={() => setShowPassword(s => !s)}
                        className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition">
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                    {mode === 'signup' && <PasswordStrength password={password} t={t} />}
                  </div>

                  {/* Confirm password — sign up only */}
                  <AnimatePresence>
                    {mode === 'signup' && (
                      <motion.div key="confirm"
                        initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }}
                      >
                        <div className="relative">
                          <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                          <input type={showConfirm ? 'text' : 'password'} required
                            value={confirmPw} onChange={e => setConfirmPw(e.target.value)}
                            placeholder={t('auth.confirm_password_placeholder')}
                            className={`w-full pl-10 pr-11 py-3 rounded-xl border text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-hidden transition bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white ${
                              confirmPw && confirmPw !== password
                                ? 'border-rose-400 dark:border-rose-500'
                                : 'border-slate-200 dark:border-slate-700'
                            }`} />
                          <button type="button" onClick={() => setShowConfirm(s => !s)}
                            className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition">
                            {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                        {confirmPw && confirmPw !== password && (
                          <p className="text-[11px] text-rose-500 mt-1 ml-1">{t('auth.passwords_no_match')}</p>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* Forgot password link */}
                  {mode === 'signin' && (
                    <div className="flex justify-end">
                      <button type="button" onClick={() => switchMode('forgot')}
                        className="text-xs font-medium text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 transition">
                        {t('auth.forgot_password')}
                      </button>
                    </div>
                  )}

                  {/* Submit */}
                  <button type="submit" disabled={loading}
                    className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-bold text-sm transition shadow-xs shadow-blue-200 dark:shadow-none disabled:opacity-60">
                    {loading ? '...' : mode === 'signup' ? t('auth.btn_signup') : t('auth.btn_signin')}
                  </button>
                </form>

                {/* Demo */}
                <div className="mt-5 flex items-center justify-center gap-2">
                  <button onClick={signInAsDemo}
                    className="text-sm font-semibold text-slate-500 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 transition">
                    {t('auth.demo_btn')}
                  </button>
                  <span className="text-[10px] bg-slate-100 dark:bg-slate-800 text-slate-400 px-2 py-0.5 rounded-full font-medium">
                    {t('auth.demo_hint')}
                  </span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </div>
    </div>
  );
};

export default AuthPage;
