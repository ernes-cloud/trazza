import React, { useMemo, useState } from 'react';
import { Helmet } from 'react-helmet';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Bell, Check, Trash2, CheckCheck, Loader2, X } from 'lucide-react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/customSupabaseClient';
import { useSupabaseAuth } from '@/contexts/SupabaseAuthContext';
import { useToast } from '@/components/ui/use-toast';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { getNotifConfig } from '@/lib/notifConfig';

const PAGE_SIZE = 50;

const groupNotifications = (notifications, t) => {
  const groups = {};
  const now = new Date();
  const todayStr = now.toDateString();
  const yesterdayStr = new Date(now - 86400000).toDateString();
  const locale = t('notifications_page.date_locale');
  notifications.forEach(n => {
    const d = new Date(n.created_at);
    let label;
    if (d.toDateString() === todayStr) label = t('notifications_page.today');
    else if (d.toDateString() === yesterdayStr) label = t('notifications_page.yesterday');
    else label = d.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });
    if (!groups[label]) groups[label] = [];
    groups[label].push(n);
  });
  return groups;
};

const NotificationsPage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useSupabaseAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isClearConfirmOpen, setIsClearConfirmOpen] = useState(false);

  const QUERY_KEY = ['notifications', user?.id];

  // Por páginas: la tabla crece sin límite (cada aviso del cron es una fila) y
  // antes se leía entera de una vez.
  const {
    data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: QUERY_KEY,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const { data: rows, error } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .range(pageParam, pageParam + PAGE_SIZE - 1);
      if (error) throw error;
      return rows || [];
    },
    getNextPageParam: (last, pages) => (last.length < PAGE_SIZE ? undefined : pages.length * PAGE_SIZE),
    enabled: !!user,
    staleTime: 30_000,
  });
  const notifications = useMemo(() => (data?.pages || []).flat(), [data]);

  // Cambia las filas en caché sin perder la paginación.
  const patchCache = (fn) => queryClient.setQueryData(QUERY_KEY, (old) => (
    old ? { ...old, pages: old.pages.map((page) => fn(page)) } : old
  ));
  const optimistic = (fn) => async () => {
    await queryClient.cancelQueries({ queryKey: QUERY_KEY });
    const previous = queryClient.getQueryData(QUERY_KEY);
    patchCache(fn);
    return { previous };
  };
  // supabase-js NO lanza cuando falla una escritura: devuelve { error }. Sin
  // lanzarlo, onError no se ejecutaba nunca y la pantalla daba por hecho un
  // cambio que no se había guardado (al recargar, la notificación volvía).
  const failWith = (titleKey) => (_err, _vars, ctx) => {
    if (ctx?.previous) queryClient.setQueryData(QUERY_KEY, ctx.previous);
    toast({ title: t(titleKey), variant: 'destructive' });
  };

  const markAsReadMutation = useMutation({
    mutationFn: async (id) => {
      const { error } = await supabase.from('notifications').update({ is_read: true }).eq('id', id).eq('user_id', user.id);
      if (error) throw error;
    },
    onMutate: (id) => optimistic((page) => page.map(n => n.id === id ? { ...n, is_read: true } : n))(),
    onError: failWith('common.error_save'),
  });

  const deleteOneMutation = useMutation({
    mutationFn: async (id) => {
      const { error } = await supabase.from('notifications').delete().eq('id', id).eq('user_id', user.id);
      if (error) throw error;
    },
    onMutate: (id) => optimistic((page) => page.filter(n => n.id !== id))(),
    onError: failWith('common.error_delete'),
  });

  // "Todas" son todas las del usuario, no solo las páginas cargadas.
  const markAllReadMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('notifications').update({ is_read: true }).eq('user_id', user.id).eq('is_read', false);
      if (error) throw error;
    },
    onMutate: () => optimistic((page) => page.map(n => ({ ...n, is_read: true })))(),
    onSuccess: () => toast({ title: t('notifications_page.toast_mark_read') }),
    onError: failWith('common.error_save'),
  });

  const clearAllMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('notifications').delete().eq('user_id', user.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.setQueryData(QUERY_KEY, (old) => (old ? { pages: [[]], pageParams: [0] } : old));
      setIsClearConfirmOpen(false);
      toast({ title: t('notifications_page.toast_deleted') });
    },
    onError: failWith('common.error_delete'),
  });

  const unreadCount = notifications.filter(n => !n.is_read).length;
  const groups = groupNotifications(notifications, t);

  // Con más páginas por cargar, el total es "50+": no se cuenta lo no leído.
  const shownTotal = hasNextPage ? `${notifications.length}+` : notifications.length;
  const subtitleText = (() => {
    if (notifications.length === 0) return t('notifications_page.no_notifications');
    if (unreadCount > 0) return t('notifications_page.unread_total', { count: unreadCount, total: shownTotal });
    return t('notifications_page.all_read', { total: shownTotal });
  })();

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      <Helmet><title>{t('notifications_page.page_title')}</title></Helmet>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-black tracking-tight text-slate-900 dark:text-white">
            {t('notifications_page.title')}
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{subtitleText}</p>
        </div>
        {notifications.length > 0 && (
          <div className="flex gap-2 shrink-0">
            {unreadCount > 0 && (
              <Button variant="outline" size="sm"
                onClick={() => markAllReadMutation.mutate()}
                className="gap-1.5 text-slate-600 dark:text-slate-300 text-xs"
              >
                <CheckCheck className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{t('notifications_page.mark_all')}</span>
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setIsClearConfirmOpen(true)}
              className="gap-1.5 text-rose-500 border-rose-200 hover:bg-rose-50 dark:border-rose-800/40 dark:hover:bg-rose-900/20 text-xs"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('notifications_page.delete_all')}</span>
            </Button>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="p-16 flex justify-center">
          <Loader2 className="w-7 h-7 animate-spin text-blue-500" />
        </div>
      ) : notifications.length === 0 ? (
        <div className="p-16 text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
            <Bell className="w-8 h-8 text-slate-300 dark:text-slate-600" />
          </div>
          <p className="font-bold text-slate-500 dark:text-slate-400">{t('notifications_page.no_notifications')}</p>
          <p className="text-sm text-slate-400 dark:text-slate-500 mt-1 max-w-xs mx-auto">
            {t('notifications_page.empty_desc')}
          </p>
        </div>
      ) : (
        <div className="space-y-7">
          {Object.entries(groups).map(([dateLabel, items]) => (
            <div key={dateLabel}>
              <div className="flex items-center gap-3 mb-3">
                <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 shrink-0">{dateLabel}</p>
                <div className="flex-1 h-px bg-slate-100 dark:bg-slate-800" />
                <p className="text-[10px] text-slate-300 dark:text-slate-600 shrink-0 tabular-nums">{items.length}</p>
              </div>

              <div className="space-y-2">
                {items.map(note => {
                  const { Icon, color, bg, border, unreadBg } = getNotifConfig(note.title, note.type);
                  // Deep-linked notifications (e.g. blog articles) open on click
                  const openLink = note.link ? () => {
                    if (!note.is_read) markAsReadMutation.mutate(note.id);
                    navigate(note.link);
                  } : undefined;
                  return (
                    <div key={note.id}
                      onClick={openLink}
                      className={`group relative flex items-start gap-3 p-4 rounded-xl border border-l-[3px] ${border} transition-all duration-150
                        ${note.link ? 'cursor-pointer hover:shadow-md' : ''}
                        ${note.is_read
                          ? 'bg-white dark:bg-slate-900/50 border-slate-100 dark:border-slate-800/60'
                          : unreadBg
                        }`}
                    >
                      {!note.is_read && (
                        <span className="absolute top-4 right-4 w-2 h-2 rounded-full bg-blue-500 shrink-0" />
                      )}
                      <div className={`shrink-0 mt-0.5 p-2 rounded-lg ${bg}`}>
                        <Icon className={`w-4 h-4 ${color}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={`font-bold text-sm leading-snug ${note.is_read ? 'text-slate-500 dark:text-slate-400' : 'text-slate-900 dark:text-white'}`}>
                          {note.title}
                        </p>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">{note.message}</p>
                        <p className="text-[10px] text-slate-400 mt-1.5 tabular-nums">
                          {new Date(note.created_at).toLocaleString(t('notifications_page.date_locale'), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity mt-0.5">
                        {!note.is_read && (
                          <button onClick={(e) => { e.stopPropagation(); markAsReadMutation.mutate(note.id); }} title={t('notifications_page.mark_as_read')}
                            className="p-1.5 rounded-lg hover:bg-emerald-100 dark:hover:bg-emerald-900/30 text-emerald-500 transition-colors"
                          >
                            <Check className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button onClick={(e) => { e.stopPropagation(); deleteOneMutation.mutate(note.id); }} title={t('notifications_page.delete')}
                          className="p-1.5 rounded-lg hover:bg-rose-100 dark:hover:bg-rose-900/30 text-slate-300 hover:text-rose-500 transition-colors"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {hasNextPage && (
            <div className="flex justify-center">
              <Button variant="outline" size="sm" onClick={() => fetchNextPage()} disabled={isFetchingNextPage} className="gap-1.5 text-xs">
                {isFetchingNextPage && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {t('notifications_page.load_more')}
              </Button>
            </div>
          )}
        </div>
      )}

      <Dialog open={isClearConfirmOpen} onOpenChange={setIsClearConfirmOpen}>
        <DialogContent className="max-w-sm dark:bg-slate-900 border-none">
          <DialogHeader>
            <DialogTitle className="dark:text-white">{t('notifications_page.confirm_delete_title')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('notifications_page.confirm_delete_desc')}</p>
          <DialogFooter className="flex gap-2 mt-4">
            <Button variant="outline" onClick={() => setIsClearConfirmOpen(false)} className="flex-1">
              {t('notifications_page.cancel')}
            </Button>
            <Button variant="destructive" onClick={() => clearAllMutation.mutate()} disabled={clearAllMutation.isPending} className="flex-1">
              {clearAllMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : t('notifications_page.confirm_yes')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default NotificationsPage;
