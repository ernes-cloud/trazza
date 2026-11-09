import React, { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Search, Loader2, Clock, X } from 'lucide-react';
import { supabase } from '@/lib/customSupabaseClient';
import { marketDataService } from '@/services/marketDataService';
import { useTickerSearch } from '@/hooks/useTickerSearch';
import { runPooledSettled } from '@/lib/asyncPool';
import { findMatchRange, resultLabels, changeTone, portfolioSymbols } from '@/lib/searchResults';
import { AssetTypeBadge } from '@/components/AssetTypeBadge';

const HISTORY_KEY = 'searchHistory';
const HISTORY_MAX = 10;
const LISTBOX_ID = 'global-search-listbox';
const optionId = (i) => `global-search-option-${i}`;

// En móvil el campo mide ~90 px entre el logo y los iconos: un panel de su
// ancho no dejaba leer nada. Ahí ocupa toda la pantalla bajo la cabecera (h-14;
// la cabecera lleva backdrop-blur, así que es el bloque contenedor del fixed).
const PANEL = 'fixed inset-x-2 top-[3.75rem] sm:absolute sm:inset-x-auto sm:top-full sm:mt-2 sm:w-full bg-white dark:bg-slate-800 rounded-xl shadow-xl border border-slate-200 dark:border-slate-700 z-80';
const PANEL_MOTION = {
  initial: { opacity: 0, y: -6, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -6, scale: 0.98 },
  transition: { duration: 0.13, ease: 'easeOut' },
};

/** Historial guardado: acepta el formato antiguo (array de strings). */
const readHistory = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((s) => (typeof s === 'string' ? { symbol: s, description: '' } : s))
      .filter((s) => s && typeof s.symbol === 'string' && s.symbol);
  } catch {
    return []; // localStorage corrupto o bloqueado — se empieza de cero
  }
};

const writeHistory = (entries) => {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(entries)); } catch { /* cuota o bloqueado */ }
};

/** ¿El usuario está escribiendo en otro campo? Entonces "/" es un carácter, no un atajo. */
const isTypingTarget = (el) =>
  !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

const Highlight = ({ text, query }) => {
  const range = findMatchRange(text, query);
  if (!range) return text;
  const [start, end] = range;
  return (
    <>
      {text.slice(0, start)}
      <mark className="bg-transparent text-blue-600 dark:text-blue-400 font-extrabold not-italic">{text.slice(start, end)}</mark>
      {text.slice(end)}
    </>
  );
};

/**
 * Buscador global de la barra superior: busca en Yahoo (respaldo EODHD), pinta
 * precio y variación de cada resultado y abre la ficha del activo elegido.
 *
 * @param {{ userId?: string, onOpenTicker: (symbol: string) => void, shortcutEnabled?: boolean }} props
 *   shortcutEnabled: con la ficha abierta encima, "/" no debe enfocar un campo tapado.
 */
