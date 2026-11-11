// Multidivisa en Gastos: una sola fórmula de conversión; rates inyectados
// (misma forma que currencyService.getExchangeRate: unidades de `to` por 1 `from`).

import Decimal from 'decimal.js';
import { D } from './internal.js';

const ROUND = Decimal.ROUND_HALF_UP;

export function effectiveEntryCurrency(currency, preferredCurrency) {
  const pref = String(preferredCurrency || '').trim().toUpperCase();
  if (currency == null || currency === '' || typeof currency !== 'string') return pref;
  return String(currency).trim().toUpperCase();
}

/**
 * @returns {{ convertible: boolean, value: number|null, original: number, currency: string, preferredCurrency: string }}
 */
export function convertExpenseAmount(amount, currency, preferredCurrency, rates = {}) {
  const pref = String(preferredCurrency || '').trim().toUpperCase();
  const cur = effectiveEntryCurrency(currency, preferredCurrency);
  const original = D(amount).toNumber();

  const sameCurrency = () => ({
    convertible: true,
    value: D(amount).toDecimalPlaces(2, ROUND).toNumber(),
    original,
    currency: cur,
    preferredCurrency: pref,
  });

  if (cur === pref) return sameCurrency();

  const rate = rates[cur];
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    return {
      convertible: false,
      value: null,
      original,
      currency: cur,
      preferredCurrency: pref,
    };
  }

  const value = D(amount).times(rate).toDecimalPlaces(2, ROUND).toNumber();
  return { convertible: true, value, original, currency: cur, preferredCurrency: pref };
}

export function convertEntryForAggregate(entry, fxOpts) {
  const preferredCurrency = String(fxOpts?.preferredCurrency || '').trim() || 'EUR';
  return convertExpenseAmount(
    entry.amount,
    entry.currency,
    preferredCurrency,
    fxOpts?.rates || {},
  );
}

export function excludedShape(entry) {
  if (entry?.id) return { id: entry.id, currency: entry.currency, amount: entry.amount };
  return { currency: entry.currency, amount: entry.amount };
}

export function attachExclusions(result, excluded) {
  if (!excluded?.length) return result;
  if (Array.isArray(result)) {
    result.notConvertible = true;
    result.excluded = excluded;
    result.excludedCount = excluded.length;
    return result;
  }
  return {
    ...result,
    notConvertible: true,
    excluded,
    excludedCount: excluded.length,
  };
}

/**
 * @param {Array<{ category: string, value: number }>} rows
 */
export function presentBreakdown(rows = [], { privacyMode = false } = {}) {
  const total = rows.reduce((s, r) => s + (Number(r.value) || 0), 0);
  const withPct = rows.map((r) => {
    const pct = total > 0 ? (r.value / total) * 100 : 0;
    if (privacyMode) return { category: r.category, pct };
    return { category: r.category, value: r.value, pct };
  });
  return privacyMode
    ? { amountsHidden: true, rows: withPct }
    : { amountsHidden: false, rows: withPct };
}
