import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Star, TrendingUp, TrendingDown, ChevronRight, RefreshCw, Loader2, ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatNumber, formatPercent, getCurrencySymbol, appLocale } from '@/lib/formatters';
import { supabase } from '@/lib/customSupabaseClient';
import { yahooFinanceService } from '@/services/yahooFinance';
import ScrollStrip from '@/components/ui/ScrollStrip';
import GlobalSearchOverlay from '@/components/GlobalSearchOverlay';

const WatchlistTracker = ({ userId }) => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [watchlists, setWatchlists] = useState([]);
  const [activeListId, setActiveListId] = useState(null);
  const [items, setItems] = useState([]);
  const [loadingLists, setLoadingLists] = useState(true);
  const [loadingPrices, setLoadingPrices] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [overlayTicker, setOverlayTicker] = useState(null);

  // Load watchlists on mount
  useEffect(() => {
    if (!userId) return;
    const load = async () => {
      setLoadingLists(true);
      const { data } = await supabase
        .from('watchlists')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: true });
      const lists = data || [];
      setWatchlists(lists);
      if (lists.length > 0) setActiveListId(lists[0].id);
      setLoadingLists(false);
    };
    load();
  }, [userId]);

  // Load items + prices whenever active list changes
  const loadItems = useCallback(async (listId) => {
    if (!listId) return;
    setLoadingPrices(true);
    const { data: dbItems } = await supabase
      .from('watchlist_items')
      .select('*')
      .eq('watchlist_id', listId)
      .order('created_at', { ascending: true });

    const raw = dbItems || [];
    if (raw.length === 0) {
      setItems([]);
      setLoadingPrices(false);
      return;
    }

    const tickers = raw.map(i => i.ticker);
    const quotes = await yahooFinanceService.getQuotes(tickers);
    const quoteMap = {};
    quotes.forEach(q => { if (q) quoteMap[q.symbol] = q; });

    const enriched = raw.map(item => {
      const q = quoteMap[item.ticker] || quoteMap[item.ticker?.toUpperCase()];
      return {
        ...item,
        price: q?.current ?? null,
        change: q?.change ?? null,
        pct: q?.percentChange ?? null,
        currency: q?.currency || 'USD',
        // Persisted display_name first: fund quotes echo the ticker as companyName
        companyName: item.display_name || q?.companyName || item.ticker,
        high52: q?.high52 ?? null,
        low52: q?.low52 ?? null,
      };
    });

    setItems(enriched);
    setLastUpdated(new Date());
    setLoadingPrices(false);
  }, []);

  useEffect(() => {
    loadItems(activeListId);
  }, [activeListId, loadItems]);

  const formatPrice = (price, currency) => {
    if (price == null) return '—';
    // Mismo formato que el resto de la app (antes en-US: "€1,464.20"), y el
    // símbolo de la divisa real: todo lo que no era EUR/GBP salía como "$".
    return `${getCurrencySymbol(currency)}${formatNumber(price, 2, 2)}`;
  };

  const formatTime = (date) => {
    if (!date) return '';
    return date.toLocaleTimeString(appLocale(), { hour: '2-digit', minute: '2-digit' });
  };

  if (loadingLists) {
    return (
      <div className="bg-white dark:bg-slate-800/80 rounded-2xl border border-slate-200/80 dark:border-slate-700/40 p-5 shadow-xs">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-5 h-5 rounded bg-slate-100 dark:bg-slate-700 animate-pulse" />
          <div className="h-4 w-36 rounded bg-slate-100 dark:bg-slate-700 animate-pulse" />
        </div>
        <div className="space-y-3">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="flex items-center gap-3">
              <div className="w-12 h-6 rounded bg-slate-100 dark:bg-slate-700 animate-pulse" />
              <div className="flex-1 h-4 rounded bg-slate-100 dark:bg-slate-700 animate-pulse" />
              <div className="w-16 h-4 rounded bg-slate-100 dark:bg-slate-700 animate-pulse" />
              <div className="w-14 h-6 rounded-full bg-slate-100 dark:bg-slate-700 animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (watchlists.length === 0) {
    return (
      <div className="bg-white dark:bg-slate-800/80 rounded-2xl border border-slate-200/80 dark:border-slate-700/40 p-8 shadow-xs flex flex-col items-center gap-3 text-center">
        <div className="w-12 h-12 bg-amber-50 dark:bg-amber-900/20 rounded-2xl flex items-center justify-center">
          <Star className="w-6 h-6 text-amber-400" />
        </div>
        <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">{t('watchlist_tracker.no_lists')}</p>
        <p className="text-xs text-slate-400">{t('watchlist_tracker.no_lists_hint')}</p>
        <button
          onClick={() => navigate('/app/favorites')}
          className="mt-1 flex items-center gap-1.5 text-xs font-bold text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
        >
          {t('watchlist_tracker.go_to_favorites')} <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-slate-800/80 rounded-2xl border border-slate-200/80 dark:border-slate-700/40 shadow-xs overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-slate-100 dark:border-slate-700/50">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-amber-50 dark:bg-amber-900/20 rounded-lg">
            <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-400" />
          </div>
          <span className="text-sm font-bold text-slate-900 dark:text-white">{t('watchlist_tracker.title')}</span>
          {lastUpdated && (
            <span className="text-[10px] text-slate-400 font-medium hidden sm:block">
              {t('watchlist_tracker.updated_at', { time: formatTime(lastUpdated) })}
            </span>
          )}
        </div>
        <button
          onClick={() => loadItems(activeListId)}
          disabled={loadingPrices}
          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-all disabled:opacity-40"
          title={t('watchlist_tracker.refresh')}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loadingPrices ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Watchlist tabs — ScrollStrip pone barra visible + difuminado del lado
          por el que queda tira: con una docena de listas, antes no había forma
          de saber que había más a la derecha. */}
      {watchlists.length > 1 && (
        <ScrollStrip innerClassName="gap-1 px-4 pt-3 pb-2">
          {watchlists.map(wl => (
              <button
                key={wl.id}
                onClick={() => setActiveListId(wl.id)}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-bold whitespace-nowrap transition-all ${
                  activeListId === wl.id
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700/50'
                }`}
              >
              {wl.name}
            </button>
          ))}
        </ScrollStrip>
      )}

      {/* Items list */}
      <div className="px-4 py-2">
        {loadingPrices ? (
          <div className="space-y-2.5 py-2">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="flex items-center gap-3 py-1">
                <div className="w-14 h-5 rounded bg-slate-100 dark:bg-slate-700 animate-pulse" />
                <div className="flex-1 h-4 rounded bg-slate-100 dark:bg-slate-700 animate-pulse" />
                <div className="w-20 h-4 rounded bg-slate-100 dark:bg-slate-700 animate-pulse" />
                <div className="w-16 h-5 rounded-full bg-slate-100 dark:bg-slate-700 animate-pulse" />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 gap-2 text-center">
            <Star className="w-7 h-7 text-slate-200 dark:text-slate-700" />
            <p className="text-sm text-slate-400">{t('watchlist_tracker.empty_list')}</p>
            <button onClick={() => navigate('/app/favorites')} className="text-xs font-semibold text-blue-500 hover:text-blue-600 transition-colors">
              {t('watchlist_tracker.add_assets')}
            </button>
          </div>
        ) : (
          // overflow-x-hidden EXPLÍCITO: con overflow-y:auto el eje X computa a
          // `auto` por spec, y las filas (`px-1 -mx-1`, 8 px más anchas que el
          // contenedor para que el hover sangre hasta el borde) disparaban una
          // barra de scroll horizontal permanente.
          // Alto = 5 filas EXACTAS. Medido en el navegador: la fila mide 44,5 px
          // (py-2.5 = 20 + la chapa del ticker, 24,5) y `divide-y` suma 1 px a
          // todas menos a la primera → 44,5 + 4×45,5 = 226,5. Con el tope
          // "redondo" de antes (380 px) se veían ocho filas y media, y media fila
          // cortada se lee como un fallo de pintado, no como "hay más abajo".
          <div className="divide-y divide-slate-50 dark:divide-slate-700/40 max-h-[227px] overflow-y-auto overflow-x-hidden custom-scrollbar">
            {items.map(item => {
              const isPos = (item.pct ?? 0) >= 0;
              const hasPct = item.pct != null;
              return (
                <div key={item.id} className="flex items-center gap-3 py-2.5 group cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/30 rounded-xl px-1 -mx-1 transition-colors" onClick={() => setOverlayTicker(item.ticker)}>
                  {/* Ticker badge */}
                  <span className="shrink-0 font-mono font-bold text-[11px] bg-slate-100 dark:bg-slate-700/70 text-slate-700 dark:text-slate-300 px-2 py-1 rounded-lg tracking-tight min-w-[52px] text-center">
                    {item.ticker}
                  </span>

                  {/* Company name */}
                  <span className="flex-1 text-xs text-slate-600 dark:text-slate-300 truncate font-medium">
                    {item.companyName !== item.ticker ? item.companyName : item.name || item.ticker}
                  </span>

                  {/* Price */}
                  <span className="text-sm font-bold tabular-nums text-slate-800 dark:text-slate-100 shrink-0">
                    {formatPrice(item.price, item.currency)}
                  </span>

                  {/* Change badge */}
                  <div className={`shrink-0 flex items-center gap-0.5 px-2 py-1 rounded-lg text-[11px] font-bold tabular-nums ${
                    !hasPct ? 'text-slate-400 bg-slate-50 dark:bg-slate-700/40' :
                    isPos ? 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-900/25' :
                             'text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-900/20'
                  }`}>
                    {hasPct ? (
                      <>
                        {isPos ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                        {formatPercent(item.pct, 2, { sign: true })}
                      </>
                    ) : '—'}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <button
        onClick={() => navigate('/app/favorites')}
        className="w-full flex items-center justify-center gap-1.5 py-3 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10 border-t border-slate-100 dark:border-slate-700/50 transition-colors"
      >
        {t('watchlist_tracker.view_all')} <ArrowRight className="w-3.5 h-3.5" />
      </button>

      {overlayTicker && (
        <GlobalSearchOverlay
          ticker={overlayTicker}
          onClose={() => setOverlayTicker(null)}
          userId={userId}
        />
      )}
    </div>
  );
};

export default WatchlistTracker;
