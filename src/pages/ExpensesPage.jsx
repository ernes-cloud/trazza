import React, { useState, useEffect, useMemo } from 'react';
import { Helmet } from 'react-helmet';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  Plus, ChevronLeft, ChevronRight, PiggyBank, Loader2, Pencil, Trash2, Repeat, ChevronDown,
  Target, Download, Sparkles, TrendingUp, CheckCircle2, X, LayoutGrid, AlertTriangle, Bell,
  Landmark,
} from 'lucide-react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { supabase } from '@/lib/customSupabaseClient';
import { useToast } from '@/components/ui/use-toast';
import { useSupabaseAuth } from '@/contexts/SupabaseAuthContext';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { useExpensesFeature } from '@/contexts/ExpensesFeatureContext';
import { usePrivacyMode } from '@/contexts/PrivacyModeContext';
import { usePortfolioData } from '@/contexts/PortfolioDataContext';
import { useExpenseEntries } from '@/hooks/useExpenseEntries';
import { useSavingsGoals } from '@/hooks/useSavingsGoals';
import { useExpenseProjects } from '@/hooks/useExpenseProjects';
import { useExpensePreferences } from '@/hooks/useExpensePreferences';
import { usePortfolioInvested } from '@/hooks/usePortfolioInvested';
import { useExpenseRates } from '@/hooks/useExpenseRates';
import { normalizeAlertPrefs } from '@/services/recurringEndAlerts';
import { fetchExpenseImportKeys } from '@/services/expenses/paginatedFetch';
import { applyExpenseImportKeysResult } from '@/services/expenses/expenseFetchResult';
import {
  isTemplate, monthKeyOf, endOfMonthIso, computeMonthlySummary, computeAnnualSummary,
  projectAnnualSavings,
  computeCategoryBreakdownRange,
  computeProjectedOccurrences, computeAnnualSeriesWithProjection, computeDailyTotals,
  computeGoalProgress, computeAllocatedTotal, computeGoalSpendingByGoal, computeTotalSavedBalance,
  computeBudgetStatus, computeMonthlyInsights, computeBalanceSeries, expensesToCsv,
  EXPENSE_CATEGORIES, INCOME_CATEGORIES, categoryLabel,
  parseAmountInput, localTodayIso, presentBreakdown,
} from '@/services/expenseService';
import MonthlyBreakdownChart from '@/components/cartera/MonthlyBreakdownChart';
import ExpenseEntryDialog from '@/components/expenses/ExpenseEntryDialog';
import ExpenseCalendar from '@/components/expenses/ExpenseCalendar';
import SavingsGoalsCard from '@/components/expenses/SavingsGoalsCard';
import SavingsGoalDialog from '@/components/expenses/SavingsGoalDialog';
import ExpenseProjectsCard from '@/components/expenses/ExpenseProjectsCard';
import ExpenseProjectDialog from '@/components/expenses/ExpenseProjectDialog';
import ExpenseList from '@/components/expenses/ExpenseList';
import { BudgetsCard } from '@/components/expenses/ExpenseBudgets';
import ExpenseCategoryDonut from '@/components/expenses/ExpenseCategoryDonut';
import BankImportDialog from '@/components/expenses/BankImportDialog';
import { BANK_IMPORT_ENABLED } from '@/lib/featureFlags';
import DashboardCustomizer from '@/components/dashboard/DashboardCustomizer';
import {
  resolveDashboardLayout, serializeLayout, EXPENSES_PAGE_WIDGETS,
} from '@/services/dashboardLayout';
import { formatNumber, getCurrencySymbol } from '@/lib/formatters';

