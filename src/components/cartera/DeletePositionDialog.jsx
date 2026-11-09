import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from '@/components/ui/dialog';

/**
 * Confirmation dialog for deleting a position (and its transaction history).
 * Pure presentation: the actual delete lives in the parent (confirmDeletePosition).
 *
 * @param {object|null} position  position pending deletion (null = closed)
 * @param {function}    onCancel  clears the pending position
 * @param {function}    onConfirm executes the delete
 */
const DeletePositionDialog = ({ position, onCancel, onConfirm }) => {
  const { t } = useTranslation();
  return (
    <Dialog open={!!position} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent aria-describedby={undefined} className="max-w-md dark:bg-slate-900 border-none">
        <DialogHeader>
          <DialogTitle className="dark:text-white">{t('cartera.delete_position_confirm_title')}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {t('cartera.delete_position_confirm_desc', {
            name: position?.assets?.company_name || position?.assets?.ticker || '',
          })}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="destructive" onClick={onConfirm}>{t('cartera.yes_delete')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default DeletePositionDialog;
