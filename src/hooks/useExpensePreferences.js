/**
 * Estado de la pantalla de Gastos que sale de la fila de preferencias compartida
 * (UserPreferencesContext): divisa, objetivo anual, fondo inicial, presupuestos,
 * categorías personalizadas, layout de widgets y avisos de fin de recurrente.
 *
 * Se aplica UNA vez por usuario, como la lectura propia que había antes: las
 * escrituras de la pantalla (que siguen en la página, junto a sus diálogos)
 * actualizan este estado con los setters que se devuelven.
 *
 * `initReady` es el gate de la página (mismo patrón que brokers/Dashboard): nada
 * que dependa de la divisa corre antes de leer la fila, o correría una vez con el
 * 'EUR' provisional y otra con el valor real. Un fallo de lectura avisa y abre
 * el gate igual: la pantalla nunca se queda bloqueada.
 *
 * Sacado de pages/ExpensesPage.jsx (2026-10-04) sin cambios de lógica.
 */
import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/components/ui/use-toast';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';

export function useExpensePreferences(userId) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { preferences, loading: prefsLoading, error: prefsError } = useUserPreferences();

  const [preferredCurrency, setPreferredCurrency] = useState('EUR');
  const [savingsGoal, setSavingsGoal] = useState(null);
  const [initialBalance, setInitialBalance] = useState(0);
  const [budgets, setBudgets] = useState({});
  const [customCategories, setCustomCategories] = useState({ expense: [], income: [] });
  const [savedWidgets, setSavedWidgets] = useState(null);
  const [alertPrefsRaw, setAlertPrefsRaw] = useState(null);
  const [initReady, setInitReady] = useState(false);

  const appliedFor = useRef(null);
  useEffect(() => {
    if (!userId || prefsLoading || appliedFor.current === userId) return;
    appliedFor.current = userId;
    if (prefsError) {
      toast({ title: t('expenses.toast_error'), description: prefsError.message, variant: 'destructive' });
      setInitReady(true);
      return;
    }
    const data = preferences;
    if (data?.preferred_currency) setPreferredCurrency(data.preferred_currency);
    const goal = parseFloat(data?.savings_goal_annual);
    setSavingsGoal(Number.isFinite(goal) && goal > 0 ? goal : null);
    const initial = parseFloat(data?.savings_initial_balance);
    setInitialBalance(Number.isFinite(initial) ? initial : 0);
    if (data?.expense_budgets && typeof data.expense_budgets === 'object') setBudgets(data.expense_budgets);
    setSavedWidgets(data?.expenses_widgets ?? null);
    // Para decir en el diálogo del recurrente qué aviso va a llegar (se
    // configura en Ajustes, pero se busca aquí).
    setAlertPrefsRaw(data?.recurring_end_alerts ?? null);
    const cc = data?.custom_categories;
    if (cc && typeof cc === 'object') {
      setCustomCategories({
        expense: Array.isArray(cc.expense) ? cc.expense : [],
        income: Array.isArray(cc.income) ? cc.income : [],
      });
    }
    setInitReady(true);
  }, [userId, prefsLoading, preferences, prefsError]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    initReady,
    preferredCurrency,
    savingsGoal, setSavingsGoal,
    initialBalance, setInitialBalance,
    budgets, setBudgets,
    customCategories, setCustomCategories,
    savedWidgets, setSavedWidgets,
    alertPrefsRaw,
  };
}