const TabButton = ({ active, onClick, label }) => (
  <button
    onClick={onClick}
    className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-all ${
      active
        ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 shadow-xs border border-slate-200 dark:border-slate-700'
        : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
    }`}
  >
    {label}
  </button>
);

// Ledger tiles: neutral ink for the figure (mono), semantics live in the dot
// marker and the delta line — a red month should inform, not shout.
// Tile de cifra. En móvil van 2×2 dentro de ~343px, así que cada uno dispone de
// ~140px de contenido: el label lleva tracking amplio (se parte antes que el
// número) y la cifra baja un escalón para no desbordar con importes de 5+ dígitos.
const StatTile = ({ label, value, dot, delta, className = '' }) => (
  <div className={`bg-white dark:bg-slate-800/80 rounded-2xl border border-slate-200/80 dark:border-slate-700/40 shadow-xs p-3.5 sm:p-4 ${className}`}>
    <p className="font-ledger text-[9px] sm:text-[10px] uppercase tracking-[0.12em] sm:tracking-[0.2em] text-slate-400 flex items-center gap-1.5">
      {dot && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />}
      <span className="min-w-0 truncate">{label}</span>
    </p>
    <p className="font-ledger text-lg sm:text-xl font-bold tabular-nums tracking-tight mt-1 text-slate-900 dark:text-white wrap-break-word">
      {value}
    </p>
    {delta && (
      <p className={`font-ledger text-[10px] tabular-nums mt-0.5 ${delta.tone}`}>{delta.text}</p>
    )}
  </div>
);

const ExpensesPage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useSupabaseAuth();
  const { savePreferences } = useUserPreferences();
  const { toast } = useToast();
  const { expensesEnabled, loading: featureLoading } = useExpensesFeature();
  const { privacyMode } = usePrivacyMode();
  // The Dashboard's live-priced snapshot, when this session already loaded it.
  const { portfolioSnapshot } = usePortfolioData() || {};
  const {
    entries, templates, loading, refreshing, addEntry, updateEntry, deleteEntry, setTemplateActive,
    reload: reloadEntries,
  } = useExpenseEntries(user?.id);
  const { goals, addGoal, updateGoal, deleteGoal, setAllocation, setGoalCompleted } = useSavingsGoals(user?.id);
  const { projects, addProject, updateProject, deleteProject } = useExpenseProjects(user?.id);
  // Estado que sale de la fila de preferencias + el gate initReady (ver el hook).
  const {
    initReady, preferredCurrency,
    savingsGoal, setSavingsGoal, initialBalance, setInitialBalance,
    budgets, setBudgets, customCategories, setCustomCategories,
    savedWidgets, setSavedWidgets, alertPrefsRaw,
  } = useExpensePreferences(user?.id);

  const now = new Date();
  const [activeTab, setActiveTab] = useState('monthly');
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [isGoalDialogOpen, setIsGoalDialogOpen] = useState(false);
  const [goalInput, setGoalInput] = useState('');
  const [goalError, setGoalError] = useState(false);
  const [isEntryDialogOpen, setIsEntryDialogOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showGoalBreakdown, setShowGoalBreakdown] = useState(false);
  const [isGoalFormOpen, setIsGoalFormOpen] = useState(false);
  const [editingGoal, setEditingGoal] = useState(null);
  const [isBankImportOpen, setIsBankImportOpen] = useState(false);
  // import_key values already stored, so the preview can show what it will SKIP
  // instead of silently dropping rows (statements overlap by design).
  const [importedKeys, setImportedKeys] = useState(() => new Set());
  // Se lee con la MISMA normalización que el cron: la campanita solo aparece si
  // de verdad va a llegar un aviso.
  const alertsOn = (() => {
    const p = normalizeAlertPrefs(alertPrefsRaw);
    return p.enabled && p.leadDays.length > 0;
  })();
  const [isProjectFormOpen, setIsProjectFormOpen] = useState(false);
  const [editingProject, setEditingProject] = useState(null);
  const [deleteProjectTarget, setDeleteProjectTarget] = useState(null);
  const [deleteGoalTarget, setDeleteGoalTarget] = useState(null);
  const [isInitialDialogOpen, setIsInitialDialogOpen] = useState(false);
  const [initialInput, setInitialInput] = useState('');
  const [initialError, setInitialError] = useState(false);
  const [selectedDay, setSelectedDay] = useState(null);
  const [entryDefaults, setEntryDefaults] = useState({});
  const [isCustomizerOpen, setIsCustomizerOpen] = useState(false);
  const [donutFrom, setDonutFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const [donutTo, setDonutTo] = useState(endOfMonthIso());
  const [donutType, setDonutType] = useState('expense');

  // Opt-in gate: the page is unreachable unless the feature is enabled in Settings
  useEffect(() => {
    if (!featureLoading && !expensesEnabled) navigate('/app', { replace: true });
  }, [featureLoading, expensesEnabled, navigate]);

  // Customizable widget layout (order + visibility), persisted per user in
  // user_preferences.expenses_widgets with the same contract as the Dashboard.
  const widgetLayout = useMemo(
    () => resolveDashboardLayout(savedWidgets, EXPENSES_PAGE_WIDGETS),
    [savedWidgets],
  );
  const widgetById = useMemo(
    () => new Map(widgetLayout.map((w, i) => [w.id, { ...w, index: i }])),
    [widgetLayout],
  );
  const wOrder = (id) => widgetById.get(id)?.index ?? 99;
  const wVis = (id) => widgetById.get(id)?.visible !== false;
  // `span` comes from the registry — the page used to hardcode lg:col-span-2,
  // a second source of truth that would drift the moment the registry changed.
  const wSpan = (id) => (widgetById.get(id)?.span === 2 ? 'lg:col-span-2' : '');
  const heroVisible = wVis('savings_hero');

  const saveWidgets = async (config) => {
    setSavedWidgets(config);
    if (!user?.id) return;
    const { error } = await savePreferences({ expenses_widgets: config });
    if (error) {
      toast({ title: t('expenses.toast_error'), description: error.message, variant: 'destructive' });
    }
  };
  const persistWidgetLayout = (next) => saveWidgets(serializeLayout(next));
  const resetWidgetLayout = () => saveWidgets(null);

  // "Invertido en cartera" (valor de mercado, el mismo que Dashboard/brokers):
  // tres fuentes de más fresca a menos, ver hooks/usePortfolioInvested.
  const portfolioInvested = usePortfolioInvested({
    userId: user?.id,
    currency: preferredCurrency,
    enabled: initReady && heroVisible,
    portfolioSnapshot,
  });

  const sym = getCurrencySymbol(preferredCurrency);
  // Local date everywhere: monthKeyOf(new Date().toISOString()) is the UTC
  // month, which flips a day early on the 1st for any timezone east of UTC.
  const today = localTodayIso();
  const currentMonthKey = monthKeyOf(today) || '';
  const { fxOpts, foreignCurrencies } = useExpenseRates(entries, templates, preferredCurrency);

  const maskMoney = (str) => (privacyMode ? '••••' : str);
  const money = (v, decimals = 2) => maskMoney(`${sym}${formatNumber(v, decimals, decimals)}`);
  const signedMoney = (v, decimals = 0) => `${v >= 0 ? '+' : '-'}${money(Math.abs(v), decimals)}`;
  const percent = (v, decimals = 0) => `${formatNumber(v, decimals, decimals)}%`;
  const percentMasked = (v, decimals = 0) => maskMoney(`${formatNumber(v, decimals, decimals)}%`);
  const monthNames = t('expenses.month_names', { returnObjects: true });

  // A future month shows its recurring occurrences as display-only "previsto" rows
  const isFutureMonth = currentMonthKey !== '' && `${year}-${String(month).padStart(2, '0')}` > currentMonthKey;

  const projectedMonthEntries = useMemo(() => (
    isFutureMonth
      ? computeProjectedOccurrences({ templates, existingEntries: entries, year, month })
      : []
  ), [isFutureMonth, templates, entries, year, month]);

  const entriesWithProjection = useMemo(() => (
    projectedMonthEntries.length > 0 ? [...entries, ...projectedMonthEntries] : entries
  ), [entries, projectedMonthEntries]);

  const summary = useMemo(() => (
    activeTab === 'monthly'
      ? computeMonthlySummary(entriesWithProjection, { year, month, ...fxOpts })
      : computeAnnualSummary(entries, { year, ...fxOpts })
  ), [entries, entriesWithProjection, activeTab, year, month, fxOpts]);

  const annualSeries = useMemo(() => (
    computeAnnualSeriesWithProjection({ entries, templates, year, today, ...fxOpts })
      .map((b) => ({ name: monthNames[b.month - 1], value: b.net + b.projectedNet, projected: b.projected }))
  ), [entries, templates, year, monthNames, today, fxOpts]);

  const annualProjectedTotal = useMemo(() => (
    annualSeries.reduce((acc, b) => (b.projected ? acc + b.value : acc), 0)
  ), [annualSeries]);


  const projection = useMemo(() => (
    projectAnnualSavings({ entries, templates, year, today, initialBalance, ...fxOpts })
  ), [entries, templates, year, initialBalance, today, fxOpts]);

  // Índice de sobres por id: el widget de proyectos necesita el sobre enlazado
  // para comparar apartado vs gastado, y buscarlo por fila sería O(n²).
  const goalsById = useMemo(
    () => Object.fromEntries(goals.map((g) => [g.id, g])),
    [goals],
  );

  // Lo ya gastado a través de los proyectos enlazados a cada sobre. El sobre es
  // un SALDO: si el viaje ya se pagó, ese dinero deja de estar reservado. Sin
  // esto el mismo gasto penalizaba dos veces (bajaba el ahorro acumulado Y el
  // sobre seguía reteniendo su importe íntegro).
  const goalSpending = useMemo(
    () => computeGoalSpendingByGoal(projects, entries, fxOpts),
    [projects, entries, fxOpts],
  );

  const goalsWithProgress = useMemo(() => (
    goals.map((goal) => ({
      ...goal,
      progress: computeGoalProgress({ goal, today, spent: goalSpending[goal.id] || 0 }),
    }))
  ), [goals, today, goalSpending]);

  const totalSavedBalance = useMemo(() => (
    computeTotalSavedBalance(entries, initialBalance, today, fxOpts)
  ), [entries, initialBalance, today, fxOpts]);

  // Envelope pool: how much of the accumulated savings is committed to goals
  // and how much is still free. Lo ya gastado (goalSpending) NO sigue reservado.
  const goalsAllocatedTotal = useMemo(
    // `today`: una meta vencida sin alcanzar deja de retener su saldo, que
    // vuelve a "Disponible para asignar" (ver isGoalClosed).
    () => computeAllocatedTotal(goals, goalSpending, { today }),
    [goals, goalSpending, today],
  );
  const availableToAllocate = totalSavedBalance - goalsAllocatedTotal;

  const dailyTotals = useMemo(() => (
    computeDailyTotals(entriesWithProjection, { year, month, ...fxOpts })
  ), [entriesWithProjection, year, month, fxOpts]);

  const periodEntries = useMemo(() => {
    const prefix = activeTab === 'monthly' ? `${year}-${String(month).padStart(2, '0')}` : `${year}-`;
    const real = entries.filter((e) => (monthKeyOf(e.entry_date) || '').startsWith(prefix));
    if (activeTab !== 'monthly' || projectedMonthEntries.length === 0) return real;
    return [...real, ...projectedMonthEntries].sort((a, b) => (a.entry_date < b.entry_date ? 1 : -1));
  }, [entries, projectedMonthEntries, activeTab, year, month]);

  const listRows = useMemo(() => {
    if (activeTab !== 'monthly' || selectedDay === null) return periodEntries;
    const dayIso = `${year}-${String(month).padStart(2, '0')}-${String(selectedDay).padStart(2, '0')}`;
    return periodEntries.filter((e) => (e.entry_date || '').split('T')[0] === dayIso);
  }, [periodEntries, activeTab, selectedDay, year, month]);

  // Month-over-month deltas for the tiles (only when the previous month has data).
  // Suppressed on future months: `summary` there is a PROJECTION and the previous
  // month is real, so the comparison read as fact when it was not comparable.
  const deltas = useMemo(() => {
    if (activeTab !== 'monthly' || isFutureMonth) return null;
    const prev = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
    const prevSummary = computeMonthlySummary(entries, { ...fxOpts, year: prev.year, month: prev.month });
    if (prevSummary.income === 0 && prevSummary.expenses === 0) return null;
    const prevLabel = monthNames[prev.month - 1];
    const build = (current, previous, upIsGood) => {
      if (previous === 0) return null;
      const pct = Math.round(((current - previous) / Math.abs(previous)) * 100);
      if (pct === 0) return null;
      const isGood = pct > 0 ? upIsGood : !upIsGood;
      return {
        text: `${pct > 0 ? '▲' : '▼'} ${maskMoney(`${Math.abs(pct)}%`)} ${t('expenses.delta_vs', { month: prevLabel })}`,
        tone: isGood ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400',
      };
    };
    return {
      income: build(summary.income, prevSummary.income, true),
      expenses: build(summary.expenses, prevSummary.expenses, false),
      net: build(summary.net, prevSummary.net, true),
    };
  }, [activeTab, isFutureMonth, entries, year, month, summary, monthNames, t, privacyMode, fxOpts]);

  const insights = useMemo(() => (
    activeTab === 'monthly' && !isFutureMonth
      ? computeMonthlyInsights(entries, { year, month, ...fxOpts })
      : []
  ), [activeTab, isFutureMonth, entries, year, month, fxOpts]);

  const budgetStatuses = useMemo(() => (
    computeBudgetStatus(entriesWithProjection, budgets, { year, month, ...fxOpts })
  ), [entriesWithProjection, budgets, year, month, fxOpts]);

  const donutData = useMemo(() => (
    computeCategoryBreakdownRange(entries, { from: donutFrom, to: donutTo, type: donutType, ...fxOpts })
  ), [entries, donutFrom, donutTo, donutType, fxOpts]);

  const donutPresentation = useMemo(
    () => presentBreakdown(donutData.rows, { privacyMode }),
    [donutData.rows, privacyMode],
  );

  const fxExclusions = useMemo(() => {
    const parts = [summary, donutData, projection, budgetStatuses];
    const excludedCount = Math.max(0, ...parts.map((p) => p?.excludedCount || 0));
    const notConvertible = parts.some((p) => p?.notConvertible);
    return { notConvertible, excludedCount };
  }, [summary, donutData, projection, budgetStatuses]);

  const balanceSeries = useMemo(() => (
    computeBalanceSeries({ entries, templates, year, today, initialBalance, ...fxOpts })
  ), [entries, templates, year, initialBalance, today, fxOpts]);

  const showOnboarding = !loading && entries.length === 0 && templates.length === 0;

  const shiftMonth = (delta) => {
    const d = new Date(Date.UTC(year, month - 1 + delta, 1));
    setYear(d.getUTCFullYear());
    setMonth(d.getUTCMonth() + 1);
    setSelectedDay(null);
  };

  const handleSubmitEntry = async (payload) => {
    if (!editingEntry) return addEntry({ ...payload, currency: preferredCurrency });
    const { recurring, recurrence_day, recurrence_until, ...patch } = payload;
    if (isTemplate(editingEntry)) {
      // entry_date is the template's start date: moving it earlier backfills the
      // missing months on the reload; moving it later does NOT delete already
      // generated occurrences (the user removes those from the list if unwanted)
      patch.recurrence_day = recurrence_day || Number(patch.entry_date?.slice(8, 10)) || 1;
      patch.recurrence_until = recurrence_until;
    }
    return updateEntry(editingEntry.id, patch);
  };

  const handleDelete = async (opts = {}) => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (target) await deleteEntry(target, opts);
  };

  // Recurring rows keep the confirm dialog (regeneration caveat); one-off
  // entries delete instantly with an Undo toast — cheap deletes, cheap regrets
  const handleRowDelete = (row) => {
    if (row.recurring_source_id || isTemplate(row)) setDeleteTarget(row);
    else deleteEntry(row, { withUndo: true });
  };


  const handleCalendarDayClick = (day, iso, hasData) => {
    if (hasData) {
      setSelectedDay((current) => (current === day ? null : day));
    } else {
      setEntryDefaults({ date: iso });
      setEditingEntry(null);
      setIsEntryDialogOpen(true);
    }
  };

  const saveBudgets = async (next) => {
    const { error } = await savePreferences({ expense_budgets: next });
    if (error) {
      toast({ title: t('expenses.toast_error'), description: error.message, variant: 'destructive' });
      return false;
    }
    setBudgets(next);
    toast({ title: t('expenses.budgets_saved') });
    return true;
  };

  // Adds a user-defined category (by display name) for the given type and
  // persists it. Returns the resolved name so the caller can select it.
  const addCustomCategory = async (type, rawName) => {
    const name = (rawName || '').trim();
    if (!name) return null;
    const list = customCategories[type] || [];
    const existing = list.find((c) => c.toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    const next = { ...customCategories, [type]: [...list, name] };
    setCustomCategories(next);
    const { error } = await savePreferences({ custom_categories: next });
    if (error) {
      // Roll back the optimistic add: keeping it showed a category in the picker
      // that does not exist in the DB and vanishes on the next reload.
      setCustomCategories(customCategories);
      toast({ title: t('expenses.toast_error'), description: error.message, variant: 'destructive' });
      return null;
    }
    return name;
  };

  const handleExportCsv = () => {
    const hasRows = entries.some((e) => (monthKeyOf(e.entry_date) || '').startsWith(`${year}-`));
    if (!hasRows) {
      // Downloading a file with nothing but headers looks like a broken export
      toast({ title: t('expenses.export_empty_title'), description: t('expenses.export_empty_desc', { year }) });
      return;
    }
    const categoryNames = Object.fromEntries(
      [...new Set([...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES])].map((cat) => [cat, categoryLabel(t, cat)])
    );
    const csv = expensesToCsv(entries, {
      year,
      ...fxOpts,
      labels: {
        date: t('expenses.form_date'),
        type: t('expenses.csv_type'),
        category: t('expenses.form_category'),
        amount: t('expenses.csv_amount_original'),
        currency: t('expenses.csv_currency_original'),
        converted: t('expenses.csv_converted'),
        notConvertible: t('expenses.csv_not_convertible'),
        notes: t('expenses.csv_notes'),
        income: t('expenses.form_type_income'),
        expense: t('expenses.form_type_expense'),
        total: t('expenses.csv_total'),
        monthNames,
        categoryNames,
      },
    });
    // BOM so Excel opens it as UTF-8 (tildes/€ intact)
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trazza-gastos-${year}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /**
   * Loads the keys of everything previously imported before opening the dialog.
   * A named-column select is safe here because a missing `import_key` (migration
   * not applied) must NOT block the user — it degrades to "nothing imported yet"
   * and the UNIQUE index still stops a real double insert.
   */
  const openBankImport = async () => {
    // import_key completo vía fetchExpenseImportKeys (paginatedFetch)
    const result = await fetchExpenseImportKeys(supabase, user.id);
    applyExpenseImportKeysResult(result, {
      setImportedKeys,
      setIsBankImportOpen,
      toast,
      t,
    });
  };

  const handleBankImportConfirm = async (rows, { bank }) => {
    if (!rows.length) return false;
    const { error } = await supabase.from('expense_entries').insert(rows);
    if (error) {
      toast({ title: t('expenses.toast_error'), description: error.message, variant: 'destructive' });
      return false;
    }
    toast({ title: t('bank_import.toast_done', { count: rows.length, bank: t(`bank_import.bank_${bank}`) }) });
    // No materialization pass: an imported movement is a one-off, never a template.
    await reloadEntries(false);
    return true;
  };

  const saveGoal = async (value) => {
    const { error } = await savePreferences({ savings_goal_annual: value });
    if (error) {
      toast({ title: t('expenses.toast_error'), description: error.message, variant: 'destructive' });
      return;
    }
    setSavingsGoal(value);
    setIsGoalDialogOpen(false);
    toast({ title: t('expenses.goal_saved') });
  };

  const handleSaveGoal = () => {
    const value = parseAmountInput(goalInput);
    if (value === null || value <= 0) {
      setGoalError(true);
      return;
    }
    saveGoal(value);
  };

  const openInitialBalanceDialog = () => {
    setInitialInput(initialBalance ? String(initialBalance) : '');
    setInitialError(false);
    setIsInitialDialogOpen(true);
  };

  const handleSaveInitialBalance = async () => {
    const raw = String(initialInput).trim();
    const value = raw === '' ? 0 : parseAmountInput(raw);
    if (value === null || value < 0) {
      setInitialError(true);
      return;
    }
    const { error } = await savePreferences({ savings_initial_balance: value });
    if (error) {
      toast({ title: t('expenses.goals_toast_error'), description: error.message, variant: 'destructive' });
      return;
    }
    setInitialBalance(value);
    setIsInitialDialogOpen(false);
    toast({ title: t('expenses.initial_balance_saved') });
  };

  const handleSubmitSavingsGoal = (payload) => (
    editingGoal ? updateGoal(editingGoal.id, payload) : addGoal(payload)
  );

  const handleDeleteSavingsGoal = async () => {
    const target = deleteGoalTarget;
    setDeleteGoalTarget(null);
    if (target) await deleteGoal(target.id);
  };

  const handleSubmitProject = (payload) => (
    editingProject ? updateProject(editingProject.id, payload) : addProject(payload)
  );

  const handleDeleteProject = async () => {
    const target = deleteProjectTarget;
    setDeleteProjectTarget(null);
    if (target) await deleteProject(target.id);
  };

  if (featureLoading || !expensesEnabled) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const savingsRateText = summary.savingsRate === null ? '—' : percentMasked(summary.savingsRate * 100, 1);
  const isRecurringOccurrence = !!deleteTarget?.recurring_source_id;
  // Borrar la PLANTILLA no borra lo que ya generó (FK ON DELETE SET NULL), así
  // que hay que decir cuántos movimientos son y ofrecer llevárselos por delante:
  // sin eso, "quitar el ingreso recurrente" lo dejaba contando en todos los meses.
  const deletingTemplate = !!deleteTarget && isTemplate(deleteTarget);
  const templateOccurrenceCount = deletingTemplate
    ? entries.filter((e) => e.recurring_source_id === deleteTarget.id).length
    : 0;

  return (
    <div className="space-y-6 pb-16">
      <Helmet>
        <title>{t('expenses.page_title')}</title>
        <meta name="description" content={t('expenses.meta_desc')} />
      </Helmet>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-black tracking-tight text-slate-900 dark:text-white flex items-center gap-2">
            <PiggyBank className="w-6 h-6 text-blue-600" />
            {t('expenses.title')}
          </h1>
          <p className="text-slate-500 dark:text-slate-400 mt-1 text-sm">{t('expenses.subtitle')}</p>
        </div>
        <Button onClick={() => { setEditingEntry(null); setIsEntryDialogOpen(true); }} className="gap-2">
          <Plus className="w-4 h-4" />
          {t('expenses.add_entry')}
        </Button>
      </div>

      {/* Barra de periodo. En móvil el contenido suma más ancho del disponible,
          así que en vez de dejar que `flex-wrap` lo parta donde quiera, se ordena
          el corte a propósito: fila 1 pestañas + acciones, fila 2 el navegador de
          mes a ancho completo con las flechas en los extremos (pulgar, Fitts).
          En sm+ vuelve a una sola fila con el orden original. Sin duplicar JSX:
          sólo `order` + `w-full`. */}
      {/* Fondo OPACO en móvil: al ocupar dos filas, el 90% translúcido dejaba leer
          los importes que pasaban por debajo al hacer scroll ("€319 · 3%" cruzando
          la fila del mes). En sm+ la barra es fina y el velo translúcido no molesta. */}
      <div className="sticky top-0 z-20 flex flex-wrap items-center gap-2 sm:gap-3 bg-background sm:bg-background/90 backdrop-blur-md py-2.5 -mx-4 md:-mx-6 px-4 md:px-6 border-b border-slate-200/80 dark:border-slate-700/40">
        <div className="order-1 flex items-center gap-1 bg-slate-100 dark:bg-slate-900/60 rounded-xl p-1">
          <TabButton active={activeTab === 'monthly'} onClick={() => setActiveTab('monthly')} label={t('expenses.tab_monthly')} />
          <TabButton active={activeTab === 'annual'} onClick={() => setActiveTab('annual')} label={t('expenses.tab_annual')} />
        </div>
        <div className="order-3 sm:order-2 w-full sm:w-auto sm:ml-auto flex items-center justify-between sm:justify-end gap-1 sm:gap-2">
          <button
            onClick={() => (activeTab === 'monthly' ? shiftMonth(-1) : setYear(year - 1))}
            className="p-3 lg:p-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            aria-label={t('common.previous')}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="flex-1 sm:flex-none sm:min-w-[110px] text-sm font-bold text-slate-900 dark:text-white text-center font-ledger tabular-nums">
            {activeTab === 'monthly' ? `${monthNames[month - 1]} ${year}` : year}
            {activeTab === 'monthly' && isFutureMonth && (
              <span className="ml-2 inline-flex text-[9px] font-bold uppercase tracking-wide text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 rounded-full px-2 py-0.5 align-middle">
                {t('expenses.projected_badge')}
              </span>
            )}
          </span>
          <button
            onClick={() => (activeTab === 'monthly' ? shiftMonth(1) : setYear(year + 1))}
            className="p-3 lg:p-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            aria-label={t('common.next')}
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
        {/* Acciones: en móvil suben a la fila de las pestañas (order-2), donde
            sobra sitio; en sm+ vuelven al final de la barra. */}
        <div className="order-2 sm:order-3 ml-auto sm:ml-0 flex items-center gap-1">
          {/* Oculto tras BANK_IMPORT_ENABLED: la feature está a medias (sin
              categorización IA y con la migración sin aplicar). Ver CLAUDE.md. */}
          {BANK_IMPORT_ENABLED && (
            <button
              onClick={openBankImport}
              className="p-3 lg:p-2 rounded-lg text-slate-500 hover:text-sky-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              title={t('bank_import.open_button')}
              aria-label={t('bank_import.open_button')}
            >
              <Landmark className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={handleExportCsv}
            className="p-3 lg:p-2 rounded-lg text-slate-500 hover:text-blue-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            title={t('expenses.export_csv', { year })}
            aria-label={t('expenses.export_csv', { year })}
          >
            <Download className="w-4 h-4" />
          </button>
          <button
            onClick={() => setIsCustomizerOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-3 lg:px-2.5 lg:py-2 rounded-lg text-slate-500 hover:text-blue-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors text-xs font-semibold"
            title={t('dashboard.customize_button')}
            aria-label={t('dashboard.customize_button')}
          >
            <LayoutGrid className="w-4 h-4" />
            <span className="hidden sm:inline">{t('dashboard.customize_button')}</span>
          </button>
        </div>
      </div>

      <BankImportDialog
        open={BANK_IMPORT_ENABLED && isBankImportOpen}
        onOpenChange={setIsBankImportOpen}
        userId={user?.id}
        defaultCurrency={preferredCurrency}
        existingKeys={importedKeys}
        onConfirm={handleBankImportConfirm}
      />

      <DashboardCustomizer
        open={isCustomizerOpen}
        onOpenChange={setIsCustomizerOpen}
        layout={widgetLayout}
        onChange={persistWidgetLayout}
        onReset={resetWidgetLayout}
      />

      {showOnboarding && (
        <div className="bg-white dark:bg-slate-800/80 rounded-2xl border border-slate-200/80 dark:border-slate-700/40 shadow-xs p-5">
          <p className="text-sm font-bold text-slate-900 dark:text-white">{t('expenses.onboarding_title')}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{t('expenses.onboarding_subtitle')}</p>
          <div className="mt-4 space-y-3">
            {[
              { done: initialBalance > 0, label: t('expenses.onboarding_step1'), action: openInitialBalanceDialog, cta: t('expenses.add_saved_button') },
              { done: false, label: t('expenses.onboarding_step2'), action: () => { setEntryDefaults({ recurring: true }); setEditingEntry(null); setIsEntryDialogOpen(true); }, cta: t('expenses.add_entry') },
              { done: !!savingsGoal, label: t('expenses.onboarding_step3'), action: () => { setGoalInput(savingsGoal ? String(savingsGoal) : ''); setGoalError(false); setIsGoalDialogOpen(true); }, cta: t('expenses.goal_set') },
            ].map((step, i) => (
              <div key={i} className="flex items-center gap-3">
                {step.done ? (
                  <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
                ) : (
                  <span className="w-5 h-5 shrink-0 rounded-full border-2 border-slate-300 dark:border-slate-600 flex items-center justify-center font-ledger text-[10px] font-bold text-slate-400">
                    {i + 1}
                  </span>
                )}
                <p className={`text-sm flex-1 ${step.done ? 'text-slate-400 line-through' : 'text-slate-700 dark:text-slate-300'}`}>{step.label}</p>
                {!step.done && (
                  <Button variant="outline" onClick={step.action} className="h-8 text-xs">{step.cta}</Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {foreignCurrencies.length > 0 && (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-300/70 dark:border-amber-700/50 bg-amber-50 dark:bg-amber-900/20 p-4">
          <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-800 dark:text-amber-200">
            <span className="font-bold">{t('expenses.mixed_currency_title')}</span>{' '}
            {t('expenses.mixed_currency_desc', {
              display: preferredCurrency,
              others: foreignCurrencies.join(', '),
            })}
          </p>
        </div>
      )}
      {fxExclusions.notConvertible && fxExclusions.excludedCount > 0 && (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-300/70 dark:border-amber-700/50 bg-amber-50 dark:bg-amber-900/20 p-4">
          <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-800 dark:text-amber-200">
            {t('expenses.not_convertible_desc', { count: fxExclusions.excludedCount })}
          </p>
        </div>
      )}

      {/* Customizable widget grid — order + visibility per user (Personalizar).
          grid-flow-row-dense fills the holes left by hiding a widget (or by the
          annual tab dropping budgets/calendar); auto-rows + [&>div]:h-full keep
          the card borders of a row aligned. Same policy as the Dashboard. */}
      {/* `[&>div]:min-w-0` NO es decorativo: un grid item trae `min-width:auto`,
          así que un solo hijo indeformable (el input de búsqueda de Movimientos,
          ~212px de ancho intrínseco) estiraba la ÚNICA columna de móvil a 367px
          dentro de un contenedor de 343 y arrastraba a TODOS los widgets fuera
          de la pantalla. Medido: 8px de desbordamiento en cada card a 375px. */}
      <div className="grid lg:grid-cols-2 gap-4 lg:gap-6 grid-flow-row-dense lg:auto-rows-[minmax(280px,auto)] [&>div]:h-full [&>div]:min-w-0">

      {/* Ahorro acumulado (hero) */}
      {wVis('savings_hero') && (
      <div style={{ order: wOrder('savings_hero') }} className={wSpan('savings_hero')}>
      <ErrorBoundary title={t('expenses.widget_savings_hero')}>
      {/* HERO — Ahorro acumulado es el rey de la pantalla: cuánto tienes ahora.
          Invertido + Patrimonio viven aquí también (una sola casa para "cuánto
          tengo"), no repartidos por otras cards. */}
      <div className="h-full bg-white dark:bg-slate-800/80 rounded-2xl border border-slate-200/80 dark:border-slate-700/40 shadow-xs p-5 md:p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-ledger text-[10px] uppercase tracking-[0.2em] text-slate-400 flex items-center gap-1.5">
              <PiggyBank className="w-3.5 h-3.5 text-blue-600" />
              {t('expenses.accumulated_savings_label')}
            </p>
            {/* No cents on the hero: at 5xl they are noise, not information —
                the exact figure lives in the movement list. */}
            {/* La cifra hero escala con el viewport: a 4xl fijo, un saldo de seis
                dígitos se comía el ancho del móvil y empujaba al botón de editar. */}
            <p className={`font-ledger text-3xl sm:text-4xl md:text-5xl font-bold tabular-nums tracking-tight mt-1.5 wrap-break-word ${totalSavedBalance >= 0 ? 'text-slate-900 dark:text-white' : 'text-rose-500 dark:text-rose-400'}`}>
              {money(totalSavedBalance, 0)}
            </p>
            <p className="text-[11px] text-slate-400 mt-1.5 font-ledger tabular-nums">
              {t('expenses.accumulated_breakdown', {
                base: money(initialBalance, 0),
                net: signedMoney(totalSavedBalance - initialBalance),
              })}
            </p>
            {goalsAllocatedTotal > 0 && (
              <div className="mt-3 max-w-xs">
                <div className="relative h-1.5 rounded-full bg-slate-100 dark:bg-slate-700/60 overflow-hidden">
                  <div
                    className="absolute inset-y-0 left-0 bg-blue-500 rounded-full transition-all"
                    style={{ width: `${totalSavedBalance > 0 ? Math.min(100, (goalsAllocatedTotal / totalSavedBalance) * 100) : 0}%` }}
                  />
                </div>
                <p className="text-[11px] text-slate-400 mt-1.5 font-ledger tabular-nums">
                  {t('expenses.assigned_to_goals')}: <span className="font-bold text-blue-600 dark:text-blue-400">{money(goalsAllocatedTotal, 0)}</span>
                  {' · '}
                  {t('expenses.free_savings')}: <span className={`font-bold ${availableToAllocate >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'}`}>
                    {/* CON céntimos, al revés que los agregados de al lado: el
                        ahorro libre es un RESIDUO (acumulado − asignado), así
                        que suele ser un número pequeño donde 29 y 29,45 no son
                        lo mismo — y es el que se mira antes de asignar. */}
                    {availableToAllocate < 0 ? '−' : ''}{money(Math.abs(availableToAllocate), 2)}
                  </span>
                </p>
              </div>
            )}
          </div>
          <button
            onClick={openInitialBalanceDialog}
            className="shrink-0 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline"
          >
            {initialBalance > 0 ? t('expenses.initial_balance_edit_short') : t('expenses.add_saved_button')}
          </button>
        </div>
        {portfolioInvested != null && (
          /* Patrimonio neto is the most important number on the screen — it used
             to sit at 12px at the very end, below the piggy-bank breakdown.
             Promoted to the second visual rank; "Invertido" stays as its input. */
          <div className="mt-4 pt-4 border-t border-slate-200/80 dark:border-slate-700/40 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
            <div>
              <p className="font-ledger text-[10px] uppercase tracking-[0.2em] text-slate-400">
                {t('expenses.net_worth_label')}
              </p>
              <p className="font-ledger text-xl font-bold tabular-nums tracking-tight text-blue-600 dark:text-blue-400 mt-0.5">
                {money(totalSavedBalance + portfolioInvested, 0)}
              </p>
            </div>
            <p className="text-xs text-slate-400 font-ledger tabular-nums pb-1">
              {t('expenses.invested_portfolio_label')}:{' '}
              <span className="font-bold text-slate-700 dark:text-slate-200">{money(portfolioInvested, 0)}</span>
            </p>
          </div>
        )}
      </div>
      </ErrorBoundary>

      </div>
      )}

      {/* Resumen del mes (tiles + insights) */}
      {wVis('month_tiles') && (
      <div style={{ order: wOrder('month_tiles') }} className={`flex flex-col gap-4 ${wSpan('month_tiles')}`}>
      <ErrorBoundary title={t('expenses.widget_month_tiles')}>
      {/* flex chain so the 2×2 tiles grow to the row height and their bottom
          border lines up with the hero card next to them. */}
      <div className="flex-1 flex flex-col">
        <p className="font-ledger text-[10px] uppercase tracking-[0.2em] text-slate-400 mb-2 px-1">
          {activeTab === 'monthly' ? `${monthNames[month - 1]} ${year}` : year}
        </p>
        <div className="flex-1 grid grid-cols-2 gap-3">
          <StatTile label={t('expenses.tile_net')} value={money(summary.net)} delta={deltas?.net} />
          <StatTile label={t('expenses.tile_income')} value={money(summary.income)} dot="bg-emerald-500" delta={deltas?.income} />
          <StatTile label={t('expenses.tile_expenses')} value={money(summary.expenses)} dot="bg-rose-500" delta={deltas?.expenses} />
          <StatTile label={t('expenses.tile_savings_rate')} value={savingsRateText} />
        </div>
      </div>

      {insights.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-slate-500 dark:text-slate-400">
          <Sparkles className="w-3.5 h-3.5 text-amber-500 shrink-0" />
          {insights.map((insight) => (
            <span key={insight.key}>
              {t(`expenses.insight_${insight.key}`, {
                category: insight.category ? categoryLabel(t, insight.category) : undefined,
                pct: insight.pct,
              })}
            </span>
          ))}
        </div>
      )}
      </ErrorBoundary>

      </div>
      )}

      {/* Presupuestos — se muestra siempre (mensual): la condición anterior lo
          hacía DESAPARECER, sin forma de editarlo, si todos los límites
          guardados eran 0 (computeBudgetStatus los filtra). */}
      {wVis('budgets') && activeTab === 'monthly' && (
        <div style={{ order: wOrder('budgets') }} className={wSpan('budgets')}>
          <ErrorBoundary title={t('expenses.widget_budgets')}>
            <BudgetsCard
              statuses={budgetStatuses}
              budgets={budgets}
              customCategories={customCategories.expense}
              onAddCategory={(name) => addCustomCategory('expense', name)}
              formatMoney={money}
              onSave={saveBudgets}
            />
          </ErrorBoundary>
        </div>
      )}

      {/* Reparto de gastos (donut) — incluye el botón "Flujo del dinero", SOLO
          en la pestaña mensual: el diagrama es de UN mes y en la anual `month`
          es el que quedó seleccionado, así que ofrecería el flujo de un mes que
          no se está mirando. */}
      {wVis('donut') && (
        <div style={{ order: wOrder('donut') }} className={wSpan('donut')}>
        <ErrorBoundary title={t('expenses.widget_donut')}>
          <ExpenseCategoryDonut
            rows={donutData.rows}
            total={donutData.total}
            displayRows={donutPresentation.rows}
            amountsHidden={donutPresentation.amountsHidden}
            entries={entries}
            from={donutFrom}
            to={donutTo}
            type={donutType}
            onTypeChange={setDonutType}
            onFromChange={setDonutFrom}
            onToChange={setDonutTo}
            formatMoney={money}
            formatPercent={percent}
            fxOpts={fxOpts}
            flowEntries={activeTab === 'monthly' ? entriesWithProjection : null}
            flowYear={year}
            flowMonth={month}
          />
        </ErrorBoundary>
        </div>
      )}

      {/* Metas de ahorro */}
      {wVis('goals') && (
      /* flex column: el CTA ocupa su alto y la card se queda el resto — con
         `h-full` a secas la card desbordaría la celda por el alto del CTA. */
      <div style={{ order: wOrder('goals') }} className={`flex flex-col ${wSpan('goals')}`}>
      <ErrorBoundary title={t('expenses.widget_goals')}>
      {/* CTA del ahorro sin asignar — vive PEGADO al objetivo anual porque es
          justo aquí donde se reparte ese dinero; suelto al final de la página
          quedaba desconectado de la acción que propone. */}
      {activeTab === 'monthly' && !isFutureMonth && summary.net > 0 && (
        <div className="shrink-0 mb-4 rounded-2xl border border-emerald-200/80 dark:border-emerald-800/40 bg-emerald-50/60 dark:bg-emerald-900/15 p-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-slate-700 dark:text-slate-200 flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-emerald-500 shrink-0" />
            {t('expenses.invest_cta', { value: money(summary.net, 0) })}
          </p>
          <Button
            variant="outline"
            onClick={() => navigate(`/app/rebalance?contribution=${Math.round(summary.net * 100) / 100}`)}
            className="h-8 text-xs bg-white dark:bg-slate-800"
          >
            {t('expenses.invest_cta_btn')}
          </Button>
        </div>
      )}
      <div className="flex-1 bg-white dark:bg-slate-800/80 rounded-2xl border border-slate-200/80 dark:border-slate-700/40 shadow-xs p-5">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Target className="w-4 h-4 text-blue-600" />
            {t('expenses.goal_title')} · {year}
          </p>
          <button
            onClick={() => { setGoalInput(savingsGoal ? String(savingsGoal) : ''); setGoalError(false); setIsGoalDialogOpen(true); }}
            className="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline"
          >
            {savingsGoal ? t('expenses.goal_edit') : t('expenses.goal_set')}
          </button>
        </div>
        {!savingsGoal ? (
          <p className="text-xs text-slate-400 mt-3">{t('expenses.goal_none_hint')}</p>
        ) : (() => {
          const achievedPct = Math.max(0, Math.min(100, (projection.actualNet / savingsGoal) * 100));
          const projectedPct = (projection.projectedNet / savingsGoal) * 100;
          const onTrack = projection.projectedNet >= savingsGoal;
          /* Rediseñado (2026-07-28): antes eran SEIS líneas de cifras a 11px,
             incluida una fórmula suelta ("= Real … · Ya anotado … · Recurrentes
             …") imposible de leer de un vistazo. Ahora: UNA frase con el estado,
             la barra, y el desglose escondido tras "¿Cómo se calcula?" —
             divulgación progresiva: lo básico visible, el detalle a un clic. */
          const breakdown = [
            projection.startingBalance !== 0 && { key: 'initial', label: t('expenses.goal_bd_initial_label'), value: projection.startingBalance },
            { key: 'real', label: t('expenses.goal_bd_real_label'), value: projection.realizedNet },
            projection.futureKnownNet !== 0 && { key: 'known', label: t('expenses.goal_bd_future_known_label'), value: projection.futureKnownNet },
            { key: 'recurring', label: t('expenses.goal_bd_recurring_label'), value: projection.futureRecurringNet },
            projection.nonRecurringEstimate !== 0 && {
              key: 'estimate',
              label: t('expenses.goal_bd_estimate_label', { months: projection.monthsRemaining }),
              value: projection.nonRecurringEstimate,
              hint: t('expenses.goal_bd_estimate_hint', { avg: signedMoney(projection.avgNonRecurringPerMonth) }),
            },
          ].filter(Boolean);

          return (
            <div className="mt-4 space-y-3">
              {/* Titular: cuánto llevas de cuánto, en una sola frase */}
              <p className="text-sm text-slate-700 dark:text-slate-200">
                {t('expenses.goal_headline_pre')}{' '}
                <span className={`font-ledger font-bold tabular-nums ${projection.actualNet >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'}`}>
                  {money(projection.actualNet, 0)}
                </span>{' '}
                {t('expenses.goal_headline_of')}{' '}
                <span className="font-ledger font-bold tabular-nums text-slate-900 dark:text-white">{money(savingsGoal, 0)}</span>
                <span className="text-slate-400"> · {percent((projection.actualNet / savingsGoal) * 100)}</span>
              </p>

              <div className="relative h-3 rounded-full bg-slate-100 dark:bg-slate-700/60 overflow-hidden">
                {projection.monthsRemaining > 0 && (
                  <div
                    className="absolute inset-y-0 left-0 rounded-full bg-blue-200 dark:bg-blue-500/25 transition-all"
                    style={{ width: `${Math.max(0, Math.min(100, projectedPct))}%` }}
                  />
                )}
                <div
                  className={`absolute inset-y-0 left-0 rounded-full transition-all ${projection.actualNet >= 0 ? 'bg-emerald-500' : 'bg-rose-400'}`}
                  style={{ width: `${achievedPct}%` }}
                />
              </div>

              {/* Pronóstico: una frase en lenguaje natural, no una fórmula */}
              {projection.monthsRemaining > 0 && (
                <div className={`rounded-xl border p-3 ${onTrack
                  ? 'border-emerald-200/70 dark:border-emerald-800/40 bg-emerald-50/50 dark:bg-emerald-900/10'
                  : 'border-amber-200/70 dark:border-amber-800/40 bg-amber-50/50 dark:bg-amber-900/10'}`}
                >
                  <p className="text-sm text-slate-700 dark:text-slate-200">
                    {onTrack ? '✅ ' : '⚠️ '}
                    {t('expenses.goal_forecast_sentence', { value: money(projection.projectedNet, 0) })}{' '}
                    <span className={`font-semibold ${onTrack ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                      {onTrack ? t('expenses.goal_on_track') : t('expenses.goal_off_track')}
                    </span>
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowGoalBreakdown((s) => !s)}
                    className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:underline"
                    aria-expanded={showGoalBreakdown}
                  >
                    {t('expenses.goal_how_calculated')}
                    <ChevronDown className={`w-3 h-3 transition-transform ${showGoalBreakdown ? 'rotate-180' : ''}`} />
                  </button>

                  {showGoalBreakdown && (
                    <ul className="mt-2.5 pt-2.5 border-t border-slate-200/70 dark:border-slate-700/50 space-y-1.5">
                      {breakdown.map((row) => (
                        <li key={row.key} className="flex items-baseline justify-between gap-3 text-[11px]">
                          <span className="text-slate-500 dark:text-slate-400">
                            {row.label}
                            {row.hint && <span className="text-slate-400"> · {row.hint}</span>}
                          </span>
                          <span className={`font-ledger tabular-nums font-bold shrink-0 ${row.value >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                            {signedMoney(row.value)}
                          </span>
                        </li>
                      ))}
                      <li className="flex items-baseline justify-between gap-3 text-[11px] pt-1.5 border-t border-slate-200/70 dark:border-slate-700/50">
                        <span className="font-semibold text-slate-600 dark:text-slate-300">{t('expenses.goal_bd_total_label')}</span>
                        <span className="font-ledger tabular-nums font-bold text-slate-900 dark:text-white shrink-0">
                          {money(projection.projectedNet, 0)}
                        </span>
                      </li>
                    </ul>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        <div className="my-5 border-t border-slate-200/80 dark:border-slate-700/40" />

        <SavingsGoalsCard
          goals={goalsWithProgress}
          balanceSeries={balanceSeries}
          availableToAllocate={availableToAllocate}
          formatMoney={money}
          formatPercent={percent}
          onAdd={() => { setEditingGoal(null); setIsGoalFormOpen(true); }}
          onEdit={(goal) => { setEditingGoal(goal); setIsGoalFormOpen(true); }}
          onDelete={(goal) => setDeleteGoalTarget(goal)}
          onAllocate={setAllocation}
          onToggleComplete={(goal, completed) => setGoalCompleted(goal.id, completed)}
        />
      </div>
      </ErrorBoundary>
      </div>
      )}

      {/* Viajes y proyectos: cuánto nos hemos dejado en cada uno, y en qué */}
      {wVis('projects') && (
      <div style={{ order: wOrder('projects') }} className={wSpan('projects')}>
      <ErrorBoundary title={t('expenses.widget_projects')}>
        <ExpenseProjectsCard
          projects={projects}
          entries={entries}
          goalsById={goalsById}
          fxOpts={fxOpts}
          formatMoney={money}
          formatPercent={percentMasked}
          onAdd={() => { setEditingProject(null); setIsProjectFormOpen(true); }}
          onEdit={(project) => { setEditingProject(project); setIsProjectFormOpen(true); }}
          onDelete={(project) => setDeleteProjectTarget(project)}
        />
      </ErrorBoundary>
      </div>
      )}

      {/* Análisis (calendario / anual) */}
      {wVis('analysis') && (
      <div style={{ order: wOrder('analysis') }} className={wSpan('analysis')}>
      <ErrorBoundary title={t('expenses.widget_analysis')}>
      {activeTab === 'annual' && (
        <MonthlyBreakdownChart
          title={t('expenses.chart_net_by_month')}
          accent="blue"
          valueMode="signed"
          yAxisAbbreviate
          currencySymbol={sym}
          data={annualSeries}
          total={summary.net}
          projectedLabel={t('expenses.projected_badge')}
          footer={[
            { label: t('expenses.tile_income'), value: money(summary.income, 0), tone: 'emerald' },
            { label: t('expenses.tile_expenses'), value: money(summary.expenses, 0), tone: 'rose' },
            ...(annualProjectedTotal !== 0 ? [{
              label: t('expenses.projected_badge'),
              value: money(annualProjectedTotal, 0),
              tone: 'neutral',
            }] : []),
          ]}
        />
      )}

      {activeTab === 'monthly' && (
        <ExpenseCalendar
          year={year}
          month={month}
          dailyTotals={dailyTotals}
          formatMoney={money}
          onDayClick={handleCalendarDayClick}
          selectedDay={selectedDay}
        />
      )}
      </ErrorBoundary>
      </div>
      )}

      {/* Movimientos y recurrentes */}
      {wVis('movements') && (
      <div style={{ order: wOrder('movements') }} className={wSpan('movements')}>
      <ErrorBoundary title={t('expenses.widget_movements')}>
      <div className="flex flex-col gap-4 lg:gap-6">
      <div className="order-2 bg-white dark:bg-slate-800/80 rounded-2xl border border-slate-200/80 dark:border-slate-700/40 shadow-xs overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-700/50 flex items-center justify-between gap-3">
          <p className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
            {t('expenses.list_title')}
            {/* Revalidation after a CRUD: a discreet spinner instead of blanking
                the whole list, which flashed on every edit. */}
            {refreshing && <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600" aria-label={t('common.loading')} />}
          </p>
          {selectedDay !== null && (
            <button
              onClick={() => setSelectedDay(null)}
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 rounded-full px-2.5 py-1 hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors"
            >
              {t('expenses.day_filter_chip', { day: selectedDay })}
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
        {loading ? (
          <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-blue-600" /></div>
        ) : (
          <ExpenseList
            rows={listRows}
            formatMoney={money}
            fxOpts={fxOpts}
            onEdit={(row) => { setEditingEntry(row); setIsEntryDialogOpen(true); }}
            onDelete={handleRowDelete}
            emptyTitle={t('expenses.empty')}
            emptyHint={t('expenses.empty_hint')}
          />
        )}
      </div>

      <div className="order-1 bg-white dark:bg-slate-800/80 rounded-2xl border border-slate-200/80 dark:border-slate-700/40 shadow-xs overflow-hidden">
        <button
          onClick={() => setShowTemplates((s) => !s)}
          className="w-full flex items-center justify-between px-5 py-3 text-left"
        >
          <p className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Repeat className="w-4 h-4 text-blue-600" />
            {t('expenses.templates_title')}
            <span className="text-xs font-semibold text-slate-400">({templates.length})</span>
          </p>
          <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${showTemplates ? 'rotate-180' : ''}`} />
        </button>
        {showTemplates && (
          templates.length === 0 ? (
            <p className="text-xs text-slate-400 px-5 pb-4">{t('expenses.templates_empty')}</p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-700/40 border-t border-slate-100 dark:border-slate-700/50">
              {templates.map((tpl) => (
                <li key={tpl.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                      {categoryLabel(t, tpl.category)}{tpl.notes ? ` · ${tpl.notes}` : ''}
                    </p>
                    <p className="text-xs text-slate-400">
                      {t('expenses.template_day_label', { day: tpl.recurrence_day || Number(tpl.entry_date?.slice(8, 10)) || 1 })}
                      {tpl.recurrence_until ? ` · ${t('expenses.template_until_label', { date: tpl.recurrence_until })}` : ''}
                      {' · '}
                      {tpl.recurrence_active ? t('expenses.template_active') : t('expenses.template_inactive')}
                      {(monthKeyOf(tpl.entry_date) || '') > currentMonthKey && (
                        <span className="text-amber-600 dark:text-amber-400 font-semibold">
                          {' · '}{t('expenses.template_starts_label', { date: (tpl.entry_date || '').split('T')[0] })}
                        </span>
                      )}
                      {/* Campanita solo en los que TIENEN fin y aviso activo: es
                          la señal de que ese recurrente avisará antes de acabarse. */}
                      {tpl.recurrence_until && tpl.recurrence_active && alertsOn && (
                        <span className="inline-flex items-center gap-1 ml-1.5 text-blue-600 dark:text-blue-400" title={t('expenses.template_alert_tooltip')}>
                          <Bell className="w-3 h-3" />
                        </span>
                      )}
                    </p>
                  </div>
                  <span className={`text-sm font-ledger font-bold tabular-nums ${tpl.type === 'income' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                    {tpl.type === 'income' ? '+' : '-'}{money(tpl.amount)}
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={!!tpl.recurrence_active}
                    aria-label={t('expenses.template_toggle_aria', { name: categoryLabel(t, tpl.category) })}
                    onClick={() => setTemplateActive(tpl.id, !tpl.recurrence_active)}
                    className={`relative shrink-0 inline-flex h-5 w-9 items-center rounded-full transition-colors ${tpl.recurrence_active ? 'bg-blue-600' : 'bg-slate-200 dark:bg-slate-700'}`}
                  >
                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-xs transition-transform ${tpl.recurrence_active ? 'translate-x-[18px]' : 'translate-x-1'}`} />
                  </button>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => { setEditingEntry(tpl); setIsEntryDialogOpen(true); }}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                      aria-label={t('expenses.edit_entry')}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setDeleteTarget(tpl)}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                      aria-label={t('expenses.delete_confirm_title')}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )
        )}
      </div>
      </div>
      </ErrorBoundary>
      </div>
      )}

      </div>{/* /widget grid */}

      <button
        onClick={() => { setEditingEntry(null); setIsEntryDialogOpen(true); }}
        className="md:hidden fixed bottom-6 right-4 z-40 w-14 h-14 rounded-full bg-blue-600 hover:bg-blue-700 active:scale-95 text-white shadow-xl shadow-blue-600/30 flex items-center justify-center transition-all"
        aria-label={t('expenses.add_entry')}
      >
        <Plus className="w-6 h-6" />
      </button>

      <ExpenseEntryDialog
        open={isEntryDialogOpen}
        onOpenChange={(open) => {
          setIsEntryDialogOpen(open);
          if (!open) { setEditingEntry(null); setEntryDefaults({}); }
        }}
        initial={editingEntry}
        onSubmit={handleSubmitEntry}
        defaultDate={entryDefaults.date}
        defaultRecurring={entryDefaults.recurring}
        customCategories={customCategories}
        onAddCategory={addCustomCategory}
        projects={projects}
        alertPrefsRaw={alertPrefsRaw}
        onOpenAlertSettings={() => navigate('/app/settings')}
      />

      <ExpenseProjectDialog
        open={isProjectFormOpen}
        onOpenChange={(open) => { setIsProjectFormOpen(open); if (!open) setEditingProject(null); }}
        initial={editingProject}
        goals={goals}
        onSubmit={handleSubmitProject}
      />

      {/* Borrar un proyecto NO borra sus movimientos (FK ON DELETE SET NULL);
          el diálogo lo dice para que nadie tema perder su historial. */}
      <Dialog open={!!deleteProjectTarget} onOpenChange={(open) => { if (!open) setDeleteProjectTarget(null); }}>
        <DialogContent className="max-w-md dark:bg-slate-900 border-none">
          <DialogHeader>
            <DialogTitle className="dark:text-white">{t('expenses.projects_delete_confirm_title')}</DialogTitle>
            <DialogDescription>{t('expenses.projects_delete_confirm_desc', { name: deleteProjectTarget?.name || '' })}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleteProjectTarget(null)}>{t('expenses.cancel')}</Button>
            <Button variant="destructive" onClick={handleDeleteProject}>{t('common.delete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SavingsGoalDialog
        open={isGoalFormOpen}
        onOpenChange={(open) => { setIsGoalFormOpen(open); if (!open) setEditingGoal(null); }}
        initial={editingGoal}
        onSubmit={handleSubmitSavingsGoal}
      />

      <Dialog open={!!deleteGoalTarget} onOpenChange={(open) => { if (!open) setDeleteGoalTarget(null); }}>
        <DialogContent className="max-w-md dark:bg-slate-900 border-none">
          <DialogHeader>
            <DialogTitle className="dark:text-white">{t('expenses.goals_delete_confirm_title')}</DialogTitle>
            <DialogDescription>{t('expenses.goals_delete_confirm_desc', { name: deleteGoalTarget?.name || '' })}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleteGoalTarget(null)}>{t('expenses.cancel')}</Button>
            <Button variant="destructive" onClick={handleDeleteSavingsGoal}>{t('common.delete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isInitialDialogOpen} onOpenChange={setIsInitialDialogOpen}>
        <DialogContent className="max-w-sm dark:bg-slate-900 border-none">
          <DialogHeader>
            <DialogTitle className="dark:text-white">{t('expenses.initial_balance_title')}</DialogTitle>
            <DialogDescription>{t('expenses.initial_balance_hint')}</DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <label className="text-xs font-semibold uppercase text-slate-500 mb-2 block">
              {t('expenses.initial_balance_label')} ({sym})
            </label>
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0,00"
              className={`w-full px-3 py-2 font-ledger tabular-nums border rounded-md dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500 transition-all text-sm shadow-xs ${initialError ? 'border-rose-500 focus:ring-rose-500' : ''}`}
              value={initialInput}
              onChange={(e) => { setInitialError(false); setInitialInput(e.target.value); }}
            />
            {initialError && <p className="text-xs text-rose-500 mt-1">{t('expenses.form_amount_invalid')}</p>}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setIsInitialDialogOpen(false)}>{t('expenses.cancel')}</Button>
            <Button onClick={handleSaveInitialBalance}>{t('expenses.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isGoalDialogOpen} onOpenChange={setIsGoalDialogOpen}>
        <DialogContent className="max-w-sm dark:bg-slate-900 border-none">
          <DialogHeader>
            <DialogTitle className="dark:text-white">{t('expenses.goal_title')}</DialogTitle>
            <DialogDescription>{t('expenses.goal_none_hint')}</DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <label className="text-xs font-semibold uppercase text-slate-500 mb-2 block">
              {t('expenses.goal_input_label')} ({sym})
            </label>
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0,00"
              className={`w-full px-3 py-2 font-ledger tabular-nums border rounded-md dark:bg-slate-800 dark:border-slate-700 dark:text-white outline-hidden focus:ring-2 focus:ring-blue-500 transition-all text-sm shadow-xs ${goalError ? 'border-rose-500 focus:ring-rose-500' : ''}`}
              value={goalInput}
              onChange={(e) => { setGoalError(false); setGoalInput(e.target.value); }}
            />
            {goalError && <p className="text-xs text-rose-500 mt-1">{t('expenses.form_amount_invalid')}</p>}
          </div>
          <DialogFooter className="gap-2">
            {savingsGoal && (
              <Button variant="outline" onClick={() => saveGoal(null)}>{t('expenses.goal_remove')}</Button>
            )}
            <Button variant="outline" onClick={() => setIsGoalDialogOpen(false)}>{t('expenses.cancel')}</Button>
            <Button onClick={handleSaveGoal}>{t('expenses.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent className="max-w-md dark:bg-slate-900 border-none">
          <DialogHeader>
            <DialogTitle className="dark:text-white">{t('expenses.delete_confirm_title')}</DialogTitle>
            <DialogDescription>
              {deletingTemplate
                ? (templateOccurrenceCount > 0
                    ? t('expenses.delete_template_desc', { count: templateOccurrenceCount })
                    : t('expenses.delete_template_desc_empty'))
                : isRecurringOccurrence
                  ? t('expenses.delete_recurring_confirm_desc')
                  : t('expenses.delete_confirm_desc')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>{t('expenses.cancel')}</Button>
            {isRecurringOccurrence && (
              <Button variant="destructive" onClick={() => handleDelete({ deactivateTemplate: true })}>{t('expenses.deactivate_template')}</Button>
            )}
            {/* Borrarlo TODO es lo que la mayoría entiende por "quitar el
                recurrente", pero destruye movimientos reales: va como acción
                secundaria y con el recuento delante. */}
            {deletingTemplate && templateOccurrenceCount > 0 && (
              <Button variant="destructive" onClick={() => handleDelete({ withOccurrences: true })}>
                {t('expenses.delete_template_with_occurrences', { count: templateOccurrenceCount })}
              </Button>
            )}
            <Button variant="destructive" onClick={() => handleDelete()}>
              {deletingTemplate
                ? t('expenses.delete_template_only')
                : isRecurringOccurrence
                  ? t('expenses.delete_only')
                  : t('expenses.delete_confirm_title')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ExpensesPage;
