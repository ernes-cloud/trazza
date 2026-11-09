import React from 'react';
import { Loader2, Trash2, DollarSign } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { useTranslation } from 'react-i18next';

const TransactionModals = ({
  availablePositions,
  manualSale, setManualSale,
  manualDividend, setManualDividend,
  manualCommission, setManualCommission,
  manualCash, setManualCash,
  isAddSaleOpen, setIsAddSaleOpen,
  isAddDividendOpen, setIsAddDividendOpen,
  isAddCommissionOpen, setIsAddCommissionOpen,
  isAddCashOpen, setIsAddCashOpen,
  isDeleteConfirmOpen, setIsDeleteConfirmOpen,
  handleSaveManualSale,
  handleSaveManualDividend,
  handleSaveManualCommission,
  handleSaveManualCash,
  confirmDeleteTransaction,
  manualEntryLoading,
  formatNumber,
  getCurrencySymbol,
  TODAY,
  cashBreakdown,
  ALL_CURRENCIES,
}) => {
  const { t } = useTranslation();

  return (
    <>
      {/* Confirm Delete Dialog */}
      <Dialog open={isDeleteConfirmOpen} onOpenChange={setIsDeleteConfirmOpen}>
        <DialogContent className="dark:bg-slate-900 border-none sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle className="dark:text-white flex items-center gap-2">
              <Trash2 className="w-5 h-5 text-red-500" />
              {t('cartera.modal_delete_confirm_title')}
            </DialogTitle>
          </DialogHeader>
          <div className="py-4 text-sm text-slate-500 dark:text-slate-400">
            {t('cartera.modal_delete_confirm_body')}
          </div>
          <DialogFooter className="flex gap-3 sm:justify-end">
            <Button variant="outline" onClick={() => setIsDeleteConfirmOpen(false)} disabled={manualEntryLoading}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={confirmDeleteTransaction} disabled={manualEntryLoading}>
              {manualEntryLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              {t('cartera.modal_delete_btn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manual Entry: Add Sale */}
      <Dialog open={isAddSaleOpen} onOpenChange={setIsAddSaleOpen}>
        <DialogContent className="dark:bg-slate-900 border-none max-w-md">
          <DialogHeader><DialogTitle className="dark:text-white">{t('cartera.modal_add_sale')}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-xs font-semibold uppercase text-slate-500 mb-1 block">{t('cartera.modal_position_asset')}</label>
              <select
                className="w-full p-2.5 border rounded-md text-sm dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500"
                value={manualSale.positionId}
                onChange={e => setManualSale({ ...manualSale, positionId: e.target.value })}
              >
                <option value="">{t('cartera.modal_select_asset')}</option>
                {availablePositions.map(p => (
                  <option key={p.id} value={p.id}>{p.assets?.company_name || p.assets?.ticker} ({formatNumber(p.quantity)} uds)</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="text-xs font-semibold uppercase text-slate-500 block">{t('cartera.modal_quantity')}</label>
                  {manualSale.positionId && (
                    <span className="text-[10px] text-blue-500 font-bold">
                      {t('cartera.modal_max', { n: formatNumber(availablePositions.find(p => p.id === manualSale.positionId)?.quantity || 0) })}
                    </span>
                  )}
                </div>
                <input
                  type="number"
                  step="any"
                  min="0.000001"
                  max={availablePositions.find(p => p.id === manualSale.positionId)?.quantity}
                  className="w-full p-2.5 border rounded-md text-sm dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500"
                  placeholder="0"
                  value={manualSale.quantity}
                  onChange={e => setManualSale({ ...manualSale, quantity: e.target.value })}
                />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase text-slate-500 mb-1 block">{t('cartera.modal_sale_price')}</label>
                <input type="number" step="any" className="w-full p-2.5 border rounded-md text-sm dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500" placeholder="0.00" value={manualSale.price} onChange={e => setManualSale({ ...manualSale, price: e.target.value })} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold uppercase text-slate-500 mb-1 block">{t('cartera.commission')}</label>
                <input type="number" step="any" className="w-full p-2.5 border rounded-md text-sm dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500" placeholder="0" value={manualSale.commission} onChange={e => setManualSale({ ...manualSale, commission: e.target.value })} />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase text-slate-500 mb-1 block">{t('cartera.modal_date')}</label>
                <input type="date" max={TODAY} className="w-full p-2.5 border rounded-md text-sm dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500" value={manualSale.date} onChange={e => setManualSale({ ...manualSale, date: e.target.value })} />
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold uppercase text-slate-500 mb-1 block">{t('cartera.modal_notes_optional')}</label>
              <input type="text" className="w-full p-2.5 border rounded-md text-sm dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500" placeholder={t('cartera.modal_notes_placeholder_sale')} value={manualSale.notes} onChange={e => setManualSale({ ...manualSale, notes: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsAddSaleOpen(false)} className="text-sm">{t('common.cancel')}</Button>
            <Button
              onClick={handleSaveManualSale}
              disabled={
                manualEntryLoading ||
                !manualSale.positionId ||
                !manualSale.quantity ||
                !manualSale.price ||
                parseFloat(manualSale.quantity) > parseFloat(availablePositions.find(p => p.id === manualSale.positionId)?.quantity || 0)
              }
              className="text-sm font-semibold"
            >
              {manualEntryLoading ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null} {t('cartera.modal_save_sale')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manual Entry: Add Dividend */}
      <Dialog open={isAddDividendOpen} onOpenChange={setIsAddDividendOpen}>
        <DialogContent className="dark:bg-slate-900 border-none max-w-md">
          <DialogHeader><DialogTitle className="dark:text-white">{t('cartera.modal_add_dividend')}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-xs font-semibold uppercase text-slate-500 mb-1 block">{t('cartera.modal_position_asset')}</label>
              <select
                className="w-full p-2.5 border rounded-md text-sm dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500"
                value={manualDividend.positionId}
                onChange={e => setManualDividend({ ...manualDividend, positionId: e.target.value })}
              >
                <option value="">{t('cartera.modal_select_asset')}</option>
                {availablePositions.map(p => (
                  <option key={p.id} value={p.id}>{p.assets?.company_name || p.assets?.ticker}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold uppercase text-slate-500 mb-1 block">{t('cartera.modal_amount')}</label>
                <input type="number" step="any" className="w-full p-2.5 border rounded-md text-sm dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500" placeholder="0.00" value={manualDividend.amount} onChange={e => setManualDividend({ ...manualDividend, amount: e.target.value })} />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase text-slate-500 mb-1 block">{t('cartera.modal_date')}</label>
                <input type="date" max={TODAY} className="w-full p-2.5 border rounded-md text-sm dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500" value={manualDividend.date} onChange={e => setManualDividend({ ...manualDividend, date: e.target.value })} />
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold uppercase text-slate-500 mb-1 block">{t('cartera.modal_notes_optional')}</label>
              <input type="text" className="w-full p-2.5 border rounded-md text-sm dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500" placeholder={t('cartera.modal_notes_placeholder_dividend')} value={manualDividend.notes} onChange={e => setManualDividend({ ...manualDividend, notes: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsAddDividendOpen(false)} className="text-sm">{t('common.cancel')}</Button>
            <Button onClick={handleSaveManualDividend} disabled={manualEntryLoading || !manualDividend.positionId || !manualDividend.amount} className="text-sm font-semibold">
              {manualEntryLoading ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null} {t('cartera.modal_save_dividend')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manual Entry: Add Commission */}
      <Dialog open={isAddCommissionOpen} onOpenChange={setIsAddCommissionOpen}>
        <DialogContent className="dark:bg-slate-900 border-none max-w-md">
          <DialogHeader><DialogTitle className="dark:text-white">{t('cartera.modal_add_commission')}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-xs font-semibold uppercase text-slate-500 mb-1 block">{t('cartera.modal_related_asset')}</label>
              <select
                className="w-full p-2.5 border rounded-md text-sm dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500"
                value={manualCommission.positionId}
                onChange={e => setManualCommission({ ...manualCommission, positionId: e.target.value })}
              >
                <option value="">{t('cartera.modal_general_no_asset')}</option>
                {availablePositions.map(p => (
                  <option key={p.id} value={p.id}>{p.assets?.company_name || p.assets?.ticker}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold uppercase text-slate-500 mb-1 block">{t('cartera.modal_amount')}</label>
                <input type="number" step="any" className="w-full p-2.5 border rounded-md text-sm dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500" placeholder="0.00" value={manualCommission.amount} onChange={e => setManualCommission({ ...manualCommission, amount: e.target.value })} />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase text-slate-500 mb-1 block">{t('cartera.modal_date')}</label>
                <input type="date" max={TODAY} className="w-full p-2.5 border rounded-md text-sm dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500" value={manualCommission.date} onChange={e => setManualCommission({ ...manualCommission, date: e.target.value })} />
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold uppercase text-slate-500 mb-1 block">{t('cartera.modal_description')}</label>
              <input type="text" className="w-full p-2.5 border rounded-md text-sm dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500" placeholder={t('cartera.modal_desc_placeholder_commission')} value={manualCommission.description} onChange={e => setManualCommission({ ...manualCommission, description: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsAddCommissionOpen(false)} className="text-sm">{t('common.cancel')}</Button>
            <Button onClick={handleSaveManualCommission} disabled={manualEntryLoading || !manualCommission.amount} className="text-sm font-semibold">
              {manualEntryLoading ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null} {t('cartera.modal_save_commission')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manual Entry: Manage Cash */}
      <Dialog open={isAddCashOpen} onOpenChange={setIsAddCashOpen}>
        <DialogContent className="dark:bg-slate-900 border-none max-w-md">
          <DialogHeader><DialogTitle className="dark:text-white">{t('cartera.modal_manage_cash')}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-xs font-semibold uppercase text-slate-500 mb-2 block">{t('cartera.modal_operation_type')}</label>
              <div className="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-lg">
                <button
                  type="button"
                  onClick={() => setManualCash({ ...manualCash, type: 'DEPOSIT' })}
                  className={`flex-1 py-2 text-xs font-bold rounded-md transition-all ${manualCash.type === 'DEPOSIT' ? 'bg-white dark:bg-slate-700 text-green-600 shadow-xs' : 'text-slate-500'}`}
                >
                  {t('cartera.modal_deposit')}
                </button>
                <button
                  type="button"
                  onClick={() => setManualCash({ ...manualCash, type: 'WITHDRAWAL' })}
                  className={`flex-1 py-2 text-xs font-bold rounded-md transition-all ${manualCash.type === 'WITHDRAWAL' ? 'bg-white dark:bg-slate-700 text-red-500 shadow-xs' : 'text-slate-500'}`}
                >
                  {t('cartera.modal_withdrawal')}
                </button>
              </div>
            </div>

            <div className="bg-blue-50/50 dark:bg-blue-900/10 p-3 rounded-xl border border-blue-100 dark:border-blue-800/50 flex items-center justify-between">
              <div className="flex flex-col">
                <span className="text-[10px] font-bold text-blue-500 uppercase tracking-widest">{t('cartera.modal_current_balance', { currency: manualCash.currency })}</span>
                <span className="text-lg font-black text-slate-900 dark:text-white">
                  {getCurrencySymbol(manualCash.currency)}
                  {formatNumber(cashBreakdown[manualCash.currency] || 0, 2, 2)}
                </span>
              </div>
              <div className="p-2 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-600">
                <DollarSign className="w-5 h-5" />
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold uppercase text-slate-500 mb-2 block">{t('cartera.modal_currency')}</label>
              <div className="grid grid-cols-4 gap-1 max-h-24 overflow-y-auto p-1 bg-slate-50 dark:bg-slate-800/50 rounded-md border dark:border-slate-800">
                {ALL_CURRENCIES.map(c => (
                  <button
                    key={c.code}
                    type="button"
                    onClick={() => setManualCash({ ...manualCash, currency: c.code })}
                    className={`px-2 py-1.5 text-[10px] font-bold rounded transition-all border ${manualCash.currency === c.code
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white dark:bg-slate-800 text-slate-500 border-slate-200 dark:border-slate-700 hover:border-blue-400'}`}
                  >
                    {c.code}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold uppercase text-slate-500 mb-1 block">{t('cartera.modal_amount')}</label>
                <div className="relative">
                  <span className="absolute left-3 top-2.5 text-slate-400 text-sm font-medium">{getCurrencySymbol(manualCash.currency)}</span>
                  <input
                    type="number"
                    step="any"
                    className="w-full pl-8 pr-3 py-2.5 border rounded-md text-sm dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500 shadow-xs"
                    placeholder="0.00"
                    value={manualCash.amount}
                    onChange={e => setManualCash({ ...manualCash, amount: e.target.value })}
                  />
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold uppercase text-slate-500 mb-1 block">{t('cartera.modal_date')}</label>
                <input type="date" max={TODAY} className="w-full p-2.5 border rounded-md text-sm dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500" value={manualCash.date} onChange={e => setManualCash({ ...manualCash, date: e.target.value })} />
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold uppercase text-slate-500 mb-1 block">{t('cartera.modal_description_optional')}</label>
              <input type="text" className="w-full p-2.5 border rounded-md text-sm dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500" placeholder={t('cartera.modal_desc_placeholder_cash')} value={manualCash.description} onChange={e => setManualCash({ ...manualCash, description: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsAddCashOpen(false)} className="text-sm">{t('common.cancel')}</Button>
            <Button onClick={handleSaveManualCash} disabled={manualEntryLoading || !manualCash.amount} className="text-sm font-semibold">
              {manualEntryLoading ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null} {t('cartera.modal_save_movement')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default TransactionModals;
