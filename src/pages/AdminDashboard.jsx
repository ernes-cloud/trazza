import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Helmet } from 'react-helmet';
import { useNavigate } from 'react-router-dom';
import { Loader2, Users, ShieldCheck, RefreshCw, Search, Server, Zap } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { fmtNum, fmtDate, adminFetch } from '@/components/admin/adminUtils';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { supabase } from '@/lib/customSupabaseClient';

function healthStatusKey(status) {
  if (status === 'ok') return 'admin.health_ok';
  if (status === 'degraded') return 'admin.health_degraded';
  if (status === 'down') return 'admin.health_down';
  return 'admin.health_unconfigured';
}

function LimitRow({ label, limits }) {
  if (!limits) return null;
  const daily = limits.daily == null ? '∞' : fmtNum(limits.daily);
  const monthly = limits.monthly == null ? '∞' : fmtNum(limits.monthly);
  return (
    <tr className="border-b border-slate-50 dark:border-slate-700/30 last:border-0">
      <td className="px-5 py-2.5 text-sm font-medium text-slate-800 dark:text-slate-100">{label}</td>
      <td className="px-3 py-2.5 text-sm text-slate-600 dark:text-slate-300 text-right tabular-nums">{daily}</td>
      <td className="px-5 py-2.5 text-sm text-slate-600 dark:text-slate-300 text-right tabular-nums">{monthly}</td>
    </tr>
  );
}

