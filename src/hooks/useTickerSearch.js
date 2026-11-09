/**
 * useTickerSearch — centralized ticker search hook
 *
 * Features:
 *  - AbortController: cancels in-flight requests when query changes (no race conditions)
 *  - Module-level cache: full results stored, limit applied at read time (per-instance)
 *  - noResults state: explicit signal that a search completed empty
 *  - Keyboard navigation: wrap-around ↑↓, Enter to select, Escape to close
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { marketDataService } from '@/services/marketDataService';
import { prepareSearchResults } from '@/lib/searchResults';

const searchCache = new Map();
const CACHE_TTL = 2 * 60 * 1000;

/**
 * @param {{ minChars?: number, debounce?: number, limit?: number, enterSelectsFirst?: boolean }} [options]
 *   enterSelectsFirst: Enter sin nada marcado elige el primer resultado (la
 *   barra superior lo quiere; en un formulario Enter debe seguir enviándolo).
 */
export function useTickerSearch({ minChars = 2, debounce = 400, limit = 10, enterSelectsFirst = false } = {}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [noResults, setNoResults] = useState(false);
  const [error, setError] = useState(null);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const abortRef = useRef(null);

  useEffect(() => {
    setSelectedIndex(-1);
    setNoResults(false);
    // Una búsqueda en vuelo que se cancela no apaga el spinner (su finally no
    // toca el estado si se abortó): lo apaga quien la cancela. Sin esto, borrar
    // hasta una letra o volver a una búsqueda cacheada lo dejaba girando.
    setIsSearching(false);

    // Los espacios de los extremos no cuentan: "a " no es una búsqueda de 2 letras.
    const term = query.trim();
    if (term.length < minChars) {
      setResults([]);
      setError(null);
      return;
    }

    const cacheKey = term.toLowerCase();
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      // Cache stores full raw results; slice here so each instance respects its own limit
      const sliced = prepareSearchResults(cached.results, term).slice(0, limit);
      setResults(sliced);
      setError(null);
      setNoResults(sliced.length === 0);
      return;
    }

    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const { signal } = controller;

      setIsSearching(true);
      setError(null);

      try {
        const raw = await marketDataService.searchTickers(term, signal);
        if (signal.aborted) return;
        // Un vacío NO se cachea: si fue un 429 pasajero de Yahoo, la misma
        // búsqueda seguiría diciendo "sin resultados" durante dos minutos.
        if (raw?.length) searchCache.set(cacheKey, { results: raw, ts: Date.now() });
        // Ordenar ANTES de recortar: un buen resultado puede venir el 11.º de Yahoo
        const sliced = prepareSearchResults(raw, term).slice(0, limit);
        setResults(sliced);
        setNoResults(sliced.length === 0);
      } catch (e) {
        if (!signal.aborted) {
          setResults([]);
          setError(e);
        }
      } finally {
        if (!signal.aborted) setIsSearching(false);
      }
    }, debounce);

    return () => {
      clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [query, minChars, debounce, limit]);

  // Wrap-around navigation: ↑ from 0 → last, ↓ from last → 0
  const onKeyDown = useCallback((e, { onSelect, onClose } = {}) => {
    if (!results.length && e.key !== 'Escape') return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => (i >= results.length - 1 ? 0 : i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => (i <= 0 ? results.length - 1 : i - 1));
    } else if (e.key === 'Enter' && (selectedIndex >= 0 || enterSelectsFirst)) {
      e.preventDefault();
      onSelect?.(results[Math.max(selectedIndex, 0)]);
    } else if (e.key === 'Escape') {
      setResults([]);
      setSelectedIndex(-1);
      setNoResults(false);
      onClose?.();
    }
  }, [results, selectedIndex, enterSelectsFirst]);

  const clearResults = useCallback(() => {
    setResults([]);
    setSelectedIndex(-1);
    setNoResults(false);
    setError(null);
  }, []);

  return { query, setQuery, results, isSearching, noResults, error, selectedIndex, setSelectedIndex, onKeyDown, clearResults };
}
