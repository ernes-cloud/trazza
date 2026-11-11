import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from '@/components/ui/dialog';

const EMPTY_FORM = { name: '', start_date: '', end_date: '', goal_id: '' };

/**
 * Alta/edición de un proyecto de gasto (viaje, reforma…). Presentación pura:
 * `onSubmit(payload)` resuelve el guardado y devuelve true si fue bien.
 *
 * Solo el nombre es obligatorio: las fechas son informativas (encabezan la
 * tarjeta) y el sobre es el enlace opcional con Metas de ahorro para poder
 * comparar lo apartado con lo gastado.
 */
const ExpenseProjectDialog = ({ open, onOpenChange, initial, goals = [], onSubmit }) => {
  const { t } = useTranslation();
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setForm(initial ? {
      name: initial.name || '',
      start_date: (initial.start_date || '').split('T')[0],
      end_date: (initial.end_date || '').split('T')[0],
      goal_id: initial.goal_id || '',
    } : EMPTY_FORM);
  }, [open, initial]);

  const update = (field, value) => {
    setErrors((e) => ({ ...e, [field]: false }));
    setForm((f) => ({ ...f, [field]: value }));
  };

  const handleSubmit = async () => {
    const nextErrors = {
      name: !form.name.trim(),
      end_date: !!form.start_date && !!form.end_date && form.end_date < form.start_date,
    };
    if (Object.values(nextErrors).some(Boolean)) {
      setErrors(nextErrors);
      return;
    }
    setIsSaving(true);
    try {
      const ok = await onSubmit({
        name: form.name.trim(),
        start_date: form.start_date || null,
        end_date: form.end_date || null,
        goal_id: form.goal_id || null,
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
            {initial ? t('expenses.projects_edit') : t('expenses.projects_add')}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <label className={labelClass}>{t('expenses.projects_form_name')}</label>
            <input
              type="text"
              className={inputClass(errors.name)}
              value={form.name}
              placeholder={t('expenses.projects_form_name_placeholder')}
              onChange={(e) => update('name', e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3 items-end">
            <div>
              <label className={labelClass}>
                {t('expenses.projects_form_start')}
                <span className="ml-1 font-normal normal-case text-slate-400">{t('expenses.goals_form_optional')}</span>
              </label>
              <input type="date" className={inputClass(false)} value={form.start_date} onChange={(e) => update('start_date', e.target.value)} />
            </div>
            <div>
              <label className={labelClass}>
                {t('expenses.projects_form_end')}
                <span className="ml-1 font-normal normal-case text-slate-400">{t('expenses.goals_form_optional')}</span>
              </label>
              <input type="date" min={form.start_date || undefined} className={inputClass(errors.end_date)} value={form.end_date} onChange={(e) => update('end_date', e.target.value)} />
              {errors.end_date && <p className="text-xs text-rose-500 mt-1">{t('expenses.projects_form_end_invalid')}</p>}
            </div>
          </div>

          <div>
            <label className={labelClass}>
              {t('expenses.projects_form_goal')}
              <span className="ml-1 font-normal normal-case text-slate-400">{t('expenses.goals_form_optional')}</span>
            </label>
            <select className={inputClass(false)} value={form.goal_id} onChange={(e) => update('goal_id', e.target.value)}>
              <option value="">{t('expenses.projects_form_goal_none')}</option>
              {goals.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
            <p className="text-[11px] text-slate-400 mt-1">{t('expenses.projects_form_goal_hint')}</p>
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

export default ExpenseProjectDialog;