export default function AdminDashboard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { isAdmin, loading: planLoading } = useIsAdmin();

  const [activeTab, setActiveTab] = useState('users');

  const [users, setUsers] = useState([]);
  const [usersPage, setUsersPage] = useState(1);
  const [usersTotal, setUsersTotal] = useState(0);
  const [usersLoad, setUsersLoad] = useState(false);
  const [userSearch, setUserSearch] = useState('');
  const searchTimer = useRef(null);

  const [health, setHealth] = useState(null);
  const [healthLoad, setHealthLoad] = useState(false);

  const [aiLimits, setAiLimits] = useState(null);
  const [aiLimitsLoad, setAiLimitsLoad] = useState(false);

  const fetchUsers = useCallback(async (page = 1, q = '') => {
    setUsersLoad(true);
    try {
      const params = new URLSearchParams({ page: String(page), ...(q ? { q } : {}) });
      const resp = await adminFetch(`/api/admin/users?${params}`);
      if (!resp.ok) {
        const b = await resp.json().catch(() => ({}));
        toast({ variant: 'destructive', title: t('admin.users_error'), description: b.error || `HTTP ${resp.status}` });
        return;
      }
      const data = await resp.json();
      setUsers(data.users || []);
      setUsersTotal(data.total || 0);
      setUsersPage(page);
    } catch (err) {
      console.error('[AdminDashboard] users error:', err);
      toast({ variant: 'destructive', title: t('admin.users_error'), description: err.message });
    } finally {
      setUsersLoad(false);
    }
  }, [t, toast]);

  const fetchHealth = useCallback(async () => {
    setHealthLoad(true);
    try {
      const resp = await adminFetch('/api/admin/health');
      if (resp.ok) setHealth(await resp.json());
      else setHealth(null);
    } catch (err) {
      console.error('[AdminDashboard] health error:', err);
      setHealth(null);
    } finally {
      setHealthLoad(false);
    }
  }, []);

  const fetchAiLimits = useCallback(async () => {
    setAiLimitsLoad(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setAiLimits(null);
        return;
      }
      const resp = await fetch('/api/ai/limits', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok) setAiLimits(await resp.json());
      else setAiLimits(null);
    } catch (err) {
      console.error('[AdminDashboard] ai limits error:', err);
      setAiLimits(null);
    } finally {
      setAiLimitsLoad(false);
    }
  }, []);

  useEffect(() => {
    if (!planLoading && !isAdmin) navigate('/app', { replace: true });
  }, [planLoading, isAdmin, navigate]);

  useEffect(() => {
    if (!isAdmin) return;
    if (activeTab === 'users') fetchUsers(1, userSearch);
    if (activeTab === 'system') {
      fetchHealth();
      fetchAiLimits();
    }
  }, [activeTab, isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = (e) => {
    const v = e.target.value;
    setUserSearch(v);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => fetchUsers(1, v), 350);
  };

  if (planLoading) {
    return (
      <div className="flex items-center justify-center min-h-[40vh] gap-3 text-slate-400">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm">{t('admin.loading')}</span>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[40vh] gap-2 text-slate-500">
        <ShieldCheck className="w-8 h-8 opacity-40" />
        <p className="text-sm">{t('admin.access_denied')}</p>
      </div>
    );
  }

  return (
  <>
    <Helmet><title>{t('admin.title')}</title></Helmet>
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-black text-slate-900 dark:text-white">{t('admin.title')}</h1>
        <RefreshButton
          onClick={() => (activeTab === 'users' ? fetchUsers(usersPage, userSearch) : (fetchHealth(), fetchAiLimits()))}
          loading={usersLoad || healthLoad || aiLimitsLoad}
          label={t('admin.refresh')}
        />
      </div>

      <div className="flex gap-2 p-1 bg-slate-100 dark:bg-slate-800/60 rounded-xl w-fit">
        <TabBtn active={activeTab === 'users'} onClick={() => setActiveTab('users')} icon={Users} label={t('admin.tab_users')} />
        <TabBtn active={activeTab === 'system'} onClick={() => setActiveTab('system')} icon={Server} label={t('admin.tab_system')} />
      </div>

      {activeTab === 'users' && (
        <div className="bg-white dark:bg-slate-800/80 border border-slate-200/80 dark:border-slate-700/40 rounded-2xl shadow-xs overflow-hidden">
          <div className="p-5 border-b border-slate-100 dark:border-slate-700/40 flex flex-wrap items-center gap-3">
            <h2 className="text-sm font-extrabold text-slate-900 dark:text-white flex-1">{t('admin.user_mgmt_title')}</h2>
            <div className="relative min-w-[200px] flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
              <input
                type="text"
                value={userSearch}
                onChange={handleSearch}
                placeholder={t('admin.user_search_placeholder')}
                className="w-full pl-8 pr-4 py-2 text-sm bg-slate-50 dark:bg-slate-700/50 border border-slate-200 dark:border-slate-600 rounded-xl text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-hidden focus:ring-2 focus:ring-violet-400/50"
              />
            </div>
            <span className="text-[11px] text-slate-400">{fmtNum(usersTotal)} total</span>
          </div>
          <div className="overflow-x-auto min-h-[120px]">
            {usersLoad && !users.length ? (
              <div className="flex items-center justify-center py-12 gap-3">
                <Loader2 className="w-4 h-4 text-violet-400 animate-spin" />
                <span className="text-xs text-slate-400">{t('admin.loading')}</span>
              </div>
            ) : !users.length ? (
              <p className="text-sm text-slate-400 py-10 text-center">{t('admin.user_no_results')}</p>
            ) : (
              <table className="w-full">
                <thead className="bg-slate-50 dark:bg-slate-900/30">
                  <tr className="border-b border-slate-100 dark:border-slate-700/40">
                    <th className="px-5 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wider">Email</th>
                    <th className="px-3 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('admin.user_registered')}</th>
                    <th className="px-3 py-3 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wider hidden md:table-cell">{t('admin.user_last_login')}</th>
                    <th className="px-5 py-3 text-right text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('admin.col_total')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50 dark:divide-slate-700/30">
                  {users.map((u) => (
                    <tr key={u.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-700/20">
                      <td className="px-5 py-3 text-sm font-medium text-slate-800 dark:text-slate-100 truncate max-w-[240px]">{u.email}</td>
                      <td className="px-3 py-3 text-xs text-slate-500">{fmtDate(u.createdAt)}</td>
                      <td className="px-3 py-3 text-xs text-slate-500 hidden md:table-cell">{u.lastSignIn ? fmtDate(u.lastSignIn) : t('admin.user_never')}</td>
                      <td className="px-5 py-3 text-sm text-right tabular-nums text-slate-600 dark:text-slate-300">{fmtNum(u.totalCalls)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {Math.ceil(usersTotal / 20) > 1 && (
            <div className="flex items-center justify-between px-5 py-4 border-t border-slate-100 dark:border-slate-700/40">
              <button type="button" onClick={() => fetchUsers(usersPage - 1, userSearch)} disabled={usersPage <= 1}
                className="text-xs font-semibold text-slate-500 disabled:opacity-30">
                ← {t('admin.user_prev')}
              </button>
              <span className="text-[11px] text-slate-400">{usersPage} / {Math.ceil(usersTotal / 20)}</span>
              <button type="button" onClick={() => fetchUsers(usersPage + 1, userSearch)} disabled={usersPage >= Math.ceil(usersTotal / 20)}
                className="text-xs font-semibold text-slate-500 disabled:opacity-30">
                {t('admin.user_next')} →
              </button>
            </div>
          )}
        </div>
      )}

      {activeTab === 'system' && (
        <div className="space-y-5">
          <div className="bg-white dark:bg-slate-800/80 border border-slate-200/80 dark:border-slate-700/40 rounded-2xl shadow-xs overflow-hidden">
            <div className="p-5 border-b border-slate-100 dark:border-slate-700/40 flex items-center gap-2">
              <Zap className="w-4 h-4 text-violet-500" />
              <h2 className="text-sm font-extrabold text-slate-900 dark:text-white">{t('admin.ai_by_feature')}</h2>
              {aiLimitsLoad && <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-400 ml-auto" />}
            </div>
            {!aiLimits && !aiLimitsLoad ? (
              <p className="text-sm text-slate-400 py-8 text-center">—</p>
            ) : (
              <table className="w-full">
                <thead className="bg-slate-50 dark:bg-slate-900/30">
                  <tr>
                    <th className="px-5 py-2 text-left text-[10px] font-bold text-slate-400 uppercase">{t('admin.col_feature')}</th>
                    <th className="px-3 py-2 text-right text-[10px] font-bold text-slate-400 uppercase">{t('admin.col_today')}</th>
                    <th className="px-5 py-2 text-right text-[10px] font-bold text-slate-400 uppercase">{t('admin.col_month')}</th>
                  </tr>
                </thead>
                <tbody>
                  <LimitRow label={t('admin.feature_chat')} limits={aiLimits?.chat} />
                  <LimitRow label={t('admin.feature_analysis')} limits={aiLimits?.analysis} />
                  <LimitRow label={t('admin.feature_import')} limits={aiLimits?.import} />
                </tbody>
              </table>
            )}
          </div>

          <div className="bg-white dark:bg-slate-800/80 border border-slate-200/80 dark:border-slate-700/40 rounded-2xl shadow-xs overflow-hidden">
            <div className="p-5 border-b border-slate-100 dark:border-slate-700/40">
              <h2 className="text-sm font-extrabold text-slate-900 dark:text-white">{t('admin.api_health')}</h2>
              {health?.cached && <p className="text-[10px] text-slate-400 mt-0.5">{t('admin.health_cached')}</p>}
            </div>
            {healthLoad && !health ? (
              <div className="flex items-center justify-center py-10 gap-2 text-slate-400">
                <Loader2 className="w-4 h-4 animate-spin" />
              </div>
            ) : (
              <ul className="divide-y divide-slate-50 dark:divide-slate-700/30">
                {(health?.providers || []).map((p) => (
                  <li key={p.provider} className="flex items-center justify-between px-5 py-3 text-sm">
                    <span className="font-medium text-slate-800 dark:text-slate-100">{p.provider}</span>
                    <span className="text-xs text-slate-500">
                      {t(healthStatusKey(p.status))}
                      {p.latencyMs != null ? ` · ${p.latencyMs}ms` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  </>
  );
}

function TabBtn({ active, onClick, icon: Icon, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all ${
        active
          ? 'bg-white dark:bg-slate-700 text-violet-600 dark:text-violet-400 shadow-xs'
          : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
      }`}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  );
}

function RefreshButton({ onClick, loading, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700/50 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-40 transition-colors"
    >
      <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
      {label}
    </button>
  );
}
