import React, { useState, useRef, useEffect } from 'react';
import { localTodayIso } from '@/lib/dates';
import { useTranslation } from 'react-i18next';
import { Search, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from '@/components/ui/dialog';
import { yahooFinanceService } from '@/services/yahooFinance';
import { resolveTicker, getIsinByTicker } from '@/lib/tickerMap';
import { AssetTypeBadge } from '@/components/AssetTypeBadge';
import { getCurrencySymbol } from '@/lib/formatters';


/**
 * Add/Edit position dialog with ticker autocomplete.
 *
 * The ticker-search STATE (useTickerSearch) stays in CarteraPage — its handlers
 * (handleStartEditPosition, resetAddPositionForm) read/write it — and is passed
 * down as props. The click-outside dismissal ref and the quote-fetch spinner
 * state are dialog-internal and live here.
 */
const AddEditPositionDialog = ({
  open,
  onOpenChange,
  editingPositionId,
  newPosition,
  setNewPosition,
  isAddingPosition,
  onSave,
  searchTerm,
  setSearchTerm,
  searchResults,
  isSearching,
  searchSelectedIndex,
  searchKeyDown,
  clearSearchResults,
}) => {
  const { t } = useTranslation();
  const [isFetchingQuote, setIsFetchingQuote] = useState(false);
  const searchRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (searchRef.current && !searchRef.current.contains(event.target)) {
        clearSearchResults();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [clearSearchResults]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="max-w-md dark:bg-slate-900 border-none">
        <DialogHeader><DialogTitle className="dark:text-white">{editingPositionId ? t('cartera.edit_position') : t('cartera.add_position')}</DialogTitle></DialogHeader>
        <div className="space-y-4 py-2">
          <div className="relative" ref={searchRef}>
            <label className="text-xs font-semibold uppercase text-slate-500 mb-2 block">{t('cartera.ticker_symbol')}</label>
            <div className="relative">
              <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
              <input
                className="w-full pl-9 pr-3 py-2 border rounded-md dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500 transition-all text-sm shadow-xs"
                placeholder={t('cartera.placeholder_search_assets')}
                value={searchTerm}
                onChange={(e) => {
                  const val = (e.target.value || '').toUpperCase();
                  if (val.length === 12 && /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(val)) {
                    setNewPosition(prev => ({ ...prev, isin: val }));
                  }
                  if (!val) {
                    setNewPosition(prev => ({ ...prev, ticker: '', name: '', isin: '', type: 'Stock', classification: 'Others' }));
                  }
                  if (!(val === newPosition.ticker && val !== '')) setSearchTerm(val);
                }}
                onKeyDown={(e) => searchKeyDown(e, {
                  onSelect: (r) => {
                    setSearchTerm(r.symbol);
                    clearSearchResults();
                  },
                  onClose: clearSearchResults,
                })}
                aria-autocomplete="list"
              />
              {(isSearching || isFetchingQuote) && <Loader2 className="absolute right-3 top-2.5 w-4 h-4 animate-spin text-slate-400" />}
            </div>
            {searchResults.length > 0 ? (
              <div className="absolute z-50 w-full mt-1 bg-white dark:bg-slate-800 border dark:border-slate-700 rounded-md shadow-xl max-h-48 overflow-y-auto" role="listbox">
                {searchResults.map((result, idx) => (
                  <button key={result.symbol}
                    className={`w-full text-left px-4 py-3 border-b border-slate-50 dark:border-slate-700 last:border-0 transition-colors flex flex-col gap-0.5 ${idx === searchSelectedIndex ? 'bg-blue-50 dark:bg-blue-900/20' : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'}`}
                    role="option" aria-selected={idx === searchSelectedIndex}
                    onClick={async () => {
                      setIsFetchingQuote(true);
                      setSearchTerm(result.symbol);
                      clearSearchResults();

                      // Auto-populate price, currency and ISIN
                      try {
                        const tickerToUse = resolveTicker(result.symbol);
                        const quote = await yahooFinanceService.getQuote(tickerToUse);

                        // Determine the ISIN: search metadata vs reverse map lookup
                        const detectedIsin = result.isin || getIsinByTicker(tickerToUse) || '';

                        const isCrypto = result.type === 'CRYPTOCURRENCY';
                        setNewPosition(prev => ({
                          ...prev,
                          ticker: tickerToUse,
                          name: result.description,
                          average_price: quote.current || 0,
                          currency: quote.currency || 'USD',
                          isin: prev.isin || detectedIsin,
                          type: isCrypto ? 'Crypto' : prev.type,
                          classification: isCrypto ? 'Crypto' : prev.classification,
                        }));
                      } catch (e) {
                        const isCrypto = result.type === 'CRYPTOCURRENCY';
                        setNewPosition(prev => ({
                          ...prev,
                          ticker: result.symbol,
                          name: result.description,
                          isin: prev.isin || result.isin || getIsinByTicker(result.symbol) || '',
                          type: isCrypto ? 'Crypto' : prev.type,
                          classification: isCrypto ? 'Crypto' : prev.classification,
                        }));
                      } finally {
                        setIsFetchingQuote(false);
                      }
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-slate-900 dark:text-white uppercase tracking-tight text-sm">{result.displaySymbol}</span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <AssetTypeBadge type={result.type} />
                        {result.exchange && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 text-slate-500 rounded font-medium border border-slate-200 dark:border-slate-700">
                            {result.exchange}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-xs text-slate-500 truncate max-w-[280px]">
                      {result.description}
                    </div>
                  </button>
                ))}
              </div>
            ) : (searchTerm.length > 0 && !isSearching && !isFetchingQuote && searchTerm.toUpperCase() !== newPosition.ticker?.toUpperCase()) ? (
              <div className="absolute z-50 w-full mt-1 bg-white dark:bg-slate-800 border dark:border-slate-700 rounded-md shadow-lg p-2">
                <button
                  className="w-full text-left px-4 py-2 hover:bg-slate-100 dark:hover:bg-slate-700/50 text-sm text-blue-600 dark:text-blue-400 font-semibold transition-colors"
                  onClick={() => {
                    const finalTicker = resolveTicker(searchTerm);
                    const isinFromSearch = (searchTerm.length === 12 && /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(searchTerm))
                      ? searchTerm : getIsinByTicker(finalTicker);

                    setNewPosition(prev => ({
                      ...prev,
                      ticker: finalTicker,
                      name: finalTicker,
                      isin: prev.isin || isinFromSearch || ''
                    }));
                    clearSearchResults();
                  }}
                >
                  {t('cartera.use_manually', { ticker: searchTerm.toUpperCase() })}
                </button>
              </div>
            ) : null}
          </div>

          {newPosition.type === 'Crypto' && (
            <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400 font-medium px-1">
              <span>₿</span>
              <span>{t('cartera.crypto_detected')}</span>
            </div>
          )}

          <div>
            <label className="text-xs font-semibold uppercase text-slate-500 mb-2 block">{t('cartera.company_name')}</label>
            <input
              className="w-full px-3 py-2 border rounded-md dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500 transition-all text-sm shadow-xs"
              placeholder={t('cartera.placeholder_company_name')}
              value={newPosition.name}
              onChange={(e) => setNewPosition({ ...newPosition, name: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-semibold uppercase text-slate-500 mb-2 block">{t('cartera.quantity')}</label>
              <input
                type="text"
                inputMode="decimal"
                className="w-full px-3 py-2 border rounded-md dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500 transition-all text-sm shadow-xs"
                placeholder="0.00000000"
                value={newPosition.quantity}
                onChange={(e) => setNewPosition({ ...newPosition, quantity: e.target.value.replace(',', '.') })}
              />
            </div>
            <div className="relative">
              <label className="text-xs font-semibold uppercase text-slate-500 mb-2 block">{t('cartera.average_price_currency', { currency: newPosition.currency })}</label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-slate-400 text-sm font-medium">{getCurrencySymbol(newPosition.currency)}</span>
                <input
                  type="text"
                  inputMode="decimal"
                  className="w-full pl-8 pr-3 py-2 border rounded-md dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500 transition-all text-sm shadow-xs"
                  placeholder="0.00"
                  value={newPosition.average_price}
                  onChange={(e) => setNewPosition({ ...newPosition, average_price: e.target.value.replace(',', '.') })}
                />
              </div>
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold uppercase text-slate-500 mb-2 block">{t('cartera.date_required')}</label>
            <input
              type="date"
              max={localTodayIso()}
              className="w-full px-3 py-2 border rounded-md dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500 transition-all text-sm shadow-xs"
              value={newPosition.last_operation_date}
              onChange={(e) => setNewPosition({ ...newPosition, last_operation_date: e.target.value })}
              required
            />
          </div>
          <div>
            <label className="text-xs font-semibold uppercase text-slate-500 mb-2 block">{t('cartera.isin_optional')}</label>
            <input
              className="w-full px-3 py-2 border rounded-md dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500 transition-all text-sm shadow-xs"
              placeholder={t('cartera.placeholder_isin')}
              value={newPosition.isin}
              onChange={(e) => setNewPosition({ ...newPosition, isin: e.target.value })}
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onSave} disabled={isAddingPosition}>
            {isAddingPosition ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('common.loading')}
              </>
            ) : editingPositionId ? t('common.save') : t('common.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default AddEditPositionDialog;
