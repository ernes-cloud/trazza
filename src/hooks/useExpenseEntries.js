import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/customSupabaseClient';
import { useToast } from '@/components/ui/use-toast';
import { ToastAction } from '@/components/ui/toast';
import { isTemplate, computeMissingOccurrences, localTodayIso, buildEntryRow } from '@/services/expenseService';
import { fetchDashboardExpenseRows } from '@/services/expenses/paginatedFetch';
import { toastExpenseFetchError } from '@/services/expenses/expenseFetchResult';

/** Postgres "column does not exist" — the `skipped` migration is not applied yet. */
const isMissingColumn = (error) => error?.code === '42703';

/**
 * Inserts the catch-up occurrences, tolerating rows another tab created first.
 * A single batch insert is one statement: ONE duplicate (23505, the partial
 * UNIQUE on (recurring_source_id, source_month)) aborted the WHOLE batch and
 * silently dropped the genuinely new months for that session. `upsert` cannot
 * help here — a PARTIAL unique index is not a valid ON CONFLICT arbiter — so on
 * a collision we retry row by row and skip only the ones that really exist.
 */
async function insertOccurrences(rows) {
  const { error } = await supabase.from('expense_entries').insert(rows);
  if (!error) return;
  if (error.code !== '23505') throw error;
  for (const row of rows) {
    const { error: rowError } = await supabase.from('expense_entries').insert(row);
    if (rowError && rowError.code !== '23505') throw rowError;
  }
}

/**
 * Data hook for the personal expenses/savings module (expense_entries table).
 * Loads the user's rows, splits templates from regular entries and materializes
 * missed recurring occurrences on load (idempotent — the DB UNIQUE index on
 * (recurring_source_id, source_month) makes concurrent catch-ups safe).
 *
 * `skipped` rows (occurrences the user deleted individually) are kept in the DB
 * so the catch-up does not resurrect them, but are filtered out of everything
 * the UI sees.
 */
