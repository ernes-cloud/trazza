import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import SearchableSelect from '@/components/ui/SearchableSelect';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from '@/components/ui/dialog';
import {
  EXPENSE_CATEGORIES, INCOME_CATEGORIES, occurrenceDateFor, categoryLabel,
  parseAmountInput, localTodayIso,
} from '@/services/expenseService';
import { normalizeAlertPrefs } from '@/services/recurringEndAlerts';

const EMPTY_FORM = {
  type: 'expense',
  category: 'other',
  amount: '',
  entry_date: '',
  notes: '',
  recurring: false,
  recurrence_day: '',
  recurrence_until: '',
  project_id: '',
};

/**
 * Add/Edit dialog for a personal expense/income entry. Pure presentation:
 * no I/O — `onSubmit(form)` resolves the save (returns true on success).
 * `initial` (a DB row) switches it to edit mode; recurrence can only be set
 * on creation (editing a template edits its amount/category/day going forward).
 * `defaultDate` / `defaultRecurring` pre-fill a NEW entry (calendar day click,
 * onboarding's "create your recurring entries" step).
 */
const ExpenseEntryDialog = ({
  open, onOpenChange, initial, onSubmit, defaultDate, defaultRecurring,
  customCategories, onAddCategory, projects = [], defaultProjectId,
  alertPrefsRaw, onOpenAlertSettings,
}) => {
  const { t } = useTranslation();
  // Misma normalización que usa el cron: lo que se promete aquí es exactamente
  // lo que se enviará (ver services/recurringEndAlerts.js).
  const alertPrefs = normalizeAlertPrefs(alertPrefsRaw);
  const leadLabel = alertPrefs.leadDays
    .map((d) => t(`expenses.lead_short_${d}`))
    .join(t('expenses.lead_join'));
  const [form, setForm] = useState(EMPTY_FORM);
  const [amountError, setAmountError] = useState(false);
  const [untilError, setUntilError] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');

  useEffect(() => {
    if (!open) return;
    setAmountError(false);
    setUntilError(null);
    setAddingCategory(false);
    setNewCategoryName('');
    // "Today" is resolved when the dialog OPENS (and from the local date, not
    // the UTC one): a module-level constant went stale in a tab left open
    // overnight and pre-filled yesterday.
    const today = localTodayIso();
    setForm(initial ? {
      type: initial.type || 'expense',
      category: initial.category || 'other',
      amount: String(initial.amount ?? ''),
      entry_date: (initial.entry_date || today).split('T')[0],
      notes: initial.notes || '',
      recurring: initial.recurrence === 'monthly',
      recurrence_day: initial.recurrence_day ? String(initial.recurrence_day) : '',
      recurrence_until: initial.recurrence_until || '',
      project_id: initial.project_id || '',
    } : {
      ...EMPTY_FORM,
      entry_date: defaultDate || today,
      recurring: !!defaultRecurring,
      project_id: defaultProjectId || '',
    });
  }, [open, initial, defaultDate, defaultRecurring, defaultProjectId]);

  const update = (field, value) => setForm((f) => ({ ...f, [field]: value }));

  const custom = customCategories?.[form.type] || [];
  const categories = [...(form.type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES), ...custom];
  const isEditing = !!initial;
  // Editing a template exposes its recurrence fields (day/until); a regular row
  // can't be converted to recurring after the fact, so the section stays hidden.
  const isEditingTemplate = isEditing && initial.recurrence === 'monthly';
  const showRecurrenceSection = !isEditing || isEditingTemplate;

  const setType = (type) => setForm((f) => {
    const validForType = [...(type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES), ...(customCategories?.[type] || [])];
    return { ...f, type, category: validForType.includes(f.category) ? f.category : 'other' };
  });

  const handleCategoryChange = (value) => {
    if (value === '__new__') { setAddingCategory(true); return; }
    update('category', value);
  };

  const confirmNewCategory = async () => {
    const name = newCategoryName.trim();
    if (!name || !onAddCategory) { setAddingCategory(false); return; }
    const resolved = await onAddCategory(form.type, name);
    if (resolved) update('category', resolved);
    setAddingCategory(false);
    setNewCategoryName('');
  };

  const handleSubmit = async () => {
    const amount = parseAmountInput(form.amount);
    if (amount === null || amount <= 0) {
      setAmountError(true);
      return;
    }
    if (form.recurring && form.recurrence_until) {
      // A limit before the first occurrence would create a template that never
      // generates anything (it shows in the recurring list but counts nowhere)
      const startDate = form.entry_date.split('T')[0];
      const [startYear, startMonth] = startDate.split('-').map(Number);
      const day = parseInt(form.recurrence_day, 10) || Number(startDate.slice(8, 10)) || 1;
      const firstOccurrence = occurrenceDateFor(startYear, startMonth, day);
      if (form.recurrence_until < firstOccurrence) {
        setUntilError(firstOccurrence);
        return;
      }
    }
    setIsSaving(true);
    try {
      const ok = await onSubmit({
        type: form.type,
        category: form.category,
        amount,
        entry_date: form.entry_date,
        notes: form.notes.trim() || null,
        recurring: form.recurring,
        recurrence_day: form.recurring ? (parseInt(form.recurrence_day, 10) || null) : null,
        recurrence_until: form.recurring ? (form.recurrence_until || null) : null,
        // null, no '': la cadena vacía revienta la FK a expense_projects
        project_id: form.project_id || null,
      });
      if (ok) onOpenChange(false);
    } finally {
      setIsSaving(false);
    }
  };

  const inputClass = 'w-full px-3 py-2 border rounded-md dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500 transition-all text-sm shadow-xs';
  const labelClass = 'text-xs font-semibold uppercase text-slate-500 mb-2 block';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md dark:bg-slate-900 border-none">
        <DialogHeader>
          <DialogTitle className="dark:text-white">
            {isEditing ? t('expenses.edit_entry') : t('expenses.add_entry')}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-2">
            {[
              { value: 'expense', label: t('expenses.form_type_expense'), activeClass: 'bg-rose-600 text-white border-rose-600' },
              { value: 'income', label: t('expenses.form_type_income'), activeClass: 'bg-emerald-600 text-white border-emerald-600' },
            ].map(({ value, label, activeClass }) => (
              <button
                key={value}
                type="button"
                onClick={() => setType(value)}
                className={`py-2 rounded-md border text-sm font-semibold transition-colors ${
                  form.type === value
                    ? activeClass
                    : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div>
            <label className={labelClass}>{t('expenses.form_category')}</label>
            {addingCategory ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  autoFocus
                  className={inputClass}
                  placeholder={t('expenses.new_category_placeholder')}
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirmNewCategory(); } if (e.key === 'Escape') setAddingCategory(false); }}
                />
                <Button type="button" onClick={confirmNewCategory} className="h-9 shrink-0">{t('expenses.save')}</Button>
                <Button type="button" variant="outline" onClick={() => setAddingCategory(false)} className="h-9 shrink-0">{t('expenses.cancel')}</Button>
              </div>
            ) : (
              /* Buscable, no un <select>: con las categorías propias sumadas a
                 las predefinidas la lista se hace larga y encontrar una a ojo
                 (en un desplegable nativo de móvil, encima) es el trabajo caro. */
              <SearchableSelect
                className={inputClass}
                value={form.category}
                onChange={handleCategoryChange}
                options={categories.map((cat) => ({ value: cat, label: categoryLabel(t, cat) }))}
                action={{ value: '__new__', label: t('expenses.new_category_option') }}
                ariaLabel={t('expenses.form_category')}
                searchPlaceholder={t('expenses.category_search_placeholder')}
                emptyText={t('expenses.category_search_empty')}
              />
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>{t('expenses.form_amount')}</label>
              {/* type="text", NOT number: the HTML number type only accepts a
                  DOT decimal separator, so "12,50" arrived as '' and every
                  Spanish user got "invalid amount". parseAmountInput handles both. */}
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0,00"
                className={`${inputClass} font-ledger tabular-nums ${amountError ? 'border-rose-500 focus:ring-rose-500' : ''}`}
                value={form.amount}
                onChange={(e) => { setAmountError(false); update('amount', e.target.value); }}
              />
              {amountError && (
                <p className="text-xs text-rose-500 mt-1">{t('expenses.form_amount_invalid')}</p>
              )}
            </div>
            <div>
              <label className={labelClass}>
                {form.recurring ? t('expenses.form_start_date') : t('expenses.form_date')}
              </label>
              <input
                type="date"
                className={inputClass}
                value={form.entry_date}
                onChange={(e) => update('entry_date', e.target.value)}
              />
            </div>
          </div>

          {/* Proyecto: etiqueta ORTOGONAL a la categoría (el restaurante del
              viaje sigue siendo "Restaurante" Y del viaje). Solo se ofrece si el
              usuario tiene proyectos: un desplegable vacío es ruido. */}
          {projects.length > 0 && (
            <div>
              <label className={labelClass}>
                {t('expenses.form_project')}
                <span className="ml-1 font-normal normal-case text-slate-400">{t('expenses.goals_form_optional')}</span>
              </label>
              <select
                className={inputClass}
                value={form.project_id}
                onChange={(e) => update('project_id', e.target.value)}
              >
                <option value="">{t('expenses.form_project_none')}</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}

          <div>
            <label className={labelClass}>{t('expenses.form_notes')}</label>
            <input
              type="text"
              className={inputClass}
              value={form.notes}
              onChange={(e) => update('notes', e.target.value)}
            />
          </div>

          {showRecurrenceSection && (
            <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-3 space-y-3">
              {!isEditingTemplate && (
              /* A real button with role="checkbox": the previous <div onClick>
                 inside a <label> could not be reached or toggled by keyboard. */
              <button
                type="button"
                role="checkbox"
                aria-checked={form.recurring}
                onClick={() => update('recurring', !form.recurring)}
                className="flex items-center gap-3 group rounded-md focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900"
              >
                <span
                  aria-hidden="true"
                  className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                    form.recurring
                      ? 'bg-blue-600 border-blue-600'
                      : 'bg-white dark:bg-slate-900 border-slate-300 dark:border-slate-600 group-hover:border-blue-400'
                  }`}
                >
                  {form.recurring && (
                    <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 12 12" fill="none">
                      <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <span className="text-sm text-slate-700 dark:text-slate-300 select-none">
                  {t('expenses.form_recurring')}
                </span>
              </button>
              )}
              {form.recurring && (
                <div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">{t('expenses.form_recurring_hint')}</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelClass}>{t('expenses.form_recurrence_day')}</label>
                      <input
                        type="number"
                        min="1"
                        max="31"
                        className={inputClass}
                        value={form.recurrence_day}
                        placeholder={form.entry_date.slice(8, 10)}
                        onChange={(e) => update('recurrence_day', e.target.value)}
                      />
                    </div>
                    <div>
                      <label className={labelClass}>{t('expenses.form_recurring_until')}</label>
                      <input
                        type="date"
                        min={form.entry_date}
                        className={`${inputClass} ${untilError ? 'border-rose-500 focus:ring-rose-500' : ''}`}
                        value={form.recurrence_until}
                        onChange={(e) => { setUntilError(null); update('recurrence_until', e.target.value); }}
                      />
                    </div>
                  </div>
                  {untilError ? (
                    <p className="text-xs text-rose-500 mt-2">{t('expenses.form_until_invalid', { date: untilError })}</p>
                  ) : (
                    <p className="text-[11px] text-slate-400 mt-2">{t('expenses.form_recurring_until_hint')}</p>
                  )}

                  {/* El aviso de fin se configura en Ajustes, pero el usuario lo
                      busca AQUÍ, que es donde acaba de escribir la fecha. En vez
                      de duplicar el ajuste, se dice qué va a pasar y se ofrece el
                      atajo para cambiarlo. */}
                  {form.recurrence_until && !untilError && (
                    <div className="mt-3 flex items-start gap-2 rounded-lg border border-blue-200/70 dark:border-blue-800/40 bg-blue-50/60 dark:bg-blue-900/15 p-2.5">
                      <Bell className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
                      <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">
                        {alertPrefs.enabled && alertPrefs.leadDays.length > 0
                          ? t('expenses.form_until_alert_on', { lead: leadLabel })
                          : t('expenses.form_until_alert_off')}
                        {onOpenAlertSettings && (
                          <button
                            type="button"
                            onClick={onOpenAlertSettings}
                            className="ml-1 font-semibold text-blue-600 dark:text-blue-400 hover:underline"
                          >
                            {t('expenses.form_until_alert_settings')}
                          </button>
                        )}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
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

export default ExpenseEntryDialog;
