import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutDashboard,
  Wallet,
  Settings,
  LogOut,
  Moon,
  Sun,
  Eye,
  EyeOff,
  Menu,
  X,
  TrendingUp,
  Star,
  Bell,
  Loader2,
  CheckCheck,
  ChevronRight,
  Calculator,
  History,
  ShieldCheck,
} from 'lucide-react';
import { useSupabaseAuth } from '@/contexts/SupabaseAuthContext';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { supabase } from '@/lib/customSupabaseClient';
import { currencyService } from '@/services/currencyService';
import { annualizedTwrFromSeries } from '@/services/performanceService';
import { peekPerformanceSeries } from '@/hooks/usePortfolioPerformance';
import GlobalSearchOverlay from './GlobalSearchOverlay';
import GlobalSearchBar from './search/GlobalSearchBar';
import CompoundInterestCalculator from './CompoundInterestCalculator';
import { PrivacyModeProvider, usePrivacyMode } from '@/contexts/PrivacyModeContext';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { PortfolioDataProvider } from '@/contexts/PortfolioDataContext';
import { useTranslation } from 'react-i18next';

import { getNotifConfig } from '@/lib/notifConfig';
import { preferredCurrencyOf } from '@/lib/preferredCurrency';
import { shouldShowWelcome, WELCOME_LS_KEY } from '@/lib/welcomeSetup';
import { isCashPosition } from '@/lib/positionKind';
import WelcomeSetupDialog from '@/components/onboarding/WelcomeSetupDialog';
import PortfolioChatWidget from '@/components/PortfolioChatWidget';
import { ErrorBoundary } from '@/components/ErrorBoundary';

const AVATAR_GRADIENTS = [
  'from-blue-500 to-indigo-600',
  'from-violet-500 to-purple-600',
  'from-emerald-500 to-teal-600',
  'from-rose-500 to-pink-600',
  'from-amber-500 to-orange-600',
];

