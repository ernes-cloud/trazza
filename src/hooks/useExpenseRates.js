import { useState, useEffect, useMemo } from 'react';
import { currencyService } from '@/services/currencyService';
import { detectForeignCurrencies } from '@/services/expenseService';

/**
 * Loads FX rates for foreign currencies present in expense rows/templates.
 * Only stores rates that are finite and > 0 (no fallback to 1).
 */
export function useExpenseRates(entries = [], templates = [], preferredCurrency) {
  const [rates, setRates] = useState({});
  const [loading, setLoading] = useState(false);

  const foreignCurrencies = useMemo(() => {
    const fromEntries = detectForeignCurrencies(entries, preferredCurrency);
    const pref = String(preferredCurrency || '').trim().toUpperCase();
    const fromTemplates = (templates || [])
      .map((t) => t.currency)
      .filter((c) => c && typeof c === 'string' && c.trim().toUpperCase() !== pref)
      .map((c) => c.trim().toUpperCase());
    return [...new Set([...fromEntries, ...fromTemplates])];
  }, [entries, templates, preferredCurrency]);

  const currencyKey = foreignCurrencies.join(',');

  useEffect(() => {
    if (!preferredCurrency || foreignCurrencies.length === 0) {
      setRates({});
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const next = {};
      await Promise.all(foreignCurrencies.map(async (from) => {
        try {
          const rate = await currencyService.getExchangeRate(from, preferredCurrency, { allowFallback: false });
          if (Number.isFinite(rate) && rate > 0) next[from] = rate;
        } catch {
          /* omit unusable rate */
        }
      }));
      if (!cancelled) {
        setRates(next);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [preferredCurrency, currencyKey]);

  const fxOpts = useMemo(
    () => ({ preferredCurrency, rates }),
    [preferredCurrency, rates],
  );

  return { fxOpts, rates, loading, foreignCurrencies };
}
