import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from '@/components/ui/dialog';

import { parseAmountInput, localTodayIso } from '@/services/expenseService';

const EMPTY_FORM = { name: '', target_amount: '', target_date: '', start_date: '' };

/**
 * Add/Edit dialog for a purpose-based savings goal. Pure presentation:
 * `onSubmit(payload)` resolves the save (returns true on success).
 */
const SavingsGoalDialog = ({ open, onOpenChange, initial, onSubmit }) => {
  const { t } = useTranslation();
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    const today = localTodayIso(); // resolved on open, from the LOCAL date
    setForm(initial ? {
      name: initial.name || '',
      target_amount: String(initial.target_amount ?? ''),
      target_date: (initial.target_date || '').split('T')[0],
      start_date: (initial.start_date || today).split('T')[0],
    } : { ...EMPTY_FORM, start_date: today });
  }, [open, initial]);

  const update = (field, value) => {
    setErrors((e) => ({ ...e, [field]: false }));
    setForm((f) => ({ ...f, [field]: value }));
  };

  const handleSubmit = async () => {
    // Importe y fecha son OPCIONALES: sin ellos esto es un sobre libre
    // ("gasolina", "restaurante"), donde solo se acumula dinero. Solo se valida
    // lo que el usuario haya rellenado — exigir un objetivo inventado para poder
    // apartar dinero era justamente lo que sobraba.
    const hasAmount = form.target_amount.trim() !== '';
    const amount = hasAmount ? parseAmountInput(form.target_amount) : null;
    const nextErrors = {
      name: !form.name.trim(),
      target_amount: hasAmount && (amount === null || amount <= 0),
      target_date: !!form.target_date && form.target_date <= form.start_date,
    };
    if (Object.values(nextErrors).some(Boolean)) {
      setErrors(nextErrors);
      return;
    }
    setIsSaving(true);
    try {
      const ok = await onSubmit({
        name: form.name.trim(),
        target_amount: amount,
        target_date: form.target_date || null,
        start_date: form.start_date,
      });
      if (ok) onOpenChange(false);
    } finally {
      setIsSaving(false);
    }
  };

  const inputClass = (hasError) => `w-full px-3 py-2 border rounded-md dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500 transition-all text-sm shadow-xs ${hasError ? 'border-rose-500 focus:ring-rose-500' : ''}`;
  const labelClass = 'text-xs font-semibold uppercase text-slate-500 mb-2 block';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md dark:bg-slate-900 border-none">
        <DialogHeader>
          <DialogTitle className="dark:text-white">
            {initial ? t('expenses.goals_edit') : t('expenses.goals_add')}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <label className={labelClass}>{t('expenses.goals_form_name')}</label>
            <input
              type="text"
              className={inputClass(errors.name)}
              value={form.name}
              placeholder={t('expenses.goals_form_name_placeholder')}
              onChange={(e) => update('name', e.target.value)}
            />
          </div>
          {/* items-end: con "(opcional)" la etiqueta de la izquierda se va a dos
              líneas y la de la derecha no, así que sin esto los dos campos
              quedaban a distinta altura. */}
          <div className="grid grid-cols-2 gap-3 items-end">
            <div>
              <label className={labelClass}>
                {t('expenses.goals_form_target')}
                <span className="ml-1 font-normal normal-case text-slate-400">{t('expenses.goals_form_optional')}</span>
              </label>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0,00"
                className={`${inputClass(errors.target_amount)} font-ledger tabular-nums`}
                value={form.target_amount}
                onChange={(e) => update('target_amount', e.target.value)}
              />
              {errors.target_amount && <p className="text-xs text-rose-500 mt-1">{t('expenses.form_amount_invalid')}</p>}
            </div>
            <div>
              <label className={labelClass}>
                {t('expenses.goals_form_target_date')}
                <span className="ml-1 font-normal normal-case text-slate-400">{t('expenses.goals_form_optional')}</span>
              </label>
              <input
                type="date"
                min={form.start_date}
                className={inputClass(errors.target_date)}
                value={form.target_date}
                onChange={(e) => update('target_date', e.target.value)}
              />
              {errors.target_date && <p className="text-xs text-rose-500 mt-1">{t('expenses.goals_form_target_date_invalid')}</p>}
            </div>
          </div>
          {/* Poka-yoke: decir qué pasa si los dejas vacíos, en el momento en que
              los estás mirando. Sin esto, un campo opcional sin explicar se lee
              como un campo que se te ha olvidado rellenar. */}
          <p className="-mt-1 text-[11px] text-slate-400">{t('expenses.goals_form_envelope_hint')}</p>
          <div>
            <label className={labelClass}>{t('expenses.goals_form_start_date')}</label>
            <input
              type="date"
              className={inputClass(false)}
              value={form.start_date}
              onChange={(e) => update('start_date', e.target.value)}
            />
            <p className="text-[11px] text-slate-400 mt-1">{t('expenses.goals_form_start_hint')}</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            {t('expenses.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={isSaving} className="gap-2">
            {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
            {t('expenses.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default SavingsGoalDialog;
