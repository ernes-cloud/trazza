import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/customSupabaseClient';
import { useToast } from '@/components/ui/use-toast';

/**
 * CRUD de proyectos/eventos de gasto (tabla `expense_projects`): "Viaje a los
 * Pirineos", "Reforma del baño". Son una etiqueta ORTOGONAL a la categoría — un
 * movimiento apunta a un proyecto vía `expense_entries.project_id` sin perder su
 * categoría, que es lo que permite el desglose "cuánto en restaurantes DENTRO
 * del viaje" (ver computeProjectSummary).
 *
 * Los movimientos NO viven aquí: los sirve `useExpenseEntries` y la agregación
 * es pura, en el servicio. Este hook solo administra la lista de proyectos.
 */
export function useExpenseProjects(userId) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    return () => { cancelledRef.current = true; };
  }, [userId]);

  const loadProjects = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('expense_projects')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      // Sin la migración aplicada la tabla no existe (42P01): la feature se
      // apaga sola en vez de tumbar la pantalla de Gastos con un toast de error.
      if (error) {
        if (error.code === '42P01') { if (!cancelledRef.current) setProjects([]); return; }
        throw error;
      }
      if (!cancelledRef.current) setProjects(data || []);
    } catch (e) {
      if (!cancelledRef.current) {
        toast({ title: t('expenses.projects_toast_error'), description: e.message, variant: 'destructive' });
      }
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, [userId, toast, t]);

  useEffect(() => {
    if (userId) loadProjects();
  }, [userId, loadProjects]);

  const runMutation = useCallback(async (fn, successKey) => {
    try {
      await fn();
      toast({ title: t(successKey) });
      await loadProjects();
      return true;
    } catch (e) {
      toast({ title: t('expenses.projects_toast_error'), description: e.message, variant: 'destructive' });
      return false;
    }
  }, [loadProjects, toast, t]);

  /** payload: { name, start_date, end_date, goal_id } */
  const addProject = useCallback((payload) => runMutation(async () => {
    const { error } = await supabase.from('expense_projects').insert({ ...payload, user_id: userId });
    if (error) throw error;
  }, 'expenses.projects_toast_saved'), [userId, runMutation]);

  const updateProject = useCallback((id, patch) => runMutation(async () => {
    const { error } = await supabase
      .from('expense_projects')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId);
    if (error) throw error;
  }, 'expenses.projects_toast_saved'), [userId, runMutation]);

  /**
   * Borra el proyecto. Los movimientos NO se borran: la FK es ON DELETE SET NULL,
   * así que sobreviven y solo dejan de estar agrupados. Borrar el contenedor
   * nunca puede llevarse por delante el historial real de gastos del usuario.
   */
  const deleteProject = useCallback((id) => runMutation(async () => {
    const { error } = await supabase
      .from('expense_projects')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);
    if (error) throw error;
  }, 'expenses.projects_toast_deleted'), [userId, runMutation]);

  return { projects, projectsLoading: loading, addProject, updateProject, deleteProject, loadProjects };
}