export function useExpenseEntries(userId) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [entries, setEntries] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const cancelledRef = useRef(false);
  const loadedOnceRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    loadedOnceRef.current = false;
    return () => { cancelledRef.current = true; };
  }, [userId]);

  const fetchRows = useCallback(async () => {
    const { data, error } = await fetchDashboardExpenseRows(supabase, userId);
    if (error) throw error;
    return data || [];
  }, [userId]);

  const publish = useCallback((rows) => {
    if (cancelledRef.current) return;
    const visible = rows.filter((r) => !r.skipped);
    setTemplates(visible.filter(isTemplate));
    setEntries(visible.filter((r) => !isTemplate(r)));
  }, []);

  const loadEntries = useCallback(async (materialize = true) => {
    if (!userId) return;
    // Only the FIRST load blanks the screen; later reloads (after a CRUD) show a
    // subtle refreshing state so the list does not flash a spinner on every edit.
    if (loadedOnceRef.current) setRefreshing(true);
    else setLoading(true);
    try {
      let rows = await fetchRows();
      if (materialize) {
        const missing = computeMissingOccurrences({
          // `rows` (not the published state) so skipped occurrences still count
          // as "this month is handled" and are never regenerated.
          templates: rows.filter(isTemplate),
          existingEntries: rows,
          today: localTodayIso(),
        });
        if (missing.length > 0) {
          await insertOccurrences(missing.map((r) => ({ ...r, user_id: userId })));
          rows = await fetchRows();
        }
      }
      publish(rows);
      loadedOnceRef.current = true;
    } catch (e) {
      if (!cancelledRef.current) {
        toastExpenseFetchError(e, { toast, t });
      }
    } finally {
      if (!cancelledRef.current) { setLoading(false); setRefreshing(false); }
    }
  }, [userId, fetchRows, publish, toast, t]);

  useEffect(() => {
    if (userId) loadEntries();
  }, [userId, loadEntries]);

  const runMutation = useCallback(async (fn, successKey, { materialize = true } = {}) => {
    try {
      await fn();
      toast({ title: t(successKey) });
      await loadEntries(materialize);
      return true;
    } catch (e) {
      toast({ title: t('expenses.toast_error'), description: e.message, variant: 'destructive' });
      return false;
    }
  }, [loadEntries, toast, t]);

  /** payload: { type, category, amount, currency, entry_date, notes, recurring, recurrence_day, recurrence_until } */
  const addEntry = useCallback((payload) => {
    // Row shape lives in expenseService (buildEntryRow) — the Dashboard's quick
    // add dialog inserts through the same function.
    const row = buildEntryRow(payload, userId);
    // A new template materializes its occurrences (current month included) on the reload
    return runMutation(async () => {
      const { error } = await supabase.from('expense_entries').insert(row);
      if (error) throw error;
    }, 'expenses.toast_added');
  }, [userId, runMutation]);

  const updateEntry = useCallback((id, patch) => runMutation(async () => {
    const { error } = await supabase
      .from('expense_entries')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId);
    if (error) throw error;
  }, 'expenses.toast_updated'), [userId, runMutation]);

  /** Re-inserts a just-deleted row (undo). New id; recurrence link preserved. */
  const restoreEntry = useCallback(async (row) => {
    const { id, created_at, updated_at, user_id, ...fields } = row;
    try {
      const { error } = await supabase
        .from('expense_entries')
        .insert({ ...fields, user_id: userId });
      if (error) throw error;
      toast({ title: t('expenses.toast_restored') });
      await loadEntries(false);
    } catch (e) {
      toast({ title: t('expenses.toast_error'), description: e.message, variant: 'destructive' });
    }
  }, [userId, loadEntries, toast, t]);

  /** Un-skips a tombstoned occurrence (undo of "delete only this one"). */
  const unskipEntry = useCallback(async (row) => {
    try {
      const { error } = await supabase
        .from('expense_entries')
        .update({ skipped: false, updated_at: new Date().toISOString() })
        .eq('id', row.id)
        .eq('user_id', userId);
      if (error) throw error;
      toast({ title: t('expenses.toast_restored') });
      await loadEntries(false);
    } catch (e) {
      toast({ title: t('expenses.toast_error'), description: e.message, variant: 'destructive' });
    }
  }, [userId, loadEntries, toast, t]);

  /**
   * A recurring OCCURRENCE is tombstoned (skipped = true) instead of deleted:
   * a hard delete left a hole that the next materialization pass re-filled, so
   * "delete only this one" silently came back. Everything else is deleted for
   * real. `deactivateTemplate` also stops future months.
   * `withUndo` swaps the plain success toast for one with an Undo action (used
   * for one-off entries — cheap deletes, cheap regrets).
   *
   * `withOccurrences` (solo plantillas): borra TAMBIÉN los movimientos que esa
   * plantilla ya generó. Sin él, la FK `ON DELETE SET NULL` los deja huérfanos
   * y siguen contando en todos los totales — el usuario "quita el recurrente" y
   * su nómina sigue ahí mes a mes. No es el default a propósito: son movimientos
   * REALES que pasaron, y borrarlos sin preguntar destruiría historial.
   */
  const deleteEntry = useCallback(async (entry, { deactivateTemplate = false, withUndo = false, withOccurrences = false } = {}) => {
    try {
      if (withOccurrences && isTemplate(entry)) {
        const { error: occError } = await supabase
          .from('expense_entries')
          .delete()
          .eq('recurring_source_id', entry.id)
          .eq('user_id', userId);
        if (occError) throw occError;
      }
      if (deactivateTemplate && entry.recurring_source_id) {
        const { error: tplError } = await supabase
          .from('expense_entries')
          .update({ recurrence_active: false, updated_at: new Date().toISOString() })
          .eq('id', entry.recurring_source_id)
          .eq('user_id', userId);
        if (tplError) throw tplError;
      }

      let undoAction = () => restoreEntry(entry);
      let tombstoned = false;
      let missingTombstone = false;
      if (entry.recurring_source_id && entry.source_month) {
        const { error } = await supabase
          .from('expense_entries')
          .update({ skipped: true, updated_at: new Date().toISOString() })
          .eq('id', entry.id)
          .eq('user_id', userId);
        if (error && !isMissingColumn(error)) throw error;
        // Migration not applied → fall back to the old hard delete. Antes esto
        // era SILENCIOSO: la ocurrencia volvía en la siguiente carga y el
        // usuario no tenía forma de saber por qué. Ahora se avisa.
        tombstoned = !error;
        missingTombstone = !!error;
        if (tombstoned) undoAction = () => unskipEntry(entry);
      }

      if (!tombstoned) {
        const { error } = await supabase
          .from('expense_entries')
          .delete()
          .eq('id', entry.id)
          .eq('user_id', userId);
        if (error) throw error;
      }

      toast({
        title: t('expenses.toast_deleted'),
        ...(missingTombstone ? { description: t('expenses.toast_deleted_may_return') } : {}),
        ...(withUndo ? {
          action: React.createElement(ToastAction, {
            altText: t('expenses.toast_undo'),
            onClick: undoAction,
          }, t('expenses.toast_undo')),
        } : {}),
      });
      await loadEntries(false);
      return true;
    } catch (e) {
      toast({ title: t('expenses.toast_error'), description: e.message, variant: 'destructive' });
      return false;
    }
  }, [userId, loadEntries, restoreEntry, unskipEntry, toast, t]);

  /** Reactivating materializes the backlog since the template's start month. */
  const setTemplateActive = useCallback((id, active) => runMutation(async () => {
    const { error } = await supabase
      .from('expense_entries')
      .update({ recurrence_active: !!active, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId);
    if (error) throw error;
  }, 'expenses.toast_updated', { materialize: !!active }), [userId, runMutation]);

  return { entries, templates, loading, refreshing, addEntry, updateEntry, deleteEntry, setTemplateActive, reload: loadEntries };
}
