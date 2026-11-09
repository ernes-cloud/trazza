import React, { useState, useEffect } from 'react';
import { Helmet } from 'react-helmet';
import { useTranslation } from 'react-i18next';
import { Reorder, useDragControls } from 'framer-motion';
import { Plus, Trash2, Bell, X, Search, Loader2, ExternalLink, Star, GripVertical, Mail, Pencil, ListPlus, RotateCcw } from 'lucide-react';
import ScrollStrip from '@/components/ui/ScrollStrip';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/customSupabaseClient';
import { useSupabaseAuth } from '@/contexts/SupabaseAuthContext';
import { useToast } from '@/components/ui/use-toast';
import { parseAlertTarget, MIN_PERCENT, MAX_PERCENT } from '@/lib/alertTarget';
import { yahooFinanceService } from '@/services/yahooFinance';
import { runPooled } from '@/lib/asyncPool';
import { insertWatchlistItem, persistItemDisplayName, needsNameHealing } from '@/lib/watchlistItems';
import { useTickerSearch } from '@/hooks/useTickerSearch';
import { AssetTypeBadge } from '@/components/AssetTypeBadge';
import { formatNumber, formatPercent, appLocale } from '@/lib/formatters';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import GlobalSearchOverlay from '@/components/GlobalSearchOverlay';

const WatchlistTab = ({ wl, isSelected, onSelect, onEdit, onDelete, t }) => {
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={wl}
      as="div"
      dragListener={false}
      dragControls={controls}
      className="group/tab relative flex items-center shrink-0"
      whileDrag={{ scale: 1.05, boxShadow: '0 4px 16px rgba(0,0,0,0.15)', zIndex: 50 }}
    >
      <div className={`flex items-center gap-0.5 pl-1 pr-12 py-2 rounded-lg text-xs font-bold whitespace-nowrap transition-all border ${
        isSelected
          ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
          : 'bg-white dark:bg-slate-800 border-slate-200/80 dark:border-slate-700/40 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:border-slate-300 dark:hover:border-slate-600'
      }`}>
        <span
          onPointerDown={(e) => controls.start(e)}
          className={`cursor-grab active:cursor-grabbing p-0.5 rounded opacity-0 group-hover/tab:opacity-60 hover:opacity-100! transition-opacity touch-none ${
            isSelected ? 'text-white' : 'text-slate-400 dark:text-slate-500'
          }`}
        >
          <GripVertical className="w-3 h-3 shrink-0" />
        </span>
        <button onClick={onSelect} className="outline-hidden px-1 select-none">
          {wl.name}
        </button>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onEdit(); }}
        className={`absolute right-7 p-0.5 rounded transition-all ${
          isSelected
            ? 'text-white/60 hover:text-white opacity-0 group-hover/tab:opacity-100'
            : 'text-slate-300 dark:text-slate-600 hover:text-blue-500 opacity-0 group-hover/tab:opacity-100'
        }`}
        title={t('favorites.edit_list_tooltip')}
      >
        <Pencil className="w-3 h-3" />
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className={`absolute right-1.5 p-0.5 rounded transition-all ${
          isSelected
            ? 'text-white/60 hover:text-white opacity-0 group-hover/tab:opacity-100'
            : 'text-slate-300 dark:text-slate-600 hover:text-rose-500 opacity-0 group-hover/tab:opacity-100'
        }`}
        title={t('favorites.delete_list_tooltip')}
      >
        <X className="w-3 h-3" />
      </button>
    </Reorder.Item>
  );
};

// Build the display quote shape from a Yahoo quote — shared by the initial load
// and the optimistic add so a freshly added asset renders identically.
const buildQuoteFromYahoo = (q, ticker) => {
  if (!q) return null;
  const sym = q.currency === 'GBP' ? '£' : q.currency === 'EUR' ? '€' : '$';
  return {
    header: {
      name: q.companyName || ticker,
      price: q.current,
      change: `${q.change >= 0 ? '+' : ''}${formatNumber(q.change, 2, 2)} (${formatPercent(q.percentChange, 2)})`,
      pct: q.percentChange,
      isPositive: q.change >= 0,
      currencySymbol: sym,
    },
    metrics: [
      { label: '52W HIGH', value: q.high52 ? `${sym}${q.high52.toLocaleString(appLocale(), { maximumFractionDigits: 2 })}` : 'N/A' },
      { label: '52W LOW',  value: q.low52  ? `${sym}${q.low52.toLocaleString(appLocale(),  { maximumFractionDigits: 2 })}` : 'N/A' },
      { label: 'MARKET CAP', value: q.marketCap ? `${sym}${(q.marketCap / 1e9).toFixed(2)}B` : 'N/A' },
    ],
  };
};