export default function GlobalSearchBar({ userId, onOpenTicker, shortcutEnabled = true }) {
  const { t, i18n } = useTranslation();
  const {
    query, setQuery, results, isSearching, noResults, error,
    selectedIndex, setSelectedIndex, onKeyDown, clearResults,
  } = useTickerSearch({ debounce: 300, limit: 10, enterSelectsFirst: true });

  const [history, setHistory] = useState(readHistory);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [isFocused, setIsFocused] = useState(false);
  const [prices, setPrices] = useState({});
  const [heldSymbols, setHeldSymbols] = useState(() => new Set());
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const showHistory = isFocused && query.trim().length === 0 && history.length > 0;
  const showResults = results.length > 0;
  const activeIndex = showResults ? selectedIndex : showHistory ? historyIndex : -1;

  // ── Atajo de teclado: "/" o Ctrl/Cmd+K enfocan la búsqueda ──
  useEffect(() => {
    if (!shortcutEnabled) return undefined;
    const handler = (e) => {
      const isSlash = e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey;
      const isCmdK = (e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey);
      if (!isSlash && !isCmdK) return;
      if (isSlash && isTypingTarget(document.activeElement)) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [shortcutEnabled]);

  // ── Clic fuera: se cierra todo ──
  useEffect(() => {
    const handler = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setIsFocused(false);
        clearResults();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [clearResults]);

  // ── Posiciones abiertas, para la etiqueta "En cartera" ──
  useEffect(() => {
    if (!userId) return undefined;
    let cancelled = false;
    (async () => {
      const { data: brokers, error: brokersError } = await supabase.from('brokers').select('id').eq('user_id', userId);
      if (brokersError || !brokers?.length) return;
      const { data: positions, error: positionsError } = await supabase
        .from('positions')
        .select('quantity, assets(ticker, asset_class)')
        .in('broker_id', brokers.map((b) => b.id));
      // Sin la etiqueta el buscador sigue sirviendo: no es un fallo que avisar.
      if (positionsError || cancelled) return;
      setHeldSymbols(portfolioSymbols(positions));
    })();
    return () => { cancelled = true; };
  }, [userId]);

  // ── Precio de cada resultado: en paralelo acotado y pintado según llega ──
  useEffect(() => {
    if (!results.length) return undefined;
    const controller = new AbortController();
    runPooledSettled(
      results.map((r) => async () => {
        // Al cambiar los resultados se deja de pedir: sin esto el pool seguía
        // lanzando las 10 cotizaciones de una búsqueda que ya nadie mira.
        if (controller.signal.aborted) return;
        const q = await marketDataService.getQuote(r.symbol);
        if (!controller.signal.aborted && q) setPrices((prev) => ({ ...prev, [r.symbol]: q }));
      })
    );
    return () => controller.abort();
  }, [results]);

  // ── La fila marcada con el teclado siempre a la vista ──
  useEffect(() => {
    if (activeIndex < 0) return;
    listRef.current?.querySelector(`#${optionId(activeIndex)}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const saveToHistory = useCallback((result) => {
    const entry = { symbol: result.symbol, description: result.description || '', type: result.type || null };
    setHistory((prev) => {
      const next = [entry, ...prev.filter((s) => s.symbol !== entry.symbol)].slice(0, HISTORY_MAX);
      writeHistory(next);
      return next;
    });
  }, []);

  const removeFromHistory = (e, symbol) => {
    e.stopPropagation();
    setHistory((prev) => {
      const next = prev.filter((s) => s.symbol !== symbol);
      writeHistory(next);
      return next;
    });
    setHistoryIndex(-1);
  };

  const clearHistory = () => {
    setHistory([]);
    writeHistory([]);
    setHistoryIndex(-1);
    inputRef.current?.focus();
  };

  // El historial guarda el OBJETO: elegir una búsqueda reciente ya no le borra el nombre.
  const select = (result) => {
    if (!result?.symbol) return;
    saveToHistory(result);
    onOpenTicker(result.symbol);
    setQuery('');
    clearResults();
    setIsFocused(false);
    setHistoryIndex(-1);
    inputRef.current?.blur();
  };

  const close = () => {
    clearResults();
    setIsFocused(false);
    setHistoryIndex(-1);
  };

  const handleKeyDown = (e) => {
    if (!showHistory) {
      onKeyDown(e, { onSelect: select, onClose: close });
      return;
    }
    // Con el campo vacío, las flechas recorren las búsquedas recientes.
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHistoryIndex((i) => (i >= history.length - 1 ? 0 : i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHistoryIndex((i) => (i <= 0 ? history.length - 1 : i - 1));
    } else if (e.key === 'Enter' && historyIndex >= 0) {
      e.preventDefault();
      select(history[historyIndex]);
    } else if (e.key === 'Escape') {
      close();
      inputRef.current?.blur();
    }
  };

  const formatPrice = (value) =>
    value.toLocaleString(i18n.language, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const hasStatus = isSearching || showResults || noResults || error;

  return (
    <div className="flex-1 min-w-0 relative" ref={rootRef}>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
        <input
          ref={inputRef}
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          className="w-full pl-9 pr-12 py-1.5 rounded-full border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 focus:outline-hidden focus:ring-2 focus:ring-blue-500/50 focus:border-blue-400 transition-all text-sm text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 [&::-webkit-search-cancel-button]:hidden"
          placeholder={t('nav.search_placeholder')}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setHistoryIndex(-1); }}
          onFocus={() => setIsFocused(true)}
          onKeyDown={handleKeyDown}
          role="combobox"
          aria-label={t('nav.search_placeholder')}
          aria-autocomplete="list"
          aria-expanded={showResults || showHistory}
          aria-controls={LISTBOX_ID}
          aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
          aria-keyshortcuts="/ Control+K Meta+K"
          title={t('nav.search_shortcut')}
        />
        <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1">
          {isSearching ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />
          ) : query ? (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setQuery(''); clearResults(); inputRef.current?.focus(); }}
              className="p-0.5 rounded-full text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-700"
              aria-label={t('nav.clear_search')}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          ) : (
            <kbd className="hidden lg:inline-flex items-center px-1.5 h-5 rounded border border-slate-200 dark:border-slate-700 text-[10px] font-semibold text-slate-400 font-sans" aria-hidden="true">
              /
            </kbd>
          )}
        </div>
      </div>

      {/* Anuncio para lectores de pantalla: cuántos resultados hay o que se está buscando */}
      <span className="sr-only" role="status" aria-live="polite">
        {hasStatus && (isSearching
          ? t('nav.searching')
          : error
            ? t('nav.search_error')
            : t('nav.results_count', { count: results.length }))}
      </span>

      <AnimatePresence>
        {showResults && (
          <motion.div key="results" {...PANEL_MOTION} className={`${PANEL} overflow-hidden`}>
            <div ref={listRef} id={LISTBOX_ID} role="listbox" className="max-h-[min(70vh,600px)] overflow-y-auto overscroll-contain">
              {results.map((r, idx) => {
                const price = prices[r.symbol];
                const { title, subtitle } = resultLabels(r);
                const titleIsSymbol = title === (r.displaySymbol || r.symbol);
                const tone = changeTone(price?.percentChange);
                const isActive = idx === selectedIndex;
                return (
                  <div
                    key={r.symbol}
                    id={optionId(idx)}
                    role="option"
                    aria-selected={isActive}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => select(r)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className={`w-full text-left px-4 py-2.5 border-b last:border-0 border-slate-100 dark:border-slate-700 transition-colors flex items-center justify-between gap-3 cursor-pointer ${isActive ? 'bg-blue-50 dark:bg-blue-900/20' : ''}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className={`font-bold text-sm text-slate-900 dark:text-white truncate ${titleIsSymbol ? 'uppercase tracking-tight' : ''}`}>
                          <Highlight text={title} query={query} />
                        </span>
                        {heldSymbols.has(r.symbol) && (
                          <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 font-bold uppercase tracking-wider">
                            {t('nav.in_portfolio')}
                          </span>
                        )}
                        <AssetTypeBadge type={r.type} />
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5 min-w-0 text-xs text-slate-500 dark:text-slate-400">
                        {subtitle && (
                          <span className={`truncate ${titleIsSymbol ? '' : 'font-mono text-[11px]'}`}>
                            <Highlight text={subtitle} query={query} />
                          </span>
                        )}
                        {r.exchangeName && (
                          <span className="shrink-0 text-[10px] text-slate-400 dark:text-slate-500">
                            {subtitle ? '· ' : ''}{r.exchangeName}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-0.5 shrink-0 min-w-[64px]">
                      {price?.current ? (
                        <>
                          <span className="text-xs font-bold text-slate-900 dark:text-white tabular-nums">
                            {formatPrice(price.current)}
                            <span className="text-[10px] font-normal text-slate-400 ml-0.5">{price.currency}</span>
                          </span>
                          {Number.isFinite(price.percentChange) && (
                            <span className={`text-[10px] font-bold tabular-nums ${tone === 'up' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'down' ? 'text-rose-600 dark:text-rose-400' : 'text-slate-400'}`}>
                              {tone === 'up' ? '+' : ''}{formatPrice(price.percentChange)}%
                            </span>
                          )}
                        </>
                      ) : (
                        // Mientras llega el precio, un hueco del mismo alto: la fila no salta.
                        <span className="h-3 w-12 rounded bg-slate-100 dark:bg-slate-700/60 animate-pulse" aria-hidden="true" />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}

        {noResults && !isSearching && !showResults && (
          <motion.div key="no-results" {...PANEL_MOTION} className={`${PANEL} px-4 py-4 text-center`}>
            <p className="text-xs font-semibold text-slate-500">{t('nav.no_results', { query: query.trim() })}</p>
            <p className="text-[10px] text-slate-400 mt-0.5">{t('nav.no_results_hint')}</p>
          </motion.div>
        )}

        {error && !isSearching && !showResults && !noResults && (
          <motion.div key="error" {...PANEL_MOTION} className={`${PANEL} px-4 py-3 flex items-center gap-2 text-xs text-slate-500`}>
            <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            {t('nav.search_error')}
          </motion.div>
        )}

        {showHistory && (
          <motion.div key="history" {...PANEL_MOTION} className={`${PANEL} overflow-hidden`}>
            <div className="px-4 py-2 flex items-center justify-between border-b border-slate-100 dark:border-slate-700">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('nav.recent_searches')}</span>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={clearHistory}
                className="text-[10px] font-semibold text-slate-400 hover:text-rose-500"
              >
                {t('nav.clear_history')}
              </button>
            </div>
            <div ref={listRef} id={LISTBOX_ID} role="listbox" className="max-h-[min(60vh,480px)] overflow-y-auto overscroll-contain">
              {history.map((entry, idx) => {
                const { title, subtitle } = resultLabels(entry);
                const isActive = idx === historyIndex;
                return (
                  <div
                    key={entry.symbol}
                    id={optionId(idx)}
                    role="option"
                    aria-selected={isActive}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => select(entry)}
                    onMouseEnter={() => setHistoryIndex(idx)}
                    className={`px-4 py-2.5 border-b last:border-0 border-slate-100 dark:border-slate-700 flex items-center justify-between gap-3 group cursor-pointer ${isActive ? 'bg-blue-50 dark:bg-blue-900/20' : ''}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Clock className="w-3 h-3 text-slate-400 shrink-0" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="font-bold text-sm text-slate-900 dark:text-white truncate">{title}</span>
                          <AssetTypeBadge type={entry.type} />
                        </div>
                        {subtitle && <p className="text-xs text-slate-400 truncate">{subtitle}</p>}
                      </div>
                    </div>
                    {/* Visible siempre en táctil y con foco; en escritorio aparece al pasar el ratón */}
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => removeFromHistory(e, entry.symbol)}
                      className="p-1 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 hover:bg-rose-100 dark:hover:bg-rose-900/30 text-slate-400 hover:text-rose-500 rounded transition-all shrink-0"
                      aria-label={t('nav.remove_from_history')}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