const DashboardLayoutInner = () => {
  const { t, i18n } = useTranslation();
  const { user, signOut, isDemoMode } = useSupabaseAuth();
  const { isAdmin } = useIsAdmin();
  const { preferences, loading: prefsLoading, savePreferences } = useUserPreferences();
  const navigate = useNavigate();
  const location = useLocation();
  const { privacyMode, togglePrivacyMode } = usePrivacyMode();
  const [darkMode, setDarkMode] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  // Ficha del activo que abre el buscador (GlobalSearchBar)
  const [overlayTicker, setOverlayTicker] = useState(null);

  // Notifications dropdown
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [notifLoading, setNotifLoading] = useState(false);
  const notifRef = useRef(null);

  // User menu dropdown
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef(null);

  // Compound Interest Calculator
  const [calcOpen, setCalcOpen] = useState(false);
  const [calcData, setCalcData] = useState({ value: 0, monthlyCashFlow: 0, cagr: null, currency: 'EUR' });

  // User avatar — deterministic gradient from email
  const emailName = (user?.email || '').split('@')[0];
  const emailParts = emailName.split('.');
  const initials = emailParts.length >= 2
    ? (emailParts[0][0] + emailParts[1][0]).toUpperCase()
    : emailName.slice(0, 2).toUpperCase() || 'U';
  const avatarGradient = AVATAR_GRADIENTS[(user?.email?.charCodeAt(0) || 0) % AVATAR_GRADIENTS.length];

  // Nav items (Notifications and Settings move to dedicated UI elements)
  const navItems = [
    { icon: LayoutDashboard, label: t('nav.dashboard'),  path: '/app' },
    { icon: Wallet,           label: t('nav.brokers'),    path: '/app/brokers' },
    { icon: Star,             label: t('nav.favorites'),  path: '/app/favorites' },
  ];

  // ─── Click-outside handlers ───────────────────────────────────────────────

  useEffect(() => {
    const handler = (e) => {
      if (notifRef.current && !notifRef.current.contains(e.target)) {
        setNotifOpen(false);
      }
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ─── Preferences + notification count ────────────────────────────────────

  const checkNotifications = useCallback(async () => {
    if (!user) return;
    const { count } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('is_read', false);
    setUnreadCount(count || 0);
  }, [user]);

  // Tema e idioma desde la fila de preferencias compartida, UNA vez por usuario:
  // sin la marca, cada savePreferences (que mezcla el cambio en el contexto)
  // volvería a ejecutar esto.
  const prefsAppliedFor = useRef(null);
  useEffect(() => {
    if (!user || prefsLoading || !preferences || prefsAppliedFor.current === user.id) return;
    prefsAppliedFor.current = user.id;
    const data = preferences.user_id ? preferences : null; // {} = la cuenta aún no tiene fila
    // El idioma de la app sale del navegador y NO se guardaba: la columna
    // `language` valía 'es' para todos y el server (informe semanal) no podía
    // saber quién usa Trazza en inglés. Se guarda el detectado si cambia.
    const lang = (i18n.language || '').toLowerCase().startsWith('en') ? 'en' : 'es';
    if (!data) {
      // New account with no preferences yet — default to dark mode
      setDarkMode(true);
      document.documentElement.classList.add('dark');
      savePreferences({ dark_mode: true, language: lang }); // fire-and-forget
    } else {
      setDarkMode(data.dark_mode);
      if (data.dark_mode) document.documentElement.classList.add('dark');
      else document.documentElement.classList.remove('dark');
      if (data.language !== lang) {
        savePreferences({ language: lang });
      }
    }
  }, [user, prefsLoading, preferences, savePreferences]);

  useEffect(() => {
    if (!user) return;
    checkNotifications();
    const interval = setInterval(checkNotifications, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [user, checkNotifications]);

  // ─── Notifications dropdown fetch ────────────────────────────────────────

  const openNotifications = async () => {
    setNotifOpen(prev => !prev);
    if (notifOpen) return;
    setNotifLoading(true);
    try {
      const { data } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(6);
      setNotifications(data || []);
    } finally {
      setNotifLoading(false);
    }
  };

  const markAllRead = async () => {
    const unreadIds = notifications.filter(n => !n.is_read).map(n => n.id);
    if (unreadIds.length === 0) return;
    await supabase.from('notifications').update({ is_read: true }).in('id', unreadIds).eq('user_id', user.id);
    setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
    setUnreadCount(0);
  };

  // ─── Dark mode ────────────────────────────────────────────────────────────

  // Aplica el tema en pantalla (sin guardarlo): lo usan el botón de la barra
  // y la vista previa de la bienvenida, que guarda al terminar.
  const applyDarkMode = (next) => {
    setDarkMode(next);
    if (next) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  };

  const toggleDarkMode = async () => {
    const next = !darkMode;
    applyDarkMode(next);
    if (user) await savePreferences({ dark_mode: next });
  };

  // ─── Bienvenida de una cuenta nueva (lib/welcomeSetup) ────────────────────
  useEffect(() => {
    let dismissedLocally = false;
    try { dismissedLocally = localStorage.getItem(WELCOME_LS_KEY) === 'true'; } catch { /* modo privado */ }
    // La demo pública no la enseña; la cuenta demo vacía (solo dev/CI) sí.
    const freshDemo = isDemoMode && user?.user_metadata?.demo_fresh_account === true;
    if (shouldShowWelcome({ user, isDemoMode: isDemoMode && !freshDemo, prefsLoading, dismissedLocally })) setWelcomeOpen(true);
  }, [user, isDemoMode, prefsLoading]);

  // ─── Calculator overlay ──────────────────────────────────────────────────

  const openCalculator = async () => {
    setCalcOpen(true);
    if (!user) return;
    try {
      const prefCur = preferredCurrencyOf(preferences);

      // positions has no user_id column — filter via broker_id belonging to the user
      const { data: userBrokers } = await supabase.from('brokers').select('id').eq('user_id', user.id);
      const brokerIds = (userBrokers || []).map(b => b.id);
      if (brokerIds.length === 0) return;

      const { data: positions } = await supabase.from('positions')
        .select('quantity, entry_price, assets(current_price, currency, asset_class, ticker)')
        .in('broker_id', brokerIds)
        .gt('quantity', 0);
      const valid = (positions || []).filter(p => p.assets && parseFloat(p.quantity) > 0.0001);

      const currencies = [...new Set(valid.map(p => p.assets.currency).filter(c => c && c !== prefCur))];
      const rates = { [prefCur]: 1 };
      await Promise.all(currencies.map(async c => { try { rates[c] = await currencyService.getExchangeRate(c, prefCur); } catch { rates[c] = 1; } }));

      const investedPositions = valid.filter((p) => !isCashPosition(p));

      const portfolioValue = investedPositions.reduce(
        (s, p) => s + parseFloat(p.quantity) * parseFloat(p.assets.current_price || p.entry_price || 0) * (rates[p.assets.currency || prefCur] || 1), 0
      );

      // Total invested = cost basis of current holdings across ALL brokers.
      // Using entry_price × qty from positions (always available, even for Binance
      // consolidated imports that don't generate individual BUY transaction records).
      const totalInvestedFromPositions = investedPositions.reduce(
        (s, p) => s + parseFloat(p.quantity) * parseFloat(p.entry_price || 0) * (rates[p.assets.currency || prefCur] || 1), 0
      );

      const { data: buyTxns } = await supabase.from('transactions')
        .select('transaction_date, quantity, price, eur_total, positions!inner(broker_id, assets(currency))')
        .in('positions.broker_id', brokerIds)
        .eq('transaction_type', 'BUY').order('transaction_date', { ascending: true });

      let monthlyCashFlow = 0, cagr = null;
      const totalInvested = totalInvestedFromPositions;

      if (buyTxns && buyTxns.length > 1) {
        const first = new Date(buyTxns[0].transaction_date);
        const last = new Date(buyTxns[buyTxns.length - 1].transaction_date);
        const months = Math.max(1, (last - first) / (30.44 * 24 * 3600 * 1000));
        const txInvested = buyTxns.reduce((s, t) => {
          const cur = t.positions?.assets?.currency || prefCur;
          return s + (t.eur_total ? Math.abs(t.eur_total) : parseFloat(t.quantity || 0) * parseFloat(t.price || 0) * (rates[cur] || 1));
        }, 0);
        // Use tx-based amount for cash-flow cadence; fall back to position-based if txns are sparse
        const investedForFlow = txInvested > 0 ? txInvested : totalInvested;
        monthlyCashFlow = investedForFlow / months;
      }
      // Rentabilidad anualizada = la MISMA cifra que la pantalla de brokers (TWR
      // anualizado desde el primer día invertido), leída de la serie que ya
      // calculó el Dashboard. Antes se anualizaba valor/coste entre la primera y
      // la ÚLTIMA compra: a quien dejó de comprar hace un año le inflaba el CAGR,
      // y además suponía todo el dinero invertido el primer día. Sin serie a mano
      // no se inventa: queda null y la calculadora usa su valor por defecto.
      cagr = annualizedTwrFromSeries(peekPerformanceSeries({ userId: user.id, brokerId: 'general', currency: prefCur }));
      setCalcData({ value: portfolioValue, totalInvested, monthlyCashFlow, cagr, currency: prefCur });
    } catch (e) { console.warn('Calc data load failed:', e); }
  };

  // ─── Shared nav link style ────────────────────────────────────────────────

  const topNavLink = ({ isActive }) =>
    `relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold transition-all duration-150 ${
      isActive
        ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/10'
        : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800/60'
    }`;

  return (
    <div className={`min-h-screen ${darkMode ? 'dark' : ''}`} data-privacy={privacyMode ? 'on' : 'off'}>
      {overlayTicker && (
        <GlobalSearchOverlay ticker={overlayTicker} onClose={() => setOverlayTicker(null)} userId={user?.id} />
      )}

      <div className="flex flex-col h-screen bg-slate-50 dark:bg-slate-900 ledger-grid overflow-hidden">

        {/* ── TOP NAV BAR ───────────────────────────────────────────────────── */}
        <header className="shrink-0 h-14 bg-white/95 dark:bg-slate-950/95 backdrop-blur-md border-b border-slate-200/80 dark:border-slate-800 relative z-70 px-4 lg:px-6">
          <div className="flex items-center gap-3 h-full">

            {/* Logo */}
            <NavLink to="/app" className="flex items-center gap-2.5 shrink-0 mr-1">
              <div className="bg-blue-500 p-1.5 rounded-xl shadow-md shadow-blue-500/25">
                <TrendingUp className="w-4 h-4 text-white" />
              </div>
              <span className="font-display text-lg font-black tracking-tight text-slate-900 dark:text-white hidden sm:block">{t('nav.brand')}</span>
            </NavLink>

            {/* Desktop nav links */}
            <nav className="hidden lg:flex items-center gap-0.5 shrink-0">
              {navItems.map(item => (
                <NavLink key={item.path} to={item.path} end={item.path === '/app'} onClick={() => setOverlayTicker(null)} className={topNavLink}>
                  {({ isActive }) => (
                    <>
                      <item.icon className="w-3.5 h-3.5" />
                      <span>{item.label}</span>
                      {/* Active underline */}
                      {isActive && <span className="absolute bottom-0 left-3 right-3 h-0.5 bg-blue-500 dark:bg-blue-400 rounded-full" />}
                    </>
                  )}
                </NavLink>
              ))}
            </nav>

            {/* Separator */}
            <div className="hidden lg:block w-px h-5 bg-slate-200 dark:bg-slate-700 shrink-0 mx-1" />

            {/* Search bar — grows to fill all available space */}
            <GlobalSearchBar userId={user?.id} onOpenTicker={setOverlayTicker} shortcutEnabled={!overlayTicker} />

            {/* Right-side actions — always at the far right */}
            <div className="flex items-center gap-1 shrink-0 ml-auto pl-2">

              {/* Privacy toggle — desktop only */}
              <button onClick={togglePrivacyMode}
                className={`hidden lg:flex p-2 rounded-xl transition-all ${privacyMode ? 'text-amber-500 bg-amber-50 dark:bg-amber-500/10 hover:bg-amber-100 dark:hover:bg-amber-500/20' : 'text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                title={privacyMode ? t('nav.privacy_show') : t('nav.privacy_hide')}
              >
                {privacyMode ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>

              {/* Dark mode toggle — desktop only */}
              <button onClick={toggleDarkMode}
                className="hidden lg:flex p-2 rounded-xl text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all"
                title={darkMode ? t('nav.light_mode') : t('nav.dark_mode')}
              >
                {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </button>

              {/* Calculator toggle */}
              <button onClick={openCalculator}
                className={`hidden lg:flex p-2 rounded-xl transition-all ${calcOpen ? 'text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-500/10' : 'text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                title={t('nav.calculator_title')}
              >
                <Calculator className="w-4 h-4" />
              </button>

              {/* Backtest / time machine — visible on mobile too (it's a page, not an overlay) */}
              <button onClick={() => navigate('/app/backtest')}
                className={`flex p-2 rounded-xl transition-all ${location.pathname === '/app/backtest' ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/10' : 'text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                title={t('nav.backtest_title')}
              >
                <History className="w-4 h-4" />
              </button>

              {/* ── Notifications bell ──────────────────────────────────── */}
              <div className="relative" ref={notifRef}>
                <button
                  onClick={openNotifications}
                  className={`relative p-2 rounded-xl transition-all ${notifOpen ? 'bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400' : 'text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                  title={t('nav.notif_title')}
                >
                  <Bell className="w-4 h-4" />
                  {unreadCount > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 bg-red-500 text-white text-[9px] font-black flex items-center justify-center px-1 rounded-full shadow-xs">
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                  )}
                </button>

                {/* Notifications panel */}
                <AnimatePresence>
                  {notifOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: -8, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -8, scale: 0.97 }}
                      transition={{ duration: 0.15, ease: 'easeOut' }}
                      className="absolute right-0 top-full mt-2 w-80 bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200/80 dark:border-slate-700/60 overflow-hidden z-80"
                    >
                      {/* Header */}
                      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 dark:border-slate-800">
                        <div className="flex items-center gap-2">
                          <Bell className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
                          <span className="text-sm font-bold text-slate-900 dark:text-white">{t('nav.notif_title')}</span>
                          {unreadCount > 0 && (
                            <span className="text-[10px] font-bold bg-red-500 text-white px-1.5 py-0.5 rounded-full">{unreadCount}</span>
                          )}
                        </div>
                        {unreadCount > 0 && (
                          <button onClick={markAllRead}
                            className="flex items-center gap-1 text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
                          >
                            <CheckCheck className="w-3 h-3" /> {t('nav.notif_mark_read')}
                          </button>
                        )}
                      </div>

                      {/* List */}
                      <div className="max-h-80 overflow-y-auto">
                        {notifLoading ? (
                          <div className="flex items-center justify-center py-8">
                            <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
                          </div>
                        ) : notifications.length === 0 ? (
                          <div className="flex flex-col items-center justify-center py-8 gap-2">
                            <Bell className="w-8 h-8 text-slate-200 dark:text-slate-700" />
                            <p className="text-sm text-slate-400">{t('nav.notif_empty')}</p>
                          </div>
                        ) : (
                          notifications.map(n => {
                            const { Icon, color, bg } = getNotifConfig(n.title || '', n.type);
                            const timeAgo = (() => {
                              const diff = Date.now() - new Date(n.created_at).getTime();
                              const mins = Math.floor(diff / 60000);
                              if (mins < 1) return t('nav.notif_now');
                              if (mins < 60) return `${mins}m`;
                              const hrs = Math.floor(mins / 60);
                              if (hrs < 24) return `${hrs}h`;
                              return `${Math.floor(hrs / 24)}d`;
                            })();
                            return (
                              <div key={n.id}
                                onClick={n.link ? () => {
                                  setNotifOpen(false);
                                  if (!n.is_read) {
                                    supabase.from('notifications').update({ is_read: true }).eq('id', n.id).eq('user_id', user.id).then(() => {});
                                    setNotifications(prev => prev.map(x => x.id === n.id ? { ...x, is_read: true } : x));
                                    setUnreadCount(c => Math.max(0, c - 1));
                                  }
                                  navigate(n.link);
                                } : undefined}
                                className={`flex gap-3 px-4 py-3 border-b last:border-0 border-slate-50 dark:border-slate-800/60 transition-colors ${n.link ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/60' : ''} ${n.is_read ? '' : 'bg-blue-50/40 dark:bg-blue-900/10'}`}
                              >
                                <div className={`shrink-0 w-7 h-7 rounded-lg ${bg} flex items-center justify-center mt-0.5`}>
                                  <Icon className={`w-3.5 h-3.5 ${color}`} />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-start justify-between gap-1">
                                    <p className={`text-xs font-semibold leading-snug ${n.is_read ? 'text-slate-500 dark:text-slate-400' : 'text-slate-900 dark:text-white'}`}>
                                      {n.title}
                                    </p>
                                    <span className="text-[10px] text-slate-400 shrink-0 mt-0.5">{timeAgo}</span>
                                  </div>
                                  {n.message && (
                                    <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5 line-clamp-2">{n.message}</p>
                                  )}
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>

                      {/* Footer */}
                      <button
                        onClick={() => { setNotifOpen(false); navigate('/app/notificaciones'); }}
                        className="w-full flex items-center justify-center gap-1.5 py-3 text-sm font-semibold text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10 border-t border-slate-100 dark:border-slate-800 transition-colors"
                      >
                        {t('nav.notif_view_all')} <ChevronRight className="w-3.5 h-3.5" />
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* ── User avatar menu ────────────────────────────────────── */}
              <div className="relative" ref={userMenuRef}>
                <button
                  onClick={() => setUserMenuOpen(prev => !prev)}
                  className={`flex items-center gap-2 pl-1 pr-2 py-1 rounded-xl transition-all ${userMenuOpen ? 'bg-slate-100 dark:bg-slate-800' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                >
                  <div className={`w-7 h-7 rounded-lg bg-linear-to-br ${avatarGradient} flex items-center justify-center shrink-0 shadow-xs`}>
                    <span className="text-[11px] font-extrabold text-white tracking-tight">{initials}</span>
                  </div>
                  <span className="hidden md:block text-xs font-semibold text-slate-600 dark:text-slate-300 max-w-[80px] truncate">
                    {emailName}
                  </span>
                </button>

                {/* User dropdown */}
                <AnimatePresence>
                  {userMenuOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: -8, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -8, scale: 0.97 }}
                      transition={{ duration: 0.15, ease: 'easeOut' }}
                      className="absolute right-0 top-full mt-2 w-56 bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200/80 dark:border-slate-700/60 overflow-hidden z-80"
                    >
                      {/* User info */}
                      <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800">
                        <div className="flex items-center gap-2.5">
                          <div className={`w-9 h-9 rounded-xl bg-linear-to-br ${avatarGradient} flex items-center justify-center shadow-xs shrink-0`}>
                            <span className="text-sm font-extrabold text-white">{initials}</span>
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-bold text-slate-900 dark:text-white truncate">{emailName}</p>
                            <p className="text-[11px] text-slate-400 truncate">{user?.email}</p>
                          </div>
                        </div>
                      </div>

                      {/* Menu items */}
                      <div className="px-2 py-2 space-y-0.5">
                        <NavLink to="/app/settings" onClick={() => setUserMenuOpen(false)}
                          className="flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white transition-all"
                        >
                          <Settings className="w-4 h-4" /> {t('nav.settings')}
                        </NavLink>
                        {isAdmin && (
                          <NavLink to="/app/admin" onClick={() => setUserMenuOpen(false)}
                            className="flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white transition-all"
                          >
                            <ShieldCheck className="w-4 h-4" /> {t('nav.admin_dashboard')}
                          </NavLink>
                        )}
                      </div>

                      <div className="px-2 pb-2 pt-0.5 border-t border-slate-100 dark:border-slate-800">
                        <button onClick={() => signOut()}
                          className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-400 transition-all"
                        >
                          <LogOut className="w-4 h-4" /> {t('nav.sign_out')}
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Mobile hamburger */}
              <button
                onClick={() => setMobileMenuOpen(true)}
                className="lg:hidden p-2 rounded-xl text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all ml-0.5"
              >
                <Menu className="w-4 h-4" />
              </button>
            </div>
          </div>
        </header>

        {/* ── MAIN CONTENT ─────────────────────────────────────────────────── */}
        <main className="flex-1 overflow-y-auto p-4 md:p-6 w-full relative">
          <AnimatePresence>
            {isDemoMode && (
              <motion.div
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="mb-6 p-5 rounded-2xl bg-white/5 dark:bg-slate-800/40 backdrop-blur-md border border-slate-200 dark:border-white/10 shadow-xl shadow-blue-500/5 bg-linear-to-r from-blue-600/10 via-transparent to-transparent flex flex-col md:flex-row items-center justify-between gap-4 group transition-all hover:bg-white/10 dark:hover:bg-slate-800/60"
              >
                <div className="flex items-center gap-4">
                  <div className="bg-blue-500 p-2.5 rounded-xl shadow-lg shadow-blue-500/20 group-hover:scale-110 transition-transform">
                    <TrendingUp className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                      {t('demo_mode.title')}
                      <span className="text-[10px] bg-blue-500/20 text-blue-600 dark:text-blue-400 px-1.5 py-0.5 rounded-md border border-blue-500/20 uppercase tracking-wider font-black">{t('demo_mode.beta')}</span>
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 max-w-lg mt-0.5 leading-relaxed">
                      {t('demo_mode.description')}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => signOut()}
                  className="px-5 py-2.5 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-900 dark:text-white text-xs font-bold rounded-xl transition-all shadow-md border border-slate-200 dark:border-slate-700 hover:border-blue-400 dark:hover:border-blue-500 shrink-0 flex items-center gap-2"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  {t('demo_mode.exit')}
                </button>
              </motion.div>
            )}

          </AnimatePresence>
          <Outlet />
        </main>

        {welcomeOpen && (
          <WelcomeSetupDialog
            open={welcomeOpen}
            onClose={() => setWelcomeOpen(false)}
            darkMode={darkMode}
            onPreviewDarkMode={applyDarkMode}
          />
        )}

        {/* ── CALCULATOR OVERLAY ──────────────────────────────────────────── */}
        <AnimatePresence>
          {calcOpen && (
            <>
              <motion.div
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="fixed inset-0 bg-black/60 backdrop-blur-xs z-90"
                onClick={() => setCalcOpen(false)}
              />
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 20 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                className="fixed inset-4 sm:inset-8 md:inset-y-10 md:inset-x-[10%] lg:inset-y-8 lg:inset-x-[20%] z-95 flex flex-col"
              >
                {/* Close button */}
                <div className="flex justify-end mb-2">
                  <button
                    onClick={() => setCalcOpen(false)}
                    className="p-2 rounded-xl bg-white/10 hover:bg-white/20 text-white transition-all"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
                {/* Calculator with scroll */}
                <div className="flex-1 overflow-y-auto rounded-2xl">
                  <CompoundInterestCalculator
                    portfolioValue={calcData.value}
                    totalInvested={calcData.totalInvested || 0}
                    monthlyCashFlow={calcData.monthlyCashFlow}
                    portfolioCagr={calcData.cagr}
                    preferredCurrency={calcData.currency}
                  />
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>

        {/* ── MOBILE DRAWER ────────────────────────────────────────────────── */}
        <AnimatePresence>
          {mobileMenuOpen && (
            <>
              <motion.div
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="fixed inset-0 bg-black/50 z-75 lg:hidden"
                onClick={() => setMobileMenuOpen(false)}
              />
              <motion.div
                initial={{ x: '-100%' }} animate={{ x: 0 }} exit={{ x: '-100%' }}
                transition={{ type: 'spring', stiffness: 320, damping: 32 }}
                className="fixed inset-y-0 left-0 z-76 w-64 bg-white dark:bg-slate-950 border-r border-slate-200/80 dark:border-slate-800 flex flex-col lg:hidden"
              >
                {/* Drawer header */}
                <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="bg-blue-500 p-1.5 rounded-xl shadow-md shadow-blue-500/25">
                      <TrendingUp className="w-4 h-4 text-white" />
                    </div>
                    <span className="font-display text-lg font-black tracking-tight text-slate-900 dark:text-white">{t('nav.brand')}</span>
                  </div>
                  <button onClick={() => setMobileMenuOpen(false)} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all">
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Drawer nav */}
                <nav className="flex-1 px-3 py-3 space-y-0.5">
                  {navItems.map(item => (
                    <NavLink
                      key={item.path}
                      to={item.path}
                      end={item.path === '/app'}
                      onClick={() => setMobileMenuOpen(false)}
                      className={({ isActive }) =>
                        `flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all relative overflow-hidden ${isActive
                          ? 'bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400'
                          : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60 hover:text-slate-800 dark:hover:text-slate-200'
                        }`
                      }
                    >
                      {({ isActive }) => (
                        <>
                          {isActive && <span className="absolute left-0 inset-y-2 w-[3px] bg-blue-500 rounded-r-full" />}
                          <item.icon className="w-4 h-4 shrink-0" />
                          <span className={`text-sm ${isActive ? 'font-semibold' : 'font-medium'}`}>{item.label}</span>
                        </>
                      )}
                    </NavLink>
                  ))}
                  <NavLink to="/app/notificaciones" onClick={() => setMobileMenuOpen(false)}
                    className={({ isActive }) =>
                      `flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all relative overflow-hidden ${isActive
                        ? 'bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400'
                        : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60'
                      }`
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && <span className="absolute left-0 inset-y-2 w-[3px] bg-blue-500 rounded-r-full" />}
                        <Bell className="w-4 h-4 shrink-0" />
                        <span className={`text-sm ${isActive ? 'font-semibold' : 'font-medium'}`}>{t('nav.notifications')}</span>
                        {unreadCount > 0 && (
                          <span className="ml-auto bg-red-500 text-white text-[10px] font-bold min-w-[18px] h-[18px] flex items-center justify-center px-1 rounded-full">
                            {unreadCount > 99 ? '99+' : unreadCount}
                          </span>
                        )}
                      </>
                    )}
                  </NavLink>
                  <NavLink to="/app/settings" onClick={() => setMobileMenuOpen(false)}
                    className={({ isActive }) =>
                      `flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all relative overflow-hidden ${isActive
                        ? 'bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400'
                        : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60'
                      }`
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && <span className="absolute left-0 inset-y-2 w-[3px] bg-blue-500 rounded-r-full" />}
                        <Settings className="w-4 h-4 shrink-0" />
                        <span className={`text-sm ${isActive ? 'font-semibold' : 'font-medium'}`}>{t('nav.settings')}</span>
                      </>
                    )}
                  </NavLink>
                </nav>

                {/* Drawer footer */}
                <div className="px-3 py-3 border-t border-slate-100 dark:border-slate-800 space-y-0.5">
                  <button onClick={togglePrivacyMode}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${privacyMode ? 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60 hover:text-slate-800 dark:hover:text-slate-200'}`}
                  >
                    {privacyMode ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    {privacyMode ? t('nav.show_figures') : t('nav.hide_figures')}
                  </button>
                  <button onClick={toggleDarkMode}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60 hover:text-slate-800 dark:hover:text-slate-200 transition-all"
                  >
                    {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                    {darkMode ? t('nav.light_mode') : t('nav.dark_mode')}
                  </button>
                  <button onClick={() => { setMobileMenuOpen(false); openCalculator(); }}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-slate-500 dark:text-slate-400 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 hover:text-indigo-600 dark:hover:text-indigo-400 transition-all"
                  >
                    <Calculator className="w-4 h-4" /> {t('nav.calculator')}
                  </button>
                  <button onClick={() => signOut()}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-slate-500 dark:text-slate-400 hover:bg-red-50 dark:hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400 transition-all"
                  >
                    <LogOut className="w-4 h-4" /> {t('nav.sign_out')}
                  </button>
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>

      <ErrorBoundary title={t('common.chat')}>
        <PortfolioChatWidget />
      </ErrorBoundary>
    </div>
  );
};

const DashboardLayout = () => {
  const { user } = useSupabaseAuth();
  return (
    <PortfolioDataProvider>
      <PrivacyModeProvider userId={user?.id}>
        <DashboardLayoutInner />
      </PrivacyModeProvider>
    </PortfolioDataProvider>
  );
};

export default DashboardLayout;
