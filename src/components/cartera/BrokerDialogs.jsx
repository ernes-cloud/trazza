import React from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

/**
 * Broker management dialogs (edit name + delete confirmation), extracted from
 * CarteraPage. Pure presentation: all state and actions are owned by the parent
 * and passed in as props.
 *
 * Props:
 *   editingBroker            – broker object currently being edited, or null (drives the edit dialog open state)
 *   onEditOpenChange         – Radix onOpenChange for the edit dialog (parent clears editingBroker)
 *   editBrokerName           – controlled value of the name input
 *   onEditBrokerNameChange   – (value) => void for the name input
 *   onSave                   – save the edited broker name
 *   onRequestDelete          – open the delete confirmation
 *   isDeleteConfirmOpen      – delete confirmation open state
 *   onDeleteConfirmOpenChange– (open) => void for the delete confirmation
 *   onConfirmDelete          – perform the deletion
 */
const BrokerDialogs = ({
  editingBroker,
  onEditOpenChange,
  editBrokerName,
  onEditBrokerNameChange,
  onSave,
  onRequestDelete,
  isDeleteConfirmOpen,
  onDeleteConfirmOpenChange,
  onConfirmDelete,
}) => {
  const { t } = useTranslation();

  return (
    <>
      <Dialog open={!!editingBroker} onOpenChange={onEditOpenChange}>
        <DialogContent aria-describedby={undefined} className="dark:bg-slate-900 border-none">
          <DialogHeader><DialogTitle className="dark:text-white">{t('cartera.edit_broker')}</DialogTitle></DialogHeader>
          <input
            className="w-full p-2 border rounded dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500 transition-all text-sm"
            value={editBrokerName}
            onChange={e => onEditBrokerNameChange(e.target.value)}
          />
          <DialogFooter className="flex justify-between mt-4">
            <Button variant="destructive" onClick={onRequestDelete} className="text-sm">{t('cartera.delete_broker')}</Button>
            <Button onClick={onSave} className="text-sm font-semibold">{t('cartera.save_changes')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isDeleteConfirmOpen} onOpenChange={onDeleteConfirmOpenChange}>
        <DialogContent aria-describedby={undefined} className="dark:bg-slate-900 border-none max-w-sm">
          <DialogHeader>
            <DialogTitle className="dark:text-white">{t('cartera.delete_broker_confirm_title')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t('cartera.delete_broker_confirm_pre')} <span className="font-semibold text-slate-700 dark:text-slate-200">{editingBroker?.name}</span> {t('cartera.delete_broker_confirm_post')}
          </p>
          <DialogFooter className="flex gap-2 mt-4">
            <Button variant="outline" onClick={() => onDeleteConfirmOpenChange(false)} className="text-sm flex-1">{t('common.cancel')}</Button>
            <Button variant="destructive" onClick={onConfirmDelete} className="text-sm flex-1">{t('cartera.yes_delete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default BrokerDialogs;
