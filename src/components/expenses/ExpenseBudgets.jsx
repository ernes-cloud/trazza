import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Gauge, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { EXPENSE_CATEGORIES, categoryLabel, parseAmountInput } from '@/services/expenseService';

const barColor = (pct) => {
  if (pct >= 100) return 'bg-rose-500';
  if (pct >= 80) return 'bg-amber-500';
  return 'bg-emerald-500';
};

/**
 * Card: per-category monthly budget bars (statuses from
 * expenseService.computeBudgetStatus). `onSave(budgets)` persists the map.
 */
export const BudgetsCard = ({ statuses = [], budgets = {}, customCategories = [], onAddCategory, formatMoney, onSave }) => {
  const { t } = useTranslation();
  const [isEditOpen, setIsEditOpen] = useState(false);

  return (
    <div className="h-full bg-white dark:bg-slate-800/80 rounded-2xl border border-slate-200/80 dark:border-slate-700/40 shadow-xs p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <Gauge className="w-4 h-4 text-blue-600" />
          {t('expenses.budgets_title')}
        </p>
        <button
          onClick={() => setIsEditOpen(true)}
          className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline"
        >
          <Pencil className="w-3 h-3" />
          {statuses.length > 0 ? t('expenses.budgets_edit') : t('expenses.budgets_set')}
        </button>
      </div>

      {statuses.length === 0 ? (
        <p className="text-xs text-slate-400 mt-3">{t('expenses.budgets_empty_hint')}</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {statuses.map(({ category, limit, spent, pct }) => (
            <li key={category}>
              <div className="flex items-center justify-between gap-3 mb-1">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-2">
                  {categoryLabel(t, category)}
                  {pct >= 100 && (
                    <span className="text-[9px] font-bold uppercase tracking-wide text-rose-500 bg-rose-50 dark:bg-rose-900/30 rounded-full px-2 py-0.5">
                      {t('expenses.budgets_over')}
                    </span>
                  )}
                </span>
                <span className="font-ledger text-xs tabular-nums text-slate-500 dark:text-slate-400">
                  {formatMoney(spent, 0)} / {formatMoney(limit, 0)}
                </span>
              </div>
              <div className="relative h-2 rounded-full bg-slate-100 dark:bg-slate-700/60 overflow-hidden">
                <div
                  className={`absolute inset-y-0 left-0 rounded-full transition-all ${barColor(pct)}`}
                  style={{ width: `${Math.min(100, pct)}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      <BudgetsDialog
        open={isEditOpen}
        onOpenChange={setIsEditOpen}
        budgets={budgets}
        customCategories={customCategories}
        onAddCategory={onAddCategory}
        onSave={onSave}
      />
    </div>
  );
};

/**
 * Edit dialog: shows the budgets already set (edit/remove) and an "add one"
 * row — pick a category (or create a custom one) + a limit, add it. No wall of
 * every category at once.
 */
const BudgetsDialog = ({ open, onOpenChange, budgets, customCategories = [], onAddCategory, onSave }) => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState({}); // { category: limitString } — only budgeted ones
  const [newCat, setNewCat] = useState('');
  const [newAmount, setNewAmount] = useState('');
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(Object.fromEntries(
      Object.entries(budgets || {})
        .filter(([, v]) => (parseAmountInput(v) ?? 0) > 0)
        .map(([cat, v]) => [cat, String(v)])
    ));
    setNewCat(''); setNewAmount(''); setAddingCategory(false); setNewCategoryName('');
  }, [open, budgets]);

  const allCategories = [...EXPENSE_CATEGORIES, ...customCategories];
  const available = allCategories.filter((c) => !(c in draft));

  const addBudget = () => {
    const value = parseAmountInput(newAmount);
    if (!newCat || value === null || value <= 0) return;
    setDraft((d) => ({ ...d, [newCat]: String(value) }));
    setNewCat(''); setNewAmount('');
  };

  const removeBudget = (cat) => setDraft((d) => { const n = { ...d }; delete n[cat]; return n; });

  const handleCategorySelect = (value) => {
    if (value === '__new__') { setAddingCategory(true); return; }
    setNewCat(value);
  };

  const confirmNewCategory = async () => {
    const name = newCategoryName.trim();
    if (!name || !onAddCategory) { setAddingCategory(false); return; }
    const resolved = await onAddCategory(name);
    if (resolved) setNewCat(resolved);
    setAddingCategory(false); setNewCategoryName('');
  };

  const handleSave = async () => {
    const next = {};
    for (const [cat, raw] of Object.entries(draft)) {
      const value = parseAmountInput(raw);
      if (value !== null && value > 0) next[cat] = value;
    }
    // Poka-yoke: a filled add-row not yet confirmed with "+" is INCLUDED in the
    // save. Discarding it silently made "Guardar" persist {} — which both lost
    // the new budget AND wiped the existing ones in DB.
    const pending = parseAmountInput(newAmount);
    if (newCat && pending !== null && pending > 0) next[newCat] = pending;
    setIsSaving(true);
    try {
      const ok = await onSave(next);
      if (ok) onOpenChange(false);
    } finally {
      setIsSaving(false);
    }
  };

  const amountClass = 'w-28 px-3 py-1.5 font-ledger tabular-nums border rounded-lg text-sm text-right dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500 transition-all';
  const selectClass = 'flex-1 min-w-0 px-3 py-1.5 border rounded-lg text-sm dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md dark:bg-slate-900 border-none">
        <DialogHeader>
          <DialogTitle className="dark:text-white">{t('expenses.budgets_title')}</DialogTitle>
          <DialogDescription>{t('expenses.budgets_dialog_hint')}</DialogDescription>
        </DialogHeader>
        <div className="py-2 max-h-[50vh] overflow-y-auto pr-1 space-y-2">
          {/* Budgets already set */}
          {Object.keys(draft).length === 0 ? (
            <p className="text-xs text-slate-400">{t('expenses.budgets_empty_list')}</p>
          ) : (
            Object.entries(draft).map(([cat, amt]) => (
              <div key={cat} className="flex items-center gap-2">
                <label className="text-sm text-slate-700 dark:text-slate-300 flex-1 truncate">{categoryLabel(t, cat)}</label>
                <input
                  type="text" inputMode="decimal" autoComplete="off" className={amountClass}
                  value={amt}
                  onChange={(e) => setDraft((d) => ({ ...d, [cat]: e.target.value }))}
                />
                <button
                  onClick={() => removeBudget(cat)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                  aria-label={t('expenses.budgets_remove')}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))
          )}

          {/* Add one budget at a time */}
          <div className="pt-3 mt-1 border-t border-slate-100 dark:border-slate-700/50">
            {addingCategory ? (
              <div className="flex items-center gap-2">
                <input
                  type="text" autoFocus
                  className={selectClass}
                  placeholder={t('expenses.new_category_placeholder')}
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirmNewCategory(); } if (e.key === 'Escape') setAddingCategory(false); }}
                />
                <Button type="button" onClick={confirmNewCategory} className="h-9 shrink-0">{t('expenses.save')}</Button>
                <Button type="button" variant="outline" onClick={() => setAddingCategory(false)} className="h-9 shrink-0">{t('expenses.cancel')}</Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <select className={selectClass} value={newCat} onChange={(e) => handleCategorySelect(e.target.value)}>
                  <option value="">{t('expenses.budgets_pick_category')}</option>
                  {available.map((c) => <option key={c} value={c}>{categoryLabel(t, c)}</option>)}
                  <option value="__new__">{t('expenses.new_category_option')}</option>
                </select>
                <input
                  type="text" inputMode="decimal" autoComplete="off" className={amountClass}
                  placeholder="—" value={newAmount}
                  onChange={(e) => setNewAmount(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addBudget(); } }}
                />
                <button
                  onClick={addBudget}
                  disabled={!newCat || !newAmount}
                  className="p-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 transition-colors shrink-0"
                  aria-label={t('expenses.budgets_add_button')}
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            {t('expenses.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>{t('expenses.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default BudgetsCard;