const orderKey = (uid) => `wf_watchlist_order_${uid}`;
const loadSavedOrder = (uid) => { try { return JSON.parse(localStorage.getItem(orderKey(uid)) || '[]'); } catch { return []; } };
const saveOrder = (uid, lists) => { try { localStorage.setItem(orderKey(uid), JSON.stringify(lists.map(w => w.id))); } catch {} };

const FavoritesPage = () => {
  const { t } = useTranslation();
  const { user } = useSupabaseAuth();
  const { toast } = useToast();
  const [watchlists, setWatchlists] = useState([]);
  const [listsLoading, setListsLoading] = useState(true);
  const [selectedList, setSelectedList] = useState(null);
  const [items, setItems] = useState([]);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newListName, setNewListName] = useState('');
  const [editList, setEditList] = useState(null);   // watchlist being renamed
  const [editName, setEditName] = useState('');

  const { query: searchTerm, setQuery: setSearchTerm, results: searchResults,
          isSearching, selectedIndex, onKeyDown: searchKeyDown, clearResults,
        } = useTickerSearch({ debounce: 300, limit: 5 });
  const [overlayTicker, setOverlayTicker] = useState(null);

  const [loadingItems, setLoadingItems] = useState(false);
  const [manageAlertsItem, setManageAlertsItem] = useState(null);
  const [removeConfirmId, setRemoveConfirmId] = useState(null);
  const [deleteListId, setDeleteListId] = useState(null);
  const [itemAlerts, setItemAlerts] = useState([]);
  const [newAlert, setNewAlert] = useState({ type: 'PERCENT_CHANGE', value: '' });

  useEffect(() => {
    if (user) loadWatchlists();
  }, [user]);

  useEffect(() => {
    if (selectedList) loadItems(selectedList.id);
  }, [selectedList]);

  useEffect(() => {
    if (manageAlertsItem) loadAlerts(manageAlertsItem.id);
  }, [manageAlertsItem]);


  const loadWatchlists = async () => {
    const { data } = await supabase
      .from('watchlists').select('*').eq('user_id', user.id).order('created_at', { ascending: true });
    if (data && data.length > 0) {
      const savedOrder = loadSavedOrder(user.id);
      const ordered = savedOrder.length
        ? [...data].sort((a, b) => {
            const ai = savedOrder.indexOf(a.id);
            const bi = savedOrder.indexOf(b.id);
            return (ai === -1 ? 9999 : ai) - (bi === -1 ? 9999 : bi);
          })
        : data;
      setWatchlists(ordered);
      if (!selectedList) setSelectedList(ordered[0]);
    } else {
      setWatchlists([]);
    }
    setListsLoading(false);
  };

  const handleReorderWatchlists = (newOrder) => {
    setWatchlists(newOrder);
    saveOrder(user.id, newOrder);
  };

  const loadItems = async (listId) => {
    setLoadingItems(true);
    const { data: dbItems, error: itemsError } = await supabase.from('watchlist_items').select('*').eq('watchlist_id', listId);
    if (itemsError) {
      // Sin esto una lista que no carga se pinta vacía, igual que una lista nueva.
      console.error('FavoritesPage: watchlist_items', itemsError);
      toast({ title: t('favorites.toast_error_load'), variant: 'destructive' });
      setItems([]);
      setLoadingItems(false);
      return;
    }
    // Pool, no ráfaga: Yahoo estrangula las ráfagas (ver lib/asyncPool).
    const enhancedItems = await runPooled((dbItems || []).map((item) => async () => {
      let quote = null;
      try {
        quote = buildQuoteFromYahoo(await yahooFinanceService.getQuote(item.ticker), item.ticker);
      } catch (e) {
        // Una cotización que falla deja la fila sin precio, no rompe la lista.
        console.warn(`FavoritesPage: quote ${item.ticker}`, e?.message || e);
      }
      return { ...item, quote };
    }));
    setItems(enhancedItems);
    setLoadingItems(false);

    // Self-heal legacy items added without a name: fund symbols (0P…, ISIN
    // classes) echo the ticker back as companyName, so those rows displayed
    // the raw symbol. Resolve the name ONCE via search and persist it.
    const toHeal = enhancedItems.filter(i => needsNameHealing(i, i.quote?.header?.name)).slice(0, 10);
    for (const item of toHeal) {
      try {
        const results = await yahooFinanceService.searchTickers(item.ticker);
        const name = results?.[0]?.description;
        if (name && name !== item.ticker) {
          setItems(prev => prev.map(i => (i.id === item.id ? { ...i, display_name: name } : i)));
          persistItemDisplayName(supabase, item.id, name);
        }
      } catch (e) { /* best-effort — the row keeps showing the ticker */ }
    }
  };

  const addToWatchlist = async (ticker, displayName = null) => {
    if (!selectedList) return;
    if (items.some(i => i.ticker === ticker)) {
      toast({ title: t('favorites.toast_already_in_list') });
      return;
    }
    // Persist (name included — quote responses can't provide it for funds)
    // and get the real row back so we can render it immediately.
    const { data: inserted, error } = await insertWatchlistItem(supabase, {
      watchlistId: selectedList.id,
      ticker,
      displayName: displayName && displayName !== ticker ? displayName : null,
    });
    if (error || !inserted) {
      toast({ title: t('favorites.toast_error_add'), variant: 'destructive' });
      return;
    }
    toast({ title: t('favorites.toast_added', { ticker, list: selectedList.name }) });
    setSearchTerm('');
    clearResults();
    // Optimistic: show the row instantly (price loads in the background).
    setItems(prev => [...prev, { ...inserted, display_name: inserted.display_name || displayName, quote: null }]);
    try {
      const quote = buildQuoteFromYahoo(await yahooFinanceService.getQuote(ticker), ticker);
      if (quote) setItems(prev => prev.map(i => i.id === inserted.id ? { ...i, quote } : i));
    } catch (e) {
      // La fila ya está añadida; solo se queda sin precio hasta la próxima carga.
      console.warn(`FavoritesPage: quote ${ticker}`, e?.message || e);
    }
  };

  const loadAlerts = async (itemId) => {
    const { data } = await supabase
      .from('watchlist_alerts').select('*').eq('watchlist_item_id', itemId).order('created_at', { ascending: false });
    setItemAlerts(data || []);
  };

  const createWatchlist = async () => {
    if (!newListName.trim()) return;
    const { data: inserted, error } = await supabase
      .from('watchlists')
      .insert({ user_id: user.id, name: newListName.trim() })
      .select()
      .single();
    if (error || !inserted) {
      toast({ variant: 'destructive', title: t('favorites.toast_error_create'), description: error?.message });
      return;
    }
    setNewListName('');
    setIsCreateOpen(false);
    // Show and select the new list immediately.
    setWatchlists(prev => [...prev, inserted]);
    setSelectedList(inserted);
    setItems([]);
  };

  const renameWatchlist = async () => {
    const name = editName.trim();
    if (!editList || !name || name === editList.name) { setEditList(null); return; }
    const { error } = await supabase.from('watchlists').update({ name }).eq('id', editList.id);
    if (error) {
      toast({ variant: 'destructive', title: t('favorites.toast_error_rename'), description: error.message });
      return;
    }
    setWatchlists(prev => prev.map(wl => wl.id === editList.id ? { ...wl, name } : wl));
    setSelectedList(prev => prev?.id === editList.id ? { ...prev, name } : prev);
    setEditList(null);
    toast({ title: t('favorites.toast_list_renamed') });
  };

  const handleDeleteWatchlist = async (listId) => {
    const { data: listItems } = await supabase.from('watchlist_items').select('id').eq('watchlist_id', listId);
    if (listItems?.length) {
      await supabase.from('watchlist_alerts').delete().in('watchlist_item_id', listItems.map(i => i.id));
    }
    await supabase.from('watchlist_items').delete().eq('watchlist_id', listId);
    await supabase.from('watchlists').delete().eq('id', listId);
    const newLists = watchlists.filter(wl => wl.id !== listId);
    setWatchlists(newLists);
    setDeleteListId(null);
    if (selectedList?.id === listId) {
      const next = newLists[0] || null;
      setSelectedList(next);
      if (next) loadItems(next.id);
      else setItems([]);
    }
    toast({ title: t('favorites.toast_list_deleted') });
  };

  const removeItem = async (id) => {
    const { error } = await supabase.from('watchlist_items').delete().eq('id', id);
    if (error) {
      toast({ variant: 'destructive', title: t('favorites.toast_error_delete'), description: error.message });
      return;
    }
    setRemoveConfirmId(null);
    setItems(prev => prev.filter(i => i.id !== id));
  };

  const handleAddAlert = async () => {
    const parsed = parseAlertTarget(newAlert.type, newAlert.value);
    if (!parsed.ok) {
      toast({
        variant: 'destructive',
        title: t(`favorites.alert_target_${parsed.reason}`, { min: MIN_PERCENT, max: MAX_PERCENT }),
      });
      return;
    }
    const targetValue = parsed.value;
    const initialPrice = manageAlertsItem.quote?.header?.price || 0;
    const { error } = await supabase.from('watchlist_alerts').insert({
      watchlist_item_id: manageAlertsItem.id,
      alert_type: newAlert.type,
      target_value: targetValue,
      initial_price: initialPrice,
      status: 'PENDING',
      email_notify: true,
    });
    if (error) {
      toast({ title: t('favorites.toast_error_alert'), variant: 'destructive' });
    } else {
      toast({ title: t('favorites.toast_alert_created') });
      setNewAlert({ ...newAlert, value: '' });
      loadAlerts(manageAlertsItem.id);
    }
  };

  // supabase-js no lanza al fallar una escritura: se mira el error, o la
  // pantalla daría por hecho un cambio que no se guardó.
  const handleDeleteAlert = async (alertId) => {
    const { error } = await supabase.from('watchlist_alerts').delete().eq('id', alertId);
    if (error) toast({ title: t('common.error_delete'), variant: 'destructive' });
    loadAlerts(manageAlertsItem.id);
  };

  const handleToggleAlertEmail = async (alertId, current) => {
    const { error } = await supabase.from('watchlist_alerts').update({ email_notify: !current }).eq('id', alertId);
    if (error) {
      toast({ title: t('common.error_save'), variant: 'destructive' });
      return;
    }
    setItemAlerts(prev => prev.map(a => a.id === alertId ? { ...a, email_notify: !current } : a));
  };

  // Una alerta de precio avisa UNA vez y queda cumplida (el cron la marca
  // TRIGGERED). Reactivarla toma el precio de ahora como referencia: así sabe
  // de nuevo si el objetivo está por encima o por debajo.
  const handleReactivateAlert = async (alertId) => {
    const price = manageAlertsItem?.quote?.header?.price;
    if (!price) {
      toast({ title: t('favorites.toast_error_alert'), variant: 'destructive' });
      return;
    }
    const { error } = await supabase.from('watchlist_alerts')
      .update({ status: 'PENDING', initial_price: price })
      .eq('id', alertId);
    if (error) {
      toast({ title: t('common.error_save'), variant: 'destructive' });
      return;
    }
    toast({ title: t('favorites.toast_alert_reactivated') });
    loadAlerts(manageAlertsItem.id);
  };

  return (
    <div className="space-y-6 max-w-[1400px] mx-auto pb-16">
      <Helmet><title>{t('favorites.page_title')}</title></Helmet>

      {/* ── Page header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-amber-50 dark:bg-amber-900/20 rounded-xl">
            <Star className="w-5 h-5 text-amber-500 fill-amber-400" />
          </div>
          <div>
            <h1 className="font-display text-2xl font-black text-slate-900 dark:text-white tracking-tight">{t('favorites.title')}</h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 font-medium mt-0.5">
              {t('favorites.subtitle')}
            </p>
          </div>
        </div>

        {/* Search bar */}
        <div className="relative sm:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
          <input
            type="text"
            placeholder={t('favorites.search_placeholder')}
            className="w-full pl-10 pr-10 py-2.5 bg-white dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700/40 rounded-xl text-sm font-medium text-slate-900 dark:text-white placeholder-slate-400 focus:outline-hidden focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 transition-all"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={(e) => searchKeyDown(e, {
              onSelect: (r) => { addToWatchlist(r.symbol, r.description); clearResults(); setSearchTerm(''); },
              onClose: clearResults,
            })}
            aria-autocomplete="list"
          />
          {isSearching && (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-blue-500" />
          )}
          {searchResults.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1.5 bg-white dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700/40 rounded-xl shadow-xl z-50 overflow-hidden divide-y divide-slate-50 dark:divide-slate-700/50" role="listbox">
              {searchResults.map((res, idx) => (
                <button
                  key={res.symbol}
                  onClick={() => { addToWatchlist(res.symbol, res.description); clearResults(); setSearchTerm(''); }}
                  className={`w-full flex items-center justify-between px-4 py-3 transition-colors text-left ${idx === selectedIndex ? 'bg-blue-50 dark:bg-blue-900/20' : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'}`}
                  role="option" aria-selected={idx === selectedIndex}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 shrink-0 rounded-lg bg-blue-50 dark:bg-blue-900/30 flex items-center justify-center font-bold text-[10px] text-blue-600">
                      {res.symbol.slice(0, 2)}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-bold text-xs text-slate-900 dark:text-white">{res.symbol}</span>
                        <AssetTypeBadge type={res.type} />
                      </div>
                      <div className="text-[10px] text-slate-400 truncate">{res.description}</div>
                    </div>
                  </div>
                  <Plus className="w-3.5 h-3.5 text-blue-500 shrink-0 ml-2" />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Watchlist tabs ── mismo ScrollStrip que el widget del Dashboard:
          barra visible y difuminado del lado por el que queda tira. */}
      <ScrollStrip innerClassName="gap-2 pb-2">
        <Reorder.Group
          axis="x"
          values={watchlists}
          onReorder={handleReorderWatchlists}
          className="flex items-center gap-2"
          as="div"
        >
          {watchlists.map(wl => (
            <WatchlistTab
              key={wl.id}
              wl={wl}
              isSelected={selectedList?.id === wl.id}
              onSelect={() => setSelectedList(wl)}
              onEdit={() => { setEditList(wl); setEditName(wl.name); }}
              onDelete={() => setDeleteListId(wl.id)}
              t={t}
            />
          ))}
        </Reorder.Group>
        <button
          onClick={() => setIsCreateOpen(true)}
          className="p-2 rounded-lg border border-dashed border-slate-200 dark:border-slate-700 text-slate-400 hover:text-blue-500 hover:border-blue-400 dark:hover:border-blue-500 transition-all shrink-0"
          title={t('favorites.new_list_tooltip')}
        >
          <Plus className="w-4 h-4" />
        </button>
      </ScrollStrip>

      {/* ── Main content ── */}
      <div className="bg-white dark:bg-slate-800/80 border border-slate-200/80 dark:border-slate-700/40 rounded-2xl shadow-xs overflow-hidden">

        {/* Loading / empty states */}
        {listsLoading ? (
          <div className="py-12 flex justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
          </div>
        ) : watchlists.length === 0 ? (
          <div className="py-20 flex flex-col items-center gap-3 text-center px-6">
            <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-2xl">
              <ListPlus className="w-8 h-8 text-blue-500" />
            </div>
            <p className="text-base font-bold text-slate-900 dark:text-white">{t('favorites.no_lists_title')}</p>
            <p className="text-sm text-slate-400 max-w-xs">{t('favorites.no_lists_hint')}</p>
            <Button onClick={() => setIsCreateOpen(true)} className="mt-2 bg-blue-600 hover:bg-blue-700 rounded-xl font-bold text-sm gap-1.5">
              <Plus className="w-4 h-4" /> {t('favorites.create_btn')}
            </Button>
          </div>
        ) : loadingItems ? (
          <div className="py-12 flex justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
          </div>
        ) : items.length === 0 ? (
          <div className="py-20 flex flex-col items-center gap-3">
            <Star className="w-10 h-10 text-slate-200 dark:text-slate-700" />
            <p className="text-sm font-medium text-slate-400">{t('favorites.empty_list')}</p>
            <p className="text-xs text-slate-400">{t('favorites.empty_hint')}</p>
          </div>
        ) : (
          <>
            {/* ── Mobile card list (< md) ── */}
            <div className="md:hidden divide-y divide-slate-100 dark:divide-slate-700/40">
              {items.map(item => {
                const quote = item.quote;
                const isPositive = quote?.header?.isPositive ?? true;
                const pct = quote?.header?.pct ?? null;
                return (
                  <div key={item.id} className="flex items-center gap-3 px-4 py-3">
                    {/* Left: ticker + name */}
                    <button
                      onClick={() => setOverlayTicker(item.ticker)}
                      className="flex-1 min-w-0 text-left"
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-bold text-sm text-slate-800 dark:text-slate-100 truncate">
                          {item.display_name || quote?.header?.name || item.ticker}
                        </span>
                        <ExternalLink className="w-3 h-3 text-blue-400 shrink-0" />
                      </div>
                      {(item.display_name || quote?.header?.name) && (
                        <div className="text-[11px] font-mono text-slate-400 font-medium truncate mt-0.5">
                          {item.ticker}
                        </div>
                      )}
                    </button>

                    {/* Center: price + change */}
                    <div className="text-right shrink-0">
                      <div className="text-sm font-bold tabular-nums text-slate-800 dark:text-slate-100">
                        {quote?.header?.currencySymbol || '$'}{quote?.header?.price?.toLocaleString(appLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || '—'}
                      </div>
                      <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[10px] font-bold tabular-nums mt-0.5 ${
                        pct == null
                          ? 'text-slate-400 bg-slate-100 dark:bg-slate-700/40'
                          : isPositive
                            ? 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-900/25'
                            : 'text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-900/20'
                      }`}>
                        {quote?.header?.change || '—'}
                      </span>
                    </div>

                    {/* Right: alerts + delete */}
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => setManageAlertsItem(item)}
                        className="p-2 rounded-lg text-blue-500 bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors"
                        title={t('favorites.alerts_label')}
                      >
                        <Bell className="w-3.5 h-3.5" />
                      </button>
                      {removeConfirmId === item.id ? (
                        <div className="flex items-center gap-1">
                          <button onClick={() => removeItem(item.id)} className="text-[10px] font-bold text-rose-500 px-2 py-1 rounded-lg bg-rose-50 dark:bg-rose-900/20">
                            {t('favorites.confirm_remove')}
                          </button>
                          <button onClick={() => setRemoveConfirmId(null)} className="text-[10px] font-bold text-slate-400 px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-700/40">
                            {t('favorites.cancel')}
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setRemoveConfirmId(item.id)}
                          className="p-2 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-all"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* ── Desktop table (≥ md) ── */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-slate-100 dark:border-slate-700/60">
                    <th className="px-5 py-3.5 text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('favorites.col_asset')}</th>
                    <th className="px-5 py-3.5 text-[10px] font-bold text-slate-400 uppercase tracking-wider text-right">{t('favorites.col_price')}</th>
                    <th className="px-5 py-3.5 text-[10px] font-bold text-slate-400 uppercase tracking-wider text-right">{t('favorites.col_change')}</th>
                    <th className="px-5 py-3.5 text-[10px] font-bold text-slate-400 uppercase tracking-wider text-center">{t('favorites.col_alerts')}</th>
                    <th className="px-5 py-3.5 w-16" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50 dark:divide-slate-700/40">
                  {items.map(item => {
                    const quote = item.quote;
                    const isPositive = quote?.header?.isPositive ?? true;
                    const pct = quote?.header?.pct ?? null;
                    return (
                      <tr key={item.id} className="group hover:bg-slate-50/50 dark:hover:bg-slate-900/20 transition-colors">
                        <td className="px-5 py-4">
                          <button
                            onClick={() => setOverlayTicker(item.ticker)}
                            className="flex items-center gap-2 group/link text-left"
                          >
                            <span className="font-bold text-sm text-slate-800 dark:text-slate-100 group-hover/link:text-blue-600 transition-colors truncate max-w-[220px]">
                              {item.display_name || quote?.header?.name || item.ticker}
                            </span>
                            <ExternalLink className="w-3 h-3 opacity-0 group-hover/link:opacity-100 transition-opacity text-blue-500 shrink-0" />
                          </button>
                          {(item.display_name || quote?.header?.name) && (
                            <div className="text-[11px] font-mono text-slate-400 font-medium mt-0.5 truncate max-w-[220px]">
                              {item.ticker}
                            </div>
                          )}
                        </td>
                        <td className="px-5 py-4 text-right">
                          <span className="text-sm font-bold tabular-nums text-slate-800 dark:text-slate-100">
                            {quote?.header?.currencySymbol || '$'}{quote?.header?.price?.toLocaleString(appLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || '—'}
                          </span>
                        </td>
                        <td className="px-5 py-4 text-right">
                          <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold tabular-nums ${
                            pct == null
                              ? 'text-slate-400 bg-slate-50 dark:bg-slate-700/40'
                              : isPositive
                                ? 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-900/25'
                                : 'text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-900/20'
                          }`}>
                            {quote?.header?.change || '—'}
                          </span>
                        </td>
                        <td className="px-5 py-4 text-center">
                          <button
                            onClick={() => setManageAlertsItem(item)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors"
                          >
                            <Bell className="w-3 h-3" />
                            {t('favorites.alerts_label')}
                          </button>
                        </td>
                        <td className="px-5 py-4 text-right">
                          {removeConfirmId === item.id ? (
                            <div className="flex items-center justify-end gap-2">
                              <button onClick={() => removeItem(item.id)} className="text-[11px] font-bold text-rose-500 hover:text-rose-600 transition-colors">
                                {t('favorites.confirm_remove')}
                              </button>
                              <button onClick={() => setRemoveConfirmId(null)} className="text-[11px] font-bold text-slate-400 hover:text-slate-600 transition-colors">
                                {t('favorites.cancel')}
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setRemoveConfirmId(item.id)}
                              className="p-1.5 rounded-lg text-slate-300 dark:text-slate-600 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 opacity-0 group-hover:opacity-100 transition-all"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* ── Create list dialog ── */}
      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-lg font-black tracking-tight">{t('favorites.create_title')}</DialogTitle>
            <DialogDescription className="text-sm text-slate-400">
              {t('favorites.create_desc')}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <input
              className="w-full px-4 py-3 rounded-xl border border-slate-200/80 dark:border-slate-700/40 bg-white dark:bg-slate-900 text-slate-900 dark:text-white text-sm font-medium placeholder-slate-400 outline-hidden focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 transition-all"
              placeholder={t('favorites.create_placeholder')}
              value={newListName}
              onChange={e => setNewListName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && createWatchlist()}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button onClick={createWatchlist} className="w-full bg-blue-600 hover:bg-blue-700 rounded-xl font-bold text-sm">
              {t('favorites.create_btn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Rename list dialog ── */}
      <Dialog open={!!editList} onOpenChange={(open) => { if (!open) setEditList(null); }}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-lg font-black tracking-tight">{t('favorites.rename_title')}</DialogTitle>
            <DialogDescription className="text-sm text-slate-400">
              {t('favorites.rename_desc')}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <input
              className="w-full px-4 py-3 rounded-xl border border-slate-200/80 dark:border-slate-700/40 bg-white dark:bg-slate-900 text-slate-900 dark:text-white text-sm font-medium placeholder-slate-400 outline-hidden focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 transition-all"
              placeholder={t('favorites.create_placeholder')}
              value={editName}
              onChange={e => setEditName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && renameWatchlist()}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button onClick={renameWatchlist} className="w-full bg-blue-600 hover:bg-blue-700 rounded-xl font-bold text-sm">
              {t('favorites.rename_btn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Manage alerts dialog ── */}
      <Dialog open={!!manageAlertsItem} onOpenChange={() => setManageAlertsItem(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 bg-blue-50 dark:bg-blue-900/20 rounded-lg shrink-0">
                <Bell className="w-4 h-4 text-blue-500" />
              </div>
              <div>
                <DialogTitle>{t('favorites.alerts_title', { ticker: manageAlertsItem?.ticker })}</DialogTitle>
                <DialogDescription>{t('favorites.alerts_desc')}</DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="bg-slate-50 dark:bg-slate-900/50 rounded-xl p-4 border border-slate-100 dark:border-slate-700/60">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">{t('favorites.new_alert')}</p>
              <div className="flex gap-1.5 mb-3">
                <button
                  onClick={() => setNewAlert({ type: 'PERCENT_CHANGE', value: '' })}
                  className={`flex-1 py-1.5 rounded-lg text-[11px] font-bold transition-colors border ${
                    newAlert.type === 'PERCENT_CHANGE'
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700 hover:border-blue-400'
                  }`}
                >
                  {t('favorites.alert_daily')}
                </button>
                <button
                  onClick={() => setNewAlert({ type: 'PRICE_TARGET', value: '' })}
                  className={`flex-1 py-1.5 rounded-lg text-[11px] font-bold transition-colors border ${
                    newAlert.type === 'PRICE_TARGET'
                      ? 'bg-amber-500 text-white border-amber-500'
                      : 'bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700 hover:border-amber-400'
                  }`}
                >
                  {t('favorites.alert_price')}
                </button>
              </div>
              <p className="text-[10px] text-slate-400 mb-3">
                {newAlert.type === 'PERCENT_CHANGE'
                  ? t('favorites.alert_percent_desc')
                  : t('favorites.alert_price_desc', {
                      symbol: manageAlertsItem?.quote?.header?.currencySymbol || '$',
                      price: manageAlertsItem?.quote?.header?.price?.toFixed(2) || '—',
                    })}
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder={newAlert.type === 'PERCENT_CHANGE' ? t('favorites.alert_percent_placeholder') : t('favorites.alert_price_placeholder')}
                  className="flex-1 px-3 py-2.5 border border-slate-200/80 dark:border-slate-700/40 rounded-lg text-sm bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 outline-hidden focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 transition-all"
                  value={newAlert.value}
                  onChange={(e) => setNewAlert({ ...newAlert, value: e.target.value })}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddAlert()}
                />
                <button
                  onClick={handleAddAlert}
                  className={`px-4 text-white rounded-lg transition-colors font-bold text-sm ${
                    newAlert.type === 'PERCENT_CHANGE' ? 'bg-blue-600 hover:bg-blue-700' : 'bg-amber-500 hover:bg-amber-600'
                  }`}
                >
                  {t('favorites.alert_add')}
                </button>
              </div>
            </div>

            <div>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">{t('favorites.active_alerts')}</p>
              <div className="max-h-48 overflow-y-auto space-y-2 pr-0.5">
                {itemAlerts.length === 0 ? (
                  <p className="text-xs text-slate-400 text-center py-5">{t('favorites.no_active_alerts')}</p>
                ) : (
                  itemAlerts.map(alert => {
                    const sym = manageAlertsItem?.quote?.header?.currencySymbol || '$';
                    const fulfilled = alert.alert_type === 'PRICE_TARGET' && alert.status === 'TRIGGERED';
                    return (
                      <div key={alert.id} className={`flex items-center justify-between px-3.5 py-3 border border-slate-100 dark:border-slate-700/50 rounded-xl bg-white dark:bg-slate-800/80 hover:border-blue-200 dark:hover:border-blue-800 transition-all ${fulfilled ? 'opacity-70' : ''}`}>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-bold text-slate-800 dark:text-slate-100">
                              {alert.alert_type === 'PRICE_TARGET'
                                ? `${sym}${alert.target_value}`
                                : t('favorites.alert_per_day', { value: Math.abs(alert.target_value) })}
                            </span>
                            <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold uppercase ${
                              alert.alert_type === 'PRICE_TARGET'
                                ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400'
                                : 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                            }`}>
                              {alert.alert_type === 'PRICE_TARGET' ? t('favorites.alert_type_price') : t('favorites.alert_type_daily')}
                            </span>
                            {fulfilled && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded-full font-bold uppercase bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400">
                                {t('favorites.alert_fulfilled')}
                              </span>
                            )}
                          </div>
                          {alert.alert_type === 'PRICE_TARGET' && (
                            <div className="text-[10px] text-slate-400 mt-0.5">
                              {t('favorites.alert_ref', { symbol: sym, price: alert.initial_price?.toFixed(2) || '—' })}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1 ml-2 shrink-0">
                          {fulfilled && (
                            <button
                              onClick={() => handleReactivateAlert(alert.id)}
                              title={t('favorites.alert_reactivate')}
                              aria-label={t('favorites.alert_reactivate')}
                              className="p-1.5 rounded-lg text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <button
                            onClick={() => handleToggleAlertEmail(alert.id, alert.email_notify)}
                            title={t('favorites.alert_email_notify')}
                            className={`p-1.5 rounded-lg transition-colors ${
                              alert.email_notify
                                ? 'text-blue-500 bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/40'
                                : 'text-slate-300 dark:text-slate-600 hover:text-blue-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                            }`}
                          >
                            <Mail className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleDeleteAlert(alert.id)}
                            className="p-1.5 text-slate-300 hover:text-rose-500 transition-colors rounded-lg hover:bg-rose-50 dark:hover:bg-rose-900/20"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Delete watchlist confirmation ── */}
      <Dialog open={!!deleteListId} onOpenChange={() => setDeleteListId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('favorites.delete_list_title')}</DialogTitle>
            <DialogDescription>
              {t('favorites.delete_list_desc', { name: watchlists.find(wl => wl.id === deleteListId)?.name || '' })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2 justify-end mt-2">
            <Button variant="outline" onClick={() => setDeleteListId(null)}>{t('favorites.cancel')}</Button>
            <Button
              className="bg-rose-600 hover:bg-rose-700 text-white"
              onClick={() => handleDeleteWatchlist(deleteListId)}
            >
              {t('favorites.delete_btn')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {overlayTicker && (
        <GlobalSearchOverlay
          ticker={overlayTicker}
          onClose={() => setOverlayTicker(null)}
          userId={user?.id}
        />
      )}
    </div>
  );
};

export default FavoritesPage;
