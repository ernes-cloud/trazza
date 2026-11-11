import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/customSupabaseClient';
import { useToast } from '@/components/ui/use-toast';
import { parseAmountInput } from '@/services/expenseService';

/** Postgres "column does not exist" — la migración 20260822 no está aplicada. */
const isMissingColumn = (error) => error?.code === '42703';

/** CRUD for purpose-based savings goals (savings_goals table). */
export function useSavingsGoals(userId) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [goals, setGoals] = useState([]);
  const [loading, setLoading] = useState(true);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    return () => { cancelledRef.current = true; };
  }, [userId]);

  const loadGoals = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('savings_goals')
        .select('*')
        .eq('user_id', userId)
        .order('target_date', { ascending: true });
      if (error) throw error;
      if (!cancelledRef.current) setGoals(data || []);
    } catch (e) {
      if (!cancelledRef.current) {
        toast({ title: t('expenses.goals_toast_error'), description: e.message, variant: 'destructive' });
      }
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, [userId, toast, t]);

  useEffect(() => {
    if (userId) loadGoals();
  }, [userId, loadGoals]);

  const runMutation = useCallback(async (fn, successKey) => {
    try {
      await fn();
      toast({ title: t(successKey) });
      await loadGoals();
      return true;
    } catch (e) {
      toast({ title: t('expenses.goals_toast_error'), description: e.message, variant: 'destructive' });
      return false;
    }
  }, [loadGoals, toast, t]);

  /** payload: { name, target_amount, target_date, start_date } */
  const addGoal = useCallback((payload) => runMutation(async () => {
    const { error } = await supabase.from('savings_goals').insert({ ...payload, user_id: userId });
    if (error) throw error;
  }, 'expenses.goals_toast_saved'), [userId, runMutation]);

  const updateGoal = useCallback((id, patch) => runMutation(async () => {
    const { error } = await supabase
      .from('savings_goals')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId);
    if (error) throw error;
  }, 'expenses.goals_toast_saved'), [userId, runMutation]);

  const deleteGoal = useCallback((id) => runMutation(async () => {
    const { error } = await supabase
      .from('savings_goals')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);
    if (error) throw error;
  }, 'expenses.goals_toast_deleted'), [userId, runMutation]);

  /** Sets how much of the user's savings is assigned to a goal (envelope). */
  const setAllocation = useCallback((id, amount) => runMutation(async () => {
    const value = Math.max(0, parseAmountInput(amount) ?? 0);
    const { error } = await supabase
      .from('savings_goals')
      .update({ allocated_amount: value, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId);
    if (error) throw error;
  }, 'expenses.goals_alloc_saved'), [userId, runMutation]);

  /**
   * Cierra o reabre una meta (`completed_at`). Cerrarla libera su saldo hacia
   * "Disponible para asignar" — la decisión vive en `isGoalClosed`, aquí solo
   * se persiste el sello.
   *
   * Si la columna no existe todavía (migración sin aplicar) se avisa con un
   * mensaje entendible en vez del error crudo de Postgres: el resto de la
   * pantalla sigue funcionando, incluido el vencimiento, que es derivado.
   */
  const setGoalCompleted = useCallback((id, completed) => runMutation(async () => {
    const { error } = await supabase
      .from('savings_goals')
      .update({ completed_at: completed ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId);
    if (error) {
      if (isMissingColumn(error)) throw new Error(t('expenses.goals_complete_needs_migration'));
      throw error;
    }
  }, completed ? 'expenses.goals_toast_completed' : 'expenses.goals_toast_reopened'), [userId, runMutation, t]);

  return { goals, goalsLoading: loading, addGoal, updateGoal, deleteGoal, setAllocation, setGoalCompleted };
}
