import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { motion, Reorder, AnimatePresence } from 'framer-motion';
import { Helmet } from 'react-helmet';
import { Plus, Edit, Trash2, Search, Loader2, RefreshCw, DollarSign, Settings2, GripVertical, Coins } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/customSupabaseClient';
import { useSupabaseAuth } from '@/contexts/SupabaseAuthContext';
import { useToast } from '@/components/ui/use-toast';
import { yahooFinanceService } from '@/services/yahooFinance';
import { localTodayIso } from '@/lib/dates';
import { useImportPricing } from '@/hooks/useImportPricing';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { eodhdService } from '@/services/eodhd';
import { useTickerSearch } from '@/hooks/useTickerSearch';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter
} from '@/components/ui/dialog';
import { currencyService } from '@/services/currencyService';
import { parseDegiroCSV, auditDegiroLedger, listUnrecognizedDegiroRows } from '../lib/parsers/degiroParser';
import { buildExistingTransMap, csvRowsNotInDb, DEDUPE_SELECT_FIELDS } from '../lib/importDedupe';
import { logImportEvent, describeImportError, headerLineOf } from '../lib/importTelemetry';
import { redactCsvSample } from '../lib/csvRedact';
import { loadSharedTickerMappings } from '../services/tickerMappingService';
import { getAssetIdentifiers as resolveAssetIdentity } from '../services/import/assetIdentity';
import { calculateNetBuys as computeNetBuys } from '../services/import/netHoldings';
import { computeImportPlan } from '../services/import/importPlanner';
import { computeProcessedImportData } from '../services/import/processedImportData';
import { applyImportPlan } from '../services/import/importExecutor';
import { createAssets } from '@/services/assetCreateService';
import { noteTxCurrency } from '../services/portfolioHistory';
import { firstInvestedDate, annualizeReturn, windowYears, cagrWorkedExample } from '../services/performanceService';
import { parseIBKRCSV } from '../lib/parsers/ibkrParser';
import { parseMyInvestorCSV, auditMyInvestorLedger } from '../lib/parsers/myinvestorParser';
import { extractXlsxRows, rowsToCsv } from '../lib/xlsxReader';
import { enrichFundRows } from '../services/import/fundNavEnricher';
import { parseBinanceCSV } from '../lib/parsers/binanceCsvParser';
import { resolveTicker, getIsinByTicker } from '@/lib/tickerMap';
import RealizedPnLTable from '@/components/analytics/RealizedPnLTable';
import TaxReportDialog from '@/components/cartera/TaxReportDialog';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { FIFOCalculator } from '@/services/fifoAnalytics';
import { usePortfolioPerformance } from '@/hooks/usePortfolioPerformance';
import { computePortfolioStats } from '@/services/portfolioStats';
import { computePositionRowMetrics } from '@/services/positionRowMetrics';
import { usePositions } from '@/hooks/usePositions';
import { useBrokers } from '@/hooks/useBrokers';
import { useManualEntries } from '@/hooks/useManualEntries';
import { useImportFlow } from '@/hooks/useImportFlow';
import { getCurrencySymbol, formatNumber as formatPlainNumber } from '@/lib/formatters';
import { usePrivateFormatters } from '@/hooks/usePrivateFormatters';
import { resolveQuoteSymbol } from '@/services/quoteSymbol';
import { isCashPosition } from '@/lib/positionKind';
import PortfolioStatsCards from '@/components/cartera/PortfolioStatsCards';
import MetricExplainerDialog from '@/components/cartera/MetricExplainerDialog';
import MonthlyBreakdownChart from '@/components/cartera/MonthlyBreakdownChart';
import BrokerDialogs from '@/components/cartera/BrokerDialogs';
import DeletePositionDialog from '@/components/cartera/DeletePositionDialog';
import PositionActionBar from '@/components/cartera/PositionActionBar';
import HistoryPeriodFilterBar from '@/components/cartera/HistoryPeriodFilterBar';
import BrokerTabBar from '@/components/cartera/BrokerTabBar';
import AddEditPositionDialog from '@/components/cartera/AddEditPositionDialog';
import PositionsMobileList from '@/components/cartera/PositionsMobileList';
import PositionsDesktopTable from '@/components/cartera/PositionsDesktopTable';
import ImportBrokerSelector from '@/components/cartera/ImportBrokerSelector';
import ImportMethodChooser from '@/components/cartera/ImportMethodChooser';
import ImportUploadStep from '@/components/cartera/ImportUploadStep';
import ImportPreviewStep from '@/components/cartera/ImportPreviewStep';
import TransactionListCard from '@/components/cartera/TransactionListCard';

import {
  FileText,
  Download,
  CheckCircle2,
  ClipboardList,
  ArrowUpRight,
  ArrowDownRight,
  History as HistoryIcon,
  TrendingUp,
  TrendingDown,
  ChevronRight,
  ChevronDown,
  ArrowLeft,
  ArrowRight,
  HelpCircle,
  Calendar,
  Filter,
  X,
  AlertTriangle,
} from 'lucide-react';
import GlobalSearchOverlay from '@/components/GlobalSearchOverlay';
import { usePrivacyMode } from '@/contexts/PrivacyModeContext';
import TransactionModals from '@/components/TransactionModals';
import { useImportValidator } from '@/hooks/useImportValidator';
import { useAiUsage } from '@/hooks/useAiUsage';
import ImportLoadingOverlay from '@/components/ImportLoadingOverlay';
import FreeformImportDialog from '@/components/FreeformImportDialog';
import BrokerEmptyState from '@/components/cartera/BrokerEmptyState';
import { DEFAULT_CURRENCY, preferredCurrencyOf } from '@/lib/preferredCurrency';


const FIAT_CURRENCIES = ['EUR', 'USD', 'GBP'];

const ALL_CURRENCIES = [
  { code: 'USD', name: 'US Dollar' }, { code: 'EUR', name: 'Euro' }, { code: 'GBP', name: 'British Pound' },
  { code: 'JPY', name: 'Japanese Yen' }, { code: 'CNY', name: 'Chinese Yuan' }, { code: 'CHF', name: 'Swiss Franc' },
  { code: 'CAD', name: 'Canadian Dollar' }, { code: 'AUD', name: 'Australian Dollar' }, { code: 'BRL', name: 'Brazilian Real' },
  { code: 'MXN', name: 'Mexican Peso' }, { code: 'ARS', name: 'Argentine Peso' }, { code: 'NZD', name: 'New Zealand Dollar' },
  { code: 'HKD', name: 'Hong Kong Dollar' }, { code: 'SGD', name: 'Singapore Dollar' }, { code: 'INR', name: 'Indian Rupee' },
  { code: 'RUB', name: 'Russian Ruble' }, { code: 'KRW', name: 'South Korean Won' }, { code: 'ZAR', name: 'South African Rand' },
  { code: 'TRY', name: 'Turkish Lira' }
];

// Ticker mapping moved to src/lib/tickerMap.js
// formatNumber / getCurrencySymbol moved to src/lib/formatters.js

// Touch device (no hover/fine pointer): the broker-tab Reorder drag captures
// horizontal pans (framer sets touch-action) and blocks the tab strip scroll.
// Reorder-by-drag is a desktop affordance anyway (the grip icon is hidden < sm).
const IS_COARSE_POINTER = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)')?.matches === true;

const CarteraPage = () => {
  const { t, i18n } = useTranslation();
  // Enmascarados en modo privacidad (ver hooks/usePrivateFormatters).
  const { formatNumber, formatPercent, formatMoney } = usePrivateFormatters();
  const { user } = useSupabaseAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { privacyMode } = usePrivacyMode();
  const maskMoney = (str) => privacyMode ? '••••' : str;

  // Broker list via the shared React Query hook (single source, cached across pages).
  // CarteraPage layers its user-defined ordering (brokerOrder, persisted in localStorage)
  // on top of the fetched list with a useMemo — see `brokers` below.
  const { brokers: fetchedBrokers, brokersLoading, loadBrokers } = useBrokers(user?.id);
  const [selectedBrokerId, setSelectedBrokerId] = useState(() => {
    return localStorage.getItem('trazza_selected_broker') || 'general';
  });

  useEffect(() => {
    if (selectedBrokerId) {
      localStorage.setItem('trazza_selected_broker', selectedBrokerId);
    }
  }, [selectedBrokerId]);

  const [importPrices, setImportPrices] = useState({});

  // Refs for usePositions (must be defined before the hook call)
  const brokersRef = useRef([]);
  const preferredCurrencyRef = useRef(DEFAULT_CURRENCY);
  const importedTransactionsRef = useRef([]);
  const importPricesRef = useRef({});
  const dynamicTickerMapRef = useRef({});

  const {
    positions,
    setPositions,
    refreshing,
    exchangeRates,
    historyTotals,
    dbTransactions,
    loadPositions,
    refreshPrices,
  } = usePositions({
    user,
    brokersRef,
    preferredCurrencyRef,
    importedTransactionsRef,
    importPricesRef,
    setImportPrices,
    dynamicTickerMapRef,
  });

  const [loading, setLoading] = useState(true);
  const [initReady, setInitReady] = useState(false);
  const [isAddPositionOpen, setIsAddPositionOpen] = useState(false);
  const [explainingMetric, setExplainingMetric] = useState(null);

  const metricExplanations = {
    'Valor en Mercado': {
      title: t('cartera.metric_market_title'),
      formula: t('cartera.metric_market_formula'),
      description: t('cartera.metric_market_desc')
    },
    'Ganancia Total': {
      title: t('cartera.metric_gain_title'),
      formula: t('cartera.metric_gain_formula'),
      description: t('cartera.metric_gain_desc')
    },
    'TWR (Tiempo)': {
      title: t('cartera.metric_twr_title'),
      formula: t('cartera.metric_twr_formula'),
      description: t('cartera.metric_twr_desc')
    },
    'Rentabilidad Anualizada': {
      title: t('cartera.metric_cagr_title'),
      formula: t('cartera.metric_cagr_formula'),
      description: t('cartera.metric_cagr_desc')
    },
    'Latente (hoy)': {
      title: t('cartera.metric_latent_title'),
      formula: t('cartera.metric_latent_formula'),
      description: t('cartera.metric_latent_desc')
    },
    'Realizado (hist.)': {
      title: t('cartera.metric_realized_title'),
      formula: t('cartera.metric_realized_formula'),
      description: t('cartera.metric_realized_desc')
    },
    'Dividendos (hist.)': {
      title: t('cartera.metric_dividends_title'),
      formula: t('cartera.metric_dividends_formula'),
      description: t('cartera.metric_dividends_desc')
    },
    'Comisiones (hist.)': {
      title: t('cartera.metric_commissions_title'),
      formula: t('cartera.metric_commissions_formula'),
      description: t('cartera.metric_commissions_desc')
    },
    'ROI Cartera actual': {
      title: t('cartera.metric_roi_current_title'),
      formula: t('cartera.metric_roi_current_formula'),
      description: t('cartera.metric_roi_current_desc')
    }
  };

  const [editingBroker, setEditingBroker] = useState(null);
  const [editBrokerName, setEditBrokerName] = useState('');

  const { query: searchTerm, setQuery: setSearchTerm, results: searchResults,
          isSearching, selectedIndex: searchSelectedIndex, onKeyDown: searchKeyDown,
          clearResults: clearSearchResults,
        } = useTickerSearch({ debounce: 400, limit: 10 });
  const [newPosition, setNewPosition] = useState({
    ticker: '', name: '', type: 'Stock', quantity: 0, average_price: 0, currency: 'USD', target_percentage: 0, classification: 'Others', last_operation_date: localTodayIso()
  });
  const [currencySearch, setCurrencySearch] = useState('');
  const [isAddingPosition, setIsAddingPosition] = useState(false);
  const [preferredCurrency, setPreferredCurrency] = useState(DEFAULT_CURRENCY);
  const { preferences: userPreferences, loading: prefsLoading, savePreferences } = useUserPreferences();
  // (searchRef + click-outside dismissal live inside AddEditPositionDialog)

  // CSV Import State
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
  const [importBroker, setImportBroker] = useState('degiro');
  // Sub-phase of importStep 'upload': method chooser → broker search → file upload
  const [uploadPhase, setUploadPhase] = useState('method'); // 'method' | 'brokers' | 'file'
  // Re-sync repair: wipe the broker's imported positions+transactions before
  // saving, so a representation change in past imports can't leave duplicates
  const [replaceBrokerData, setReplaceBrokerData] = useState(false);
  const [isFreeformOpen, setIsFreeformOpen] = useState(false); // free-form AI import dialog
  const [importedTransactionsByBroker, setImportedTransactionsByBroker] = useState({});
  const [isUploading, setIsUploading] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const importFinishRef = useRef(null);
  const [isSavedByBroker, setIsSavedByBroker] = useState({});
  const [historicalPrices, setHistoricalPrices] = useState({});
  const [dynamicTickerMap, setDynamicTickerMap] = useState({});

  // CSV Import — preview step with AI validation
  const [isResync, setIsResync] = useState(false); // true when re-importing an already-saved broker
  const [importStep, setImportStep] = useState('upload'); // 'upload' | 'preview'
  const [pendingImportData, setPendingImportData] = useState(null);
  const [enableAIValidation, setEnableAIValidation] = useState(true);
  const [rawCsvText, setRawCsvText] = useState(null);   // stored when parser returns []
  const [parseHint, setParseHint] = useState(null);     // specific reason the parser failed (wrong file, no trades)
  const [csvReportSent, setCsvReportSent] = useState(false); // anonymized sample shared with support
  const [importAudit, setImportAudit] = useState(null);          // DeGiro ledger reconciliation result
  const [unrecognizedRows, setUnrecognizedRows] = useState([]);  // rows no keyword list matched (dropped)
  const lastCsvTextRef = useRef(null); // raw CSV of the last parse attempt (for the opt-in support report)
  const [ibkrParseWarnings, setIbkrParseWarnings] = useState([]);
  const [aiParsing, setAiParsing] = useState(false);    // AI fallback in progress
  const [aiParseError, setAiParseError] = useState(null);
  const { validate, issues: validationIssues, validating, validationWarning, clearIssues } = useImportValidator();
  const { dailyLeft: importAIDailyLeft, exhausted: importAIExhausted, refresh: refreshImportUsage } = useAiUsage('import');

  // Sync refs for usePositions — must appear before the initReady effect so the
  // broker/currency refs are populated when loadPositions first runs.
  // (brokersRef sync lives below, after the ordered `brokers` memo is declared.)
  useEffect(() => { preferredCurrencyRef.current = preferredCurrency; }, [preferredCurrency]);
  useEffect(() => { importPricesRef.current = importPrices; }, [importPrices]);
  useEffect(() => { dynamicTickerMapRef.current = dynamicTickerMap; }, [dynamicTickerMap]);

  // New UI states
  const [expandedAssetTicker, setExpandedAssetTicker] = useState(null);
  const [editingPositionId, setEditingPositionId] = useState(null);
  const [overlayTicker, setOverlayTicker] = useState(null);
  const [brokerOrder, setBrokerOrder] = useState(() => {
    try {
      const saved = localStorage.getItem('trazza_broker_order');
      return saved ? JSON.parse(saved) : null;
    } catch (e) { return null; }
  });

  useEffect(() => {
    if (brokerOrder && Array.isArray(brokerOrder)) {
      try {
        localStorage.setItem('trazza_broker_order', JSON.stringify(brokerOrder));
      } catch (e) { console.error("Error saving broker order:", e); }
    }
  }, [brokerOrder]);

  // User-ordered broker list derived from the shared hook's data + brokerOrder.
  const brokers = React.useMemo(() => {
    if (!Array.isArray(brokerOrder)) return fetchedBrokers;
    return [...fetchedBrokers].sort((a, b) => {
      const idxA = brokerOrder.indexOf(a.id);
      const idxB = brokerOrder.indexOf(b.id);
      if (idxA === -1 && idxB === -1) return 0;
      if (idxA === -1) return 1;
      if (idxB === -1) return -1;
      return idxA - idxB;
    });
  }, [fetchedBrokers, brokerOrder]);

  // Keep brokersRef (consumed by usePositions async closures) in sync with the
  // ordered list. Declared after the `brokers` memo to avoid a TDZ reference.
  useEffect(() => { brokersRef.current = brokers; }, [brokers]);

  // Post-fetch side-effects (previously inside the local loadBrokers):
  // create a default broker for new accounts, keep brokerOrder in sync with new
  // brokers, and reset the selection when it points to a deleted broker.
  const creatingDefaultBrokerRef = useRef(false);
  useEffect(() => {
    if (!user?.id || brokersLoading) return;

    if (fetchedBrokers.length === 0) {
      if (creatingDefaultBrokerRef.current) return;
      creatingDefaultBrokerRef.current = true;
      (async () => {
        const { data: b } = await supabase.from('brokers').insert({ user_id: user.id, name: t('cartera.default_broker_name') }).select().single();
        if (b) {
          setSelectedBrokerId(b.id);
          setBrokerOrder([b.id]);
          await loadBrokers();
        }
        creatingDefaultBrokerRef.current = false;
      })();
      return;
    }

    const currentIds = fetchedBrokers.map(b => b.id);
    if (!Array.isArray(brokerOrder) || currentIds.some(id => !brokerOrder.includes(id))) {
      setBrokerOrder(prev => {
        const kept = Array.isArray(prev) ? prev.filter(id => currentIds.includes(id)) : [];
        return [...kept, ...currentIds.filter(id => !kept.includes(id))];
      });
    }

    const isValid = selectedBrokerId === 'general' || fetchedBrokers.some(b => b.id === selectedBrokerId);
    if (!isValid) setSelectedBrokerId(fetchedBrokers[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchedBrokers, brokersLoading, user?.id]);

  const [assetTransactions, setAssetTransactions] = useState({});
  const [assetHistoricalCost, setAssetHistoricalCost] = useState({});

  // Pagination for Import Preview Tables
  const [visibleSales, setVisibleSales] = useState(10);
  const [visibleDividends, setVisibleDividends] = useState(10);
  const [visibleCommissions, setVisibleCommissions] = useState(10);
  const [visibleCash, setVisibleCash] = useState(10);

  // History filter + search
  const [histRange, setHistRange] = useState('ALL');
  const [histRangeFrom, setHistRangeFrom] = useState('');
  const [histRangeTo, setHistRangeTo] = useState('');
  const [searchSales, setSearchSales] = useState('');
  const [searchDividends, setSearchDividends] = useState('');
  const [searchCommissions, setSearchCommissions] = useState('');
  const [searchCash, setSearchCash] = useState('');

  const [isDeleteBrokerConfirmOpen, setIsDeleteBrokerConfirmOpen] = useState(false);

  // Re-fetch every per-asset transaction list that's currently loaded so inline
  // edits/additions/deletes appear immediately. The expandable "Historial de
  // Transacciones" reads `assetTransactions`, which `loadPositions` does NOT
  // refresh on its own — without this, edited price/quantity stayed stale until F5.
  const refreshLoadedTransactions = async () => {
    const keys = Object.keys(assetTransactions);
    if (keys.length === 0) return;
    await Promise.all(keys.map((key) => {
      const pos = positions.find(p => String(p.asset_id) === String(key));
      if (!pos) return null;
      return loadTransactionsForAsset(
        pos.all_asset_ids || pos.asset_id,
        pos.assets?.isin,
        pos.assets?.ticker,
        pos.assets?.currency,
        pos.asset_id,
      );
    }));
  };

  const [isTaxReportOpen, setIsTaxReportOpen] = useState(false);
  // Action awaiting a broker choice (general view only) — see requestBrokerAction
  const [pendingBrokerAction, setPendingBrokerAction] = useState(null);

  // Manual-entry CRUD (venta/dividendo/comisión/cash + borrados con restauración
  // de liquidez) — extraído a hooks/useManualEntries (fase 2 del split). Mantiene
  // los nombres originales, por eso el resto del fichero no cambia. Se invoca
  // aquí (no arriba) porque depende de refreshLoadedTransactions.
  const {
    isAddSaleOpen, setIsAddSaleOpen,
    isAddDividendOpen, setIsAddDividendOpen,
    isAddCommissionOpen, setIsAddCommissionOpen,
    isAddCashOpen, setIsAddCashOpen,
    manualEntryLoading,
    defaultManualCash,
    manualSale, setManualSale,
    manualDividend, setManualDividend,
    manualCommission, setManualCommission,
    manualCash, setManualCash,
    isDeleteConfirmOpen, setIsDeleteConfirmOpen,
    positionToDelete, setPositionToDelete,
    availablePositions,
    cashPositionId,
    handleSaveManualSale,
    handleSaveManualDividend,
    handleSaveManualCommission,
    handleSaveManualCash,
    handleDeleteTransaction,
    confirmDeleteTransaction,
    confirmDeletePosition,
  } = useManualEntries({ user, selectedBrokerId, preferredCurrency, positions, loadPositions, refreshLoadedTransactions });
  // noteTxCurrency (transaction currency from stored notes) is imported from
  // services/portfolioHistory — single implementation shared with the planner.

  const loadTransactionsForAsset = async (assetId, positionIsin = null, ticker = null, nativeCurrency = null, storeKey = null) => {
    const ids = Array.isArray(assetId) ? assetId : [assetId];

    // Two-step query: positions.asset_id filter via dot-notation is unreliable in Supabase JS v2.
    // Step 1: resolve asset_id(s) → position_id(s)
    const { data: posRows } = await supabase.from('positions')
      .select('id')
      .in('asset_id', ids);
    const positionIds = (posRows || []).map(p => p.id);

    let dbData = [];
    if (positionIds.length > 0) {
      const { data } = await supabase.from('transactions')
        .select('*')
        .in('position_id', positionIds)
        .order('transaction_date', { ascending: false });
      dbData = data || [];
    }

    let result = dbData;

    if (currentImportedTransactions.length > 0) {
      const resolvedTarget = (positionIsin && dynamicTickerMapRef.current[positionIsin]) || dynamicTickerMapRef.current[ticker] || resolveTicker(ticker);

      // Build key set from DB rows so we can skip CSV transactions already saved to DB.
      // Key: DD-MM-YYYY_TYPE_QTY (matches the CSV transaction shape).
      const dbKeySet = new Set(dbData.map(t => {
        const dateStr = (t.transaction_date || '').split('T')[0]; // YYYY-MM-DD
        const [y = '1970', m = '01', d = '01'] = dateStr ? dateStr.split('-') : [];
        return `${d}-${m}-${y}_${t.transaction_type}_${Math.abs(parseFloat(t.quantity || 0)).toFixed(4)}`;
      }));

      const matchingCsv = currentImportedTransactions
        .filter(t => {
          const csvKey = `${t.fecha}_${t.type}_${Math.abs(parseFloat(t.cantidad || 0)).toFixed(4)}`;
          if (dbKeySet.has(csvKey)) return false; // already in DB
          if (positionIsin && (t.isin === positionIsin || t.id_activo === positionIsin)) return true;
          if (ticker || resolvedTarget) {
            const rawId = t.producto || t.id_activo || t.isin;
            const mappedTicker = (t.isin && dynamicTickerMapRef.current[t.isin]) || dynamicTickerMapRef.current[rawId] || resolveTicker(rawId);
            return mappedTicker === resolvedTarget || mappedTicker === ticker || t.ticker === ticker || rawId === ticker;
          }
          return false;
        })
        .map(t => {
          const [d = '01', m = '01', y = '1970'] = (t.fecha || '01-01-1970').split('-');
          return {
            id: `imp_${t.fecha}_${t.type}_${Math.random().toString(36).slice(2)}`,
            transaction_date: `${y}-${m}-${d}T${t.hora || '00:00:00'}`,
            transaction_type: t.type || t.transaction_type,
            quantity: t.cantidad,
            price: t.precio,
            total_amount: Math.abs(t.total || t.total_amount || 0),
            notes: t.descripcion || t.notes || null,
          };
        });

      if (matchingCsv.length > 0) {
        result = [...dbData, ...matchingCsv]
          .sort((a, b) => new Date(b.transaction_date) - new Date(a.transaction_date));
      }
    }

    // storeKey lets the caller dictate the lookup key (e.g. pos.asset_id for general-view merged
    // positions). Falls back to the first id in the array so old call sites keep working.
    const key = storeKey || (Array.isArray(assetId) ? assetId[0] : assetId);
    setAssetTransactions(prev => ({ ...prev, [key]: result }));

    // Compute historical preferred-currency cost for the G/P FX panel.
    if (nativeCurrency && nativeCurrency !== preferredCurrency && result.length > 0) {
      // Only exclude BUY transactions whose notes contain a DIFFERENT ISIN (positive evidence of
      // wrong linkage). Classification-format notes ("Compra Internacional (USD)") lack an ISIN
      // entirely — they are NOT excluded.
      const buyTxns = result.filter(t => {
        if (t.transaction_type !== 'BUY') return false;
        if (positionIsin && t.notes) {
          const isinInNotes = t.notes.match(/\(([A-Z]{2}[A-Z0-9]{9}[0-9])\)/);
          if (isinInNotes && isinInNotes[1] !== positionIsin) return false;
        }
        return true;
      });

      if (buyTxns.length > 0) {
        const costEntries = await Promise.all(buyTxns.map(async t => {
          const qty = Math.abs(parseFloat(t.quantity || 0));
          const price = parseFloat(t.price || 0);

          if (t.eur_total != null && preferredCurrency === 'EUR') {
            return { qty, prefCost: Math.abs(t.eur_total) };
          }

          const txCurrency = noteTxCurrency(t.notes, nativeCurrency);

          if (txCurrency === preferredCurrency) {
            return { qty, prefCost: qty * price };
          }

          const dateStr = t.transaction_date?.split('T')[0];
          const histRate = dateStr
            ? await currencyService.getHistoricalRate(txCurrency, preferredCurrency, dateStr)
            : null;
          if (!histRate) return null;
          return { qty, prefCost: qty * price * histRate };
        }));

        const validCostEntries = costEntries.filter(Boolean);
        const totalHistCost = validCostEntries.reduce((s, e) => s + e.prefCost, 0);
        const totalBoughtQty = validCostEntries.reduce((s, e) => s + e.qty, 0);
        if (totalHistCost > 0 && totalBoughtQty > 0) {
          setAssetHistoricalCost(prev => ({ ...prev, [key]: { totalHistCost, totalBoughtQty } }));
        }
      }
    }
  };

  // Historical per-asset costs come pre-attached as pos._histCost from the shared
  // pipeline in usePositions (computed from the transactions already fetched there).
  // This replaced the old preload effect that fired one loadTransactionsForAsset query
  // per non-EUR position on every positions change (N+1). loadTransactionsForAsset is
  // still used on row expand to show the transaction list (incl. unsaved CSV merge).
  //
  // Safety net: lazily resolve the historical cost for any non-preferred-currency row
  // the pipeline could NOT resolve (e.g. a historical FX rate unavailable at compute
  // time, or a transaction the pipeline filtered out). Normally zero rows — when it
  // fires, the console.warn identifies exactly which asset needs investigating.
  useEffect(() => {
    if (!positions?.length || !initReady) return;
    positions.forEach(pos => {
      const cur = pos.assets?.currency || 'EUR';
      if (cur === preferredCurrency) return;
      // La liquidez no tiene coste histórico: sin este corte, CASH_USD disparaba
      // el aviso y una consulta de transacciones en cada carga.
      if (isCashPosition(pos)) return;
      if (pos._prefCostTotal || pos._histCost || assetHistoricalCost[pos.asset_id]) return;
      console.warn(`[fx-fallback] pipeline missed historical cost for ${pos.assets?.ticker} (${cur}) — lazy loading`);
      loadTransactionsForAsset(
        pos.all_asset_ids || pos.asset_id,
        pos.assets?.isin,
        pos.assets?.ticker,
        cur,
        pos.asset_id
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, preferredCurrency, initReady, assetHistoricalCost]);

  const ASSET_CLASSES = ["Pilars", "Micro/Small/Mid Caps", "Large Caps", "Others", "ETFs/Funds", "Bonds", "Cash", "Crypto"];

  // Persist imported data to Supabase
  useEffect(() => {
    if (!user?.id || !selectedBrokerId || selectedBrokerId === 'general') return;
    
    const saveData = async () => {
      const transactions = importedTransactionsByBroker[selectedBrokerId] || [];
      const prices = importPrices;
      const tickerMap = dynamicTickerMap;

      if (transactions.length === 0) return;

      await supabase.from('imported_data').upsert({
        user_id: user.id,
        broker_id: selectedBrokerId,
        transactions,
        prices,
        ticker_map: tickerMap,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id, broker_id' });
    };

    const timer = setTimeout(saveData, 2000); // Debounce save
    return () => clearTimeout(timer);
  }, [importedTransactionsByBroker, importPrices, dynamicTickerMap, user?.id, selectedBrokerId]);

  // Espera a la fila de preferencias compartida: de ahí sale la divisa.
  useEffect(() => {
    if (user?.id && !prefsLoading) initializePage();
  }, [user?.id, prefsLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Gate data loading behind initReady to prevent loadPositions from running
  // with stale preferredCurrency (default 'USD') before loadUserPreferences completes.
  // Broker cuyas posiciones ya se han cargado: hasta entonces no se sabe si
  // está vacío, y sin esto quien tiene cartera veía un instante el estado vacío.
  const [positionsLoadedFor, setPositionsLoadedFor] = useState(null);
  useEffect(() => {
    if (initReady && selectedBrokerId) {
      if (selectedBrokerId === 'general' && brokers.length === 0) return;
      Promise.resolve(loadPositions(selectedBrokerId, true))
        .finally(() => setPositionsLoadedFor(selectedBrokerId));
    }
  }, [initReady, selectedBrokerId, brokers]);

  // Fetch portfolio beta via getProfile() (v10/quoteSummary crumb proxy — only Yahoo endpoint
  // with beta). Betas are persisted in localStorage (24h TTL) so a reload never re-fetches
  // tickers that already have a valid beta. Only missing/expired tickers hit the network.
  // Trigger AI validation when the import preview step becomes active.
  // Running it here (not in the onChange handler) avoids the race condition where
  // validate() finishes before React has rendered the preview panel.
  useEffect(() => {
    if (importStep === 'preview' && pendingImportData && enableAIValidation) {
      validate({ broker: importBroker, parsedRows: pendingImportData });
    }
  }, [importStep]); // eslint-disable-line react-hooks/exhaustive-deps -- only trigger on step change, NOT on inline corrections


  const savedBrokerIds = React.useMemo(() => {
    const ids = new Set();
    (dbTransactions || []).forEach(t => {
      if (t.positions?.broker_id) ids.add(t.positions.broker_id);
    });
    return ids;
  }, [dbTransactions]);

  const currentImportedTransactions = React.useMemo(() => {
    if (selectedBrokerId === 'general') {
      return Object.entries(importedTransactionsByBroker)
        .filter(([bId]) => !savedBrokerIds.has(bId) && !isSavedByBroker[bId])
        .flatMap(([bId, txs]) => 
          txs.map(t => ({ ...t, broker_id: bId }))
        );
    }
    return (importedTransactionsByBroker[selectedBrokerId] || []).map(t => ({ ...t, broker_id: selectedBrokerId }));
  }, [selectedBrokerId, importedTransactionsByBroker, savedBrokerIds, isSavedByBroker]);

  useEffect(() => { importedTransactionsRef.current = currentImportedTransactions; }, [currentImportedTransactions]);

  const currentIsSaved = React.useMemo(() => {
    if (selectedBrokerId === 'general') return false;
    return isSavedByBroker[selectedBrokerId] || false;
  }, [selectedBrokerId, isSavedByBroker]);

  // Serie de rendimiento (TWR/TTWROR/ROI): la calcula el hook COMPARTIDO con el
  // Dashboard. Antes esta pantalla llamaba a `performanceService.calculateDailyTWR`
  // por su cuenta con otros argumentos (sin `roiTransactions`, rango 10y frente a
  // 5y, sin la caché de localStorage), así que el MISMO indicador daba números
  // distintos según la pantalla: 54,69% aquí contra 54,80% en el Dashboard.
  // `refreshKey` fuerza el recálculo cuando cambian las transacciones sin cambiar
  // de broker (un import, un alta manual), que es lo que hacían las deps del
  // efecto anterior.
  const perfRefreshKey = `${dbTransactions?.length || 0}|${currentImportedTransactions.length}`;
  const { data: performanceGrowthData } = usePortfolioPerformance({
    userId: user?.id,
    brokerId: selectedBrokerId,
    currency: preferredCurrency,
    refreshKey: perfRefreshKey,
  });

  // TWR all-time: cumulative TTWROR (price + FX in preferred currency) from first
  // transaction to today. Feeds the TWR tile AND the annualized CAGR.
  const twrAllTime = performanceGrowthData.length > 0
    ? (performanceGrowthData[performanceGrowthData.length - 1].ttwror
        ?? performanceGrowthData[performanceGrowthData.length - 1].cumulativeReturn)
    : null;

  const initializePage = async () => {
    setLoading(true);
    await Promise.all([
      loadBrokers(),
      loadUserPreferences()
    ]);
    setLoading(false);
    setInitReady(true);
  };

  const handleCurrencyChange = async (newCurrency) => {
    setPreferredCurrency(newCurrency);
    const { error } = await savePreferences({ preferred_currency: newCurrency });
    if (error) toast({ variant: 'destructive', title: t('common.error_save'), description: error.message });
  };

  const loadUserPreferences = async () => {
    try {
      if (!user?.id) return;
      setPreferredCurrency(preferredCurrencyOf(userPreferences));

      // Load persistent imported data
      const { data: impData } = await supabase
        .from('imported_data')
        .select('*')
        .eq('user_id', user.id);

      if (impData) {
        const transByBroker = {};
        let combinedPrices = {};
        let combinedTickerMap = {};

        impData.forEach(row => {
          transByBroker[row.broker_id] = row.transactions;
          combinedPrices = { ...combinedPrices, ...row.prices };
          combinedTickerMap = { ...combinedTickerMap, ...row.ticker_map };
        });

        setImportedTransactionsByBroker(transByBroker);
        setImportPrices(combinedPrices);
        // Shared crowd-sourced ISIN→ticker mappings as base layer; the user's own
        // session mappings (imported_data.ticker_map) take precedence.
        const sharedMappings = await loadSharedTickerMappings().catch(() => ({}));
        setDynamicTickerMap({ ...sharedMappings, ...combinedTickerMap });

        // Pre-populate isSavedByBroker: any broker in imported_data that already
        // has positions in DB is considered "saved" regardless of which loadPositions
        // call last ran. Without this, switching to a specific broker after saving
        // another one sets dbTransactions to that broker only, making savedBrokerIds
        // incomplete and causing other brokers' CSV data to be double-counted.
        const importedBrokerIds = impData.map(r => r.broker_id);
        if (importedBrokerIds.length > 0) {
          const { data: posRows } = await supabase
            .from('positions')
            .select('broker_id')
            .in('broker_id', importedBrokerIds);
          if (posRows?.length > 0) {
            const alreadySaved = {};
            posRows.forEach(p => { alreadySaved[p.broker_id] = true; });
            setIsSavedByBroker(alreadySaved);
          }
        }
      }
    } catch (e) {
      console.error("Error loading preferences/imported data:", e);
    }
  };

  const handleUpdateBroker = async () => {
    if (!editBrokerName) return;
    await supabase.from('brokers').update({ name: editBrokerName }).eq('id', editingBroker.id).eq('user_id', user.id);
    setEditingBroker(null);
    loadBrokers();
  };

  const handleAddBroker = async () => {
    const { data } = await supabase.from('brokers').insert({ user_id: user.id, name: 'New Broker' }).select().single();
    if (data) {
      setSelectedBrokerId(data.id);
      setBrokerOrder(prev => [...(prev || []), data.id]);
      loadBrokers(); // refresh shared cache — derived list picks it up
    }
  };

  const handleDeleteBroker = () => {
    setIsDeleteBrokerConfirmOpen(true);
  };

  const confirmDeleteBroker = async () => {
    setIsDeleteBrokerConfirmOpen(false);
    const deletedId = editingBroker.id;
    await supabase.from('imported_data').delete().eq('user_id', user.id).eq('broker_id', deletedId);
    await supabase.from('brokers').delete().eq('id', deletedId).eq('user_id', user.id);
    setEditingBroker(null);
    setSelectedBrokerId(null);
    setImportedTransactionsByBroker(prev => { const next = { ...prev }; delete next[deletedId]; return next; });
    setIsSavedByBroker(prev => { const next = { ...prev }; delete next[deletedId]; return next; });
    loadBrokers();
  };

  const handleMoveBroker = (id, direction) => {
    const index = brokers.findIndex(b => b.id === id);
    if (index === -1) return;
    const newIndex = direction === 'left' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= brokers.length) return;

    const newBrokers = [...brokers];
    const [moved] = newBrokers.splice(index, 1);
    newBrokers.splice(newIndex, 0, moved);

    // `brokers` is derived from brokerOrder — updating the order re-sorts the list.
    setBrokerOrder(newBrokers.map(b => b.id));
  };

  // Precios de lo importado y re-resolución de fondos: hooks/useImportPricing.
  const { fetchPricesForImported, handleReresolveFunds, reresolvingFunds } = useImportPricing({
    user, positions, selectedBrokerId, refreshPrices,
    importPrices, setImportPrices, dynamicTickerMap, setDynamicTickerMap, dynamicTickerMapRef,
  });

  // Target editing lives on the Rebalancing screen now — the brokers allocation
  // column is read-only, so there's no inline target updater here anymore.

  // Manual entries and import/sync always apply to ONE broker. On a specific
  // broker we run them straight away; in the general view we first ask which
  // broker they should affect (see the broker picker dialog below).
  const runBrokerAction = (action) => {
    switch (action) {
      case 'dividend': setIsAddDividendOpen(true); break;
      case 'sale': setIsAddSaleOpen(true); break;
      case 'commission': setIsAddCommissionOpen(true); break;
      case 'cash':
        setManualCash({ ...defaultManualCash, currency: preferredCurrency });
        setIsAddCashOpen(true);
        break;
      case 'position': setIsAddPositionOpen(true); break;
      case 'sync': setIsResync(true); setIsImportDialogOpen(true); break;
      case 'import': setIsResync(false); setIsImportDialogOpen(true); break;
      default: break;
    }
  };

  const requestBrokerAction = (action) => {
    if (selectedBrokerId === 'general') setPendingBrokerAction(action);
    else runBrokerAction(action);
  };

  // Broker picked: switch the page to that broker so every dialog operates on it,
  // then run the action ('sync'/'import' resolves by whether it has saved data).
  // /app/brokers?start=import | ?start=position (la bienvenida y la tarjeta de
  // cuenta vacía del Dashboard) abre el importador o el alta manual nada más
  // llegar. Con un solo broker no se pregunta en cuál.
  const [searchParams, setSearchParams] = useSearchParams();
  const startAction = ['import', 'position'].includes(searchParams.get('start')) ? searchParams.get('start') : null;
  useEffect(() => {
    if (!startAction || !initReady || !selectedBrokerId) return;
    const real = brokers.filter(b => b.id !== 'general');
    if (real.length === 0) return; // se está creando el broker por defecto
    setSearchParams((prev) => { const next = new URLSearchParams(prev); next.delete('start'); return next; }, { replace: true });
    if (selectedBrokerId === 'general' && real.length === 1) {
      setSelectedBrokerId(real[0].id);
      runBrokerAction(startAction);
    } else {
      requestBrokerAction(startAction);
    }
  }, [startAction, initReady, selectedBrokerId, brokers]); // eslint-disable-line react-hooks/exhaustive-deps

  const confirmBrokerAction = (brokerId) => {
    const action = pendingBrokerAction;
    setPendingBrokerAction(null);
    setSelectedBrokerId(brokerId);
    const isSaved = savedBrokerIds.has(brokerId) || !!isSavedByBroker[brokerId];
    runBrokerAction(
      action === 'sync' || action === 'import' ? (isSaved ? 'sync' : 'import') : action
    );
  };

  // Row expand: one place composes the state toggle + the transactions fetch
  // for both the mobile list and the desktop table.
  const handleToggleExpandPosition = (pos) => {
    if (expandedAssetTicker === pos.assets?.ticker) {
      setExpandedAssetTicker(null);
    } else {
      setExpandedAssetTicker(pos.assets?.ticker);
      loadTransactionsForAsset(pos.all_asset_ids || pos.asset_id, pos.assets?.isin, pos.assets?.ticker, pos.assets?.currency, pos.asset_id);
    }
  };

  // Open the edit dialog pre-filled; fetches the most recent BUY date so the
  // form shows the real last operation date (Supabase I/O stays in the page,
  // the table component only calls onEditPosition(pos)).
  const handleStartEditPosition = async (pos) => {
    setEditingPositionId(pos.id);
    let lastOpDate = localTodayIso();
    try {
      // Supabase no lanza: devuelve `error`. Sin comprobarlo, un fallo dejaba el
      // diálogo con la fecha de hoy en vez de la de la última compra, sin rastro.
      const { data: txns, error } = await supabase
        .from('transactions')
        .select('transaction_date')
        .eq('position_id', pos.id)
        .eq('transaction_type', 'BUY')
        .order('transaction_date', { ascending: false })
        .limit(1);
      if (error) throw error;
      if (txns?.length) lastOpDate = txns[0].transaction_date.split('T')[0];
    } catch (e) {
      // El diálogo sigue abriendo (con la fecha de hoy); se deja constancia.
      console.warn('[edit-position] no se pudo leer la última compra:', e?.message || e);
    }
    setNewPosition({
      ticker: pos.assets?.ticker,
      name: pos.assets?.company_name,
      type: pos.assets?.asset_class || 'Stock',
      quantity: pos.quantity,
      average_price: pos.entry_price,
      currency: pos.assets?.currency || 'USD',
      target_percentage: pos.target_percentage || 0,
      isin: pos.assets?.isin || '',
      classification: pos.custom_classification || 'Others',
      last_operation_date: lastOpDate
    });
    setSearchTerm(pos.assets?.ticker);
    setIsAddPositionOpen(true);
  };

  const resetAddPositionForm = () => {
    setSearchTerm('');
    clearSearchResults();
    setEditingPositionId(null);
    setNewPosition({
      ticker: '', name: '', type: 'Stock', quantity: 0, average_price: 0, currency: 'USD', target_percentage: 0, isin: '', classification: 'Others', last_operation_date: localTodayIso()
    });
  };

  const handleAddPosition = async () => {
    if (selectedBrokerId === 'general') {
      toast({ variant: "destructive", title: t('cartera.action_not_permitted_title'), description: t('cartera.error_select_broker_position') });
      return;
    }
    if (!newPosition.ticker || !newPosition.quantity || !newPosition.average_price || !newPosition.last_operation_date) {
      toast({
        variant: "destructive",
        title: t('cartera.required_fields_title'),
        description: t('cartera.required_fields_desc')
      });
      return;
    }

    setIsAddingPosition(true);
    try {
      if (editingPositionId) {
        // Update existing position
        const { error } = await supabase.from('positions').update({
          quantity: newPosition.quantity,
          entry_price: newPosition.average_price,
          custom_classification: newPosition.classification,
          target_percentage: newPosition.target_percentage
        }).eq('id', editingPositionId);

        if (error) throw error;

        // Keep the BUY transaction(s) in sync with the edited position so the
        // "Historial de Transacciones" matches what the row shows.
        if (newPosition.last_operation_date) {
          const qty = parseFloat(newPosition.quantity) || 0;
          const price = parseFloat(newPosition.average_price) || 0;
          const buyDate = `${newPosition.last_operation_date}T00:00:00`;
          const { data: buyTxns } = await supabase
            .from('transactions')
            .select('id')
            .eq('position_id', editingPositionId)
            .eq('transaction_type', 'BUY')
            .order('transaction_date', { ascending: false });

          if (!buyTxns?.length) {
            // No BUY yet (position predates this logic) → create one retroactively so
            // the FIFO engine can fetch the historical FX rate and compute G/P Moneda.
            await supabase.from('transactions').insert({
              position_id: editingPositionId,
              transaction_type: 'BUY',
              quantity: qty,
              price: price,
              total_amount: qty * price,
              transaction_date: buyDate,
              notes: 'Transacción creada retroactivamente al editar posición manual',
            });
          } else if (buyTxns.length === 1) {
            // Single (manual) BUY → sync quantity/price/date with the edited position.
            // Previously only the date was updated, so editing qty/price left the
            // history showing the original "1 × price".
            await supabase.from('transactions')
              .update({ quantity: qty, price: price, total_amount: qty * price, transaction_date: buyDate })
              .eq('id', buyTxns[0].id);
          } else {
            // Multiple BUYs (imported real history) → never overwrite the individual
            // trades' qty/price; only sync the most recent one's date.
            await supabase.from('transactions')
              .update({ transaction_date: buyDate })
              .eq('id', buyTxns[0].id);
          }
        }

        // Update asset name and ISIN if provided. Via RPC: assets is shared across
        // users, so isin is backfill-only and company_name only applies when the
        // stored name is still a placeholder (never renames a shared asset for everyone).
        const { data: currentPos } = await supabase.from('positions').select('asset_id').eq('id', editingPositionId).single();
        if (currentPos?.asset_id && (newPosition.isin || newPosition.name)) {
          await supabase.rpc('update_asset_metadata', {
            p_asset_id: currentPos.asset_id,
            p_company_name: newPosition.name || null,
            p_isin: newPosition.isin || null,
          });
        }

        // Optimistic update: reflect changes immediately in the positions table row
        setPositions(prev => prev.map(p => p.id === editingPositionId ? {
          ...p,
          quantity: parseFloat(newPosition.quantity),
          entry_price: parseFloat(newPosition.average_price),
          custom_classification: newPosition.classification,
          target_percentage: parseFloat(newPosition.target_percentage) || 0,
          assets: p.assets ? { ...p.assets, company_name: newPosition.name || p.assets.company_name, isin: newPosition.isin || p.assets.isin } : p.assets,
        } : p));

        // Refresh the transaction history cache so the updated date shows immediately
        if (currentPos?.asset_id) {
          loadTransactionsForAsset(currentPos.asset_id, currentPos.assets?.isin, currentPos.assets?.ticker, currentPos.assets?.currency);
        }

        toast({ title: t('cartera.position_updated') });
      } else {
        // Check if asset already exists
        let { data: assetData } = await supabase.from('assets').select('id').eq('ticker', newPosition.ticker).limit(1);
        let asset = assetData && assetData.length > 0 ? assetData[0] : null;
        // ... (rest of search/insert logic remains similar but wrapped in assets check)

        let currentPrice = newPosition.average_price;

        // Intentamos obtener el precio real actual y moneda de Yahoo Finance si estamos creando el activo
        if (!asset) {
          let detectedCurrency = newPosition.currency;
          try {
            const quote = await yahooFinanceService.getQuote(newPosition.ticker);
            if (quote) {
              currentPrice = quote.current;
              if (quote.currency) detectedCurrency = quote.currency;
            }
          } catch (e) {
            console.warn("Could not fetch real-time price for new asset, using entry price.");
          }

          // Detect crypto from ticker format as fallback (e.g. BTC-USD, ETH-EUR)
          const isCryptoTicker = /^[A-Z0-9]+-[A-Z]{3}$/.test(newPosition.ticker);
          const resolvedAssetClass = (newPosition.type && newPosition.type !== 'Stock')
            ? newPosition.type
            : isCryptoTicker ? 'Crypto' : 'Stock';

          const created = await createAssets([{
            ticker: newPosition.ticker,
            company_name: newPosition.name,
            asset_class: resolvedAssetClass,
            currency: detectedCurrency,
            current_price: currentPrice,
            isin: newPosition.isin
          }]);
          asset = created[0];
          if (!asset?.id) throw new Error('Assets insert: empty response');
        }

        // Find or create a portfolio for the user
        let { data: portfolios } = await supabase.from('portfolios').select('id').eq('user_id', user.id).limit(1);
        let portfolioId;

        if (!portfolios || portfolios.length === 0) {
          const { data: newPortfolio, error: pError } = await supabase.from('portfolios').insert({
            user_id: user.id,
            name: 'Principal'
          }).select().single();
          if (pError) throw pError;
          portfolioId = newPortfolio.id;
        } else {
          portfolioId = portfolios[0].id;
        }

        // Check for ALL existing positions for this asset and broker to merge them
        const { data: existingPositions } = await supabase.from('positions')
          .select('*')
          .eq('broker_id', selectedBrokerId)
          .eq('asset_id', asset.id);

        let targetPosId;

        if (existingPositions && existingPositions.length > 0) {
          // Merge strategy: update the first one, delete the others
          const mainPos = existingPositions[0];
          let totalQty = parseFloat(newPosition.quantity);
          let totalCost = parseFloat(newPosition.quantity) * parseFloat(newPosition.average_price);

          existingPositions.forEach(p => {
            totalQty += parseFloat(p.quantity) || 0;
            totalCost += (parseFloat(p.quantity) || 0) * (parseFloat(p.entry_price) || 0);
          });

          const newAvgPrice = totalQty > 0 ? totalCost / totalQty : newPosition.average_price;

          const { error: updateError } = await supabase.from('positions').update({
            quantity: totalQty,
            entry_price: newAvgPrice
          }).eq('id', mainPos.id);

          if (updateError) throw updateError;

          // Delete duplicates if any
          if (existingPositions.length > 1) {
            const idsToDelete = existingPositions.slice(1).map(p => p.id);
            await supabase.from('positions').delete().in('id', idsToDelete);
          }

          targetPosId = mainPos.id;
        } else {
          const { data: posData, error: posError } = await supabase.from('positions').insert({
            portfolio_id: portfolioId,
            broker_id: selectedBrokerId,
            asset_id: asset.id,
            quantity: newPosition.quantity,
            entry_price: newPosition.average_price,
            target_percentage: newPosition.target_percentage,
            custom_classification: newPosition.classification
          }).select().single();

          if (posError) throw posError;
          targetPosId = posData.id;
        }

        // Add transaction record with the provided date - ALWAYS
        if (targetPosId) {
          const { error: transError } = await supabase.from('transactions').insert({
            position_id: targetPosId,
            transaction_type: 'BUY',
            quantity: newPosition.quantity,
            price: newPosition.average_price,
            total_amount: parseFloat(newPosition.quantity) * parseFloat(newPosition.average_price),
            transaction_date: `${newPosition.last_operation_date}T00:00:00`,
            notes: 'Posición añadida o incrementada manualmente'
          });
          if (transError) throw transError;
        }

        toast({ title: t('cartera.position_saved'), description: t('cartera.position_saved_desc', { ticker: newPosition.ticker, date: newPosition.last_operation_date }) });
      }
      setIsAddPositionOpen(false);
      resetAddPositionForm();
      loadPositions(selectedBrokerId, true);
    } catch (error) {
      console.error("Error adding/updating position:", error);
      toast({
        variant: "destructive",
        title: t('common.error'),
        description: error.message
      });
    } finally {
      setIsAddingPosition(false);
    }
  };

  // Calculate net holdings and P&L for imported transactions
  // CSV↔DB reconciliation — extracted to services/import/processedImportData
  // (pure, characterization-tested). The memo only binds current inputs.
  const processedImportData = React.useMemo(() => computeProcessedImportData({
    importedTransactions: currentImportedTransactions,
    dbTransactions,
    dynamicTickerMap,
    importPrices,
    exchangeRates,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [selectedBrokerId, importedTransactionsByBroker, dynamicTickerMap, dbTransactions, importPrices, exchangeRates, preferredCurrency]);


  // Reads a selected CSV, routes it to the broker-specific parser, and either
  // advances to the preview step or stores the raw text for the AI fallback.
  // Open the asset detail overlay resolving through the session ticker map first:
  // fund assets are stored as "NAME (EUR)" and only dynamicTickerMap knows their
  // real quote symbol (the overlay's own fallback only handles unmapped ISINs).
  // Same resolution as the table (resolveQuoteSymbol): looking only at the
  // import map, a stored map entry for another share class than the curated
  // one opened a different fund than the one the table values.
  const openAssetOverlay = (rawTicker) => {
    setOverlayTicker(resolveQuoteSymbol(rawTicker, dynamicTickerMapRef.current) || rawTicker);
  };

  // Flujo de import (parseo, AI fallback, preview fixes, confirmación y save
  // planner/executor) — extraído a hooks/useImportFlow (fase 2 del split).
  const {
    processImportText,
    handleCsvFileSelected,
    handleFreeformBrokerDetected,
    handleReportCsv,
    handleFixRow,
    handleAutoFixIssues,
    handleConfirmImport,
    handleAnalyzeWithAI,
    handleFreeformConfirm,
    handleSaveImportedData,
  } = useImportFlow({
    user, selectedBrokerId, positions, brokers, loadPositions,
    importBroker, setImportBroker, setUploadPhase, setIsImportDialogOpen, setIsFreeformOpen,
    setImportStep, replaceBrokerData, setReplaceBrokerData,
    pendingImportData, setPendingImportData, rawCsvText, setRawCsvText, setParseHint,
    csvReportSent, setCsvReportSent, setImportAudit, unrecognizedRows, setUnrecognizedRows,
    setIbkrParseWarnings, aiParsing, setAiParsing, setAiParseError,
    importAIExhausted, refreshImportUsage, validationIssues, clearIssues,
    setIsUploading, setImportLoading, importFinishRef, lastCsvTextRef,
    dynamicTickerMap, setDynamicTickerMap, dynamicTickerMapRef, importPrices,
    setImportedTransactionsByBroker, setIsSavedByBroker,
    setVisibleSales, setVisibleDividends, setVisibleCommissions, setVisibleCash,
    fetchPricesForImported, currentImportedTransactions, processedImportData,
  });

  // Header stats — pure financial aggregation lives in services/portfolioStats.js
  // (decimal.js). Memoized: the old IIFE recomputed every render (every keystroke).
  // NOTE: hooks must stay ABOVE the `if (loading) return` early return.
  const stats = React.useMemo(() => computePortfolioStats({
    positions,
    exchangeRates,
    assetHistoricalCost,
    historyTotals,
    importTotals: processedImportData.totals,
    importedTransactionsByBroker,
    savedBrokerIds,
    isSavedByBroker,
    selectedBrokerId,
  }), [positions, exchangeRates, assetHistoricalCost, historyTotals,
       processedImportData.totals, importedTransactionsByBroker, savedBrokerIds,
       isSavedByBroker, selectedBrokerId]);

  // Publica las stats de cabecera EXACTAS que el usuario está viendo para que
  // el share "live" sirva estos mismos números (scope '<bId>:display' en
  // portfolio_metrics_cache; el server valida frescura con txCount y convierte
  // a EUR con el MISMO eurRate del cliente). Debounced: stats cambia con cada
  // refresh de precios. Fire-and-forget — nunca bloquea la UI.
  React.useEffect(() => {
    if (!user?.id || !initReady || loading) return;
    const timer = setTimeout(() => {
      supabase.from('portfolio_metrics_cache').upsert({
        user_id: user.id,
        scope: `${selectedBrokerId}:display`,
        currency: preferredCurrency,
        metrics: {
          investedValue: stats.investedValue,
          invested: stats.invested,
          current: stats.current,
          totalCash: stats.totalCash,
          gain: stats.gain,
          gainPercent: stats.gainPercent,
          latentGain: stats.latentGain,
          realizedGain: stats.realizedGain,
          dividendsGain: stats.dividendsGain,
          feesTotal: stats.feesTotal,
          totalCapitalDeployed: stats.totalCapitalDeployed,
          eurRate: exchangeRates['EUR'] ?? 1,
          txCount: dbTransactions.length,
        },
        computed_at: new Date().toISOString(),
      }, { onConflict: 'user_id, scope' }).then(({ error }) => {
        if (error) console.warn('[display-cache] upsert failed:', error.message);
      });
    }, 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, initReady, loading, selectedBrokerId, preferredCurrency, stats, dbTransactions.length]);

  if (loading) return <Loader2 className="animate-spin mx-auto mt-20" />;

  const isGeneralView = selectedBrokerId === 'general';

  // Annualized return (CAGR) — annualizes the cumulative TWR over the exact window the
  // TWR series covers, so it is consistent with the chart's CAGR and with the TWR tile.
  // The previous version annualized Simple ROI (gain / totalBuyCost): that assumes ALL
  // historical capital was deployed on day one and counts recycled capital (sell→rebuy)
  // twice in the denominator, so it understated CAGR for portfolios with periodic buys.
  // La ventana arranca en el primer día INVERTIDO, no en el primer punto de la
  // serie: ésta empieza en la primera transacción de cualquier tipo, así que un
  // ingreso de efectivo meses antes de la primera compra añadía meses al divisor
  // y hundía la anualizada sin tocar el TWR (reportado: +60,44% de TWR desde el
  // 6-oct-2024 salía como +19,08% anual porque la ventana medía 2,7 años en vez
  // de 2,0 — la cifra correcta es +27,3%). Misma regla que el benchmark.
  // La ventana se calcula UNA vez y se enseña en el diálogo de la métrica: una
  // anualizada sin decir sobre qué periodo se calcula no se puede auditar, y es
  // exactamente lo que impidió ver este fallo antes.
  const cagrWindow = (() => {
    if (!performanceGrowthData.length) return null;
    const start = firstInvestedDate(performanceGrowthData);
    const last = performanceGrowthData[performanceGrowthData.length - 1];
    const end = last.date || last.name;
    const years = windowYears(start, end);
    return years == null ? null : { start, end, years };
  })();
  const portfolioCagr = cagrWindow
    ? annualizeReturn(twrAllTime, cagrWindow.start, cagrWindow.end)
    : null;

  // Latent ROI: return on currently-held positions vs the hybrid cost basis
  // (per-position FIFO/entry mix — complete even when only some brokers have
  // their history saved to the DB; the global openPositionCost is partial then).
  const latentRoiPct = (() => {
    const costBasis = historyTotals.investedHybrid > 0
      ? historyTotals.investedHybrid
      : stats.invested;
    return costBasis > 0 ? ((stats.investedValue - costBasis) / costBasis) * 100 : 0;
  })();

  const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4'];

  // --- History filter helpers ---
  const fechaPartsToISO = (fecha = '') => {
    const p = fecha.split('-');
    return p.length === 3 ? `${p[2]}-${p[1]}-${p[0]}` : '';
  };
  const getHistCutoff = () => {
    const now = new Date();
    if (histRange === '6M') return new Date(now.getFullYear(), now.getMonth() - 6, 1);
    if (histRange === '1Y') return new Date(now.getFullYear() - 1, now.getMonth(), 1);
    if (histRange === 'YTD') return new Date(now.getFullYear(), 0, 1);
    return null;
  };
  const filterChart = (data) => {
    if (histRange === 'ALL') return data;
    if (histRange === 'CUSTOM') {
      const from = histRangeFrom.slice(0, 7);
      const to = histRangeTo.slice(0, 7);
      return data.filter(d => (!from || d.name >= from) && (!to || d.name <= to));
    }
    const cutoffStr = getHistCutoff()?.toISOString().slice(0, 7);
    return cutoffStr ? data.filter(d => d.name >= cutoffStr) : data;
  };
  const filterTable = (items) => {
    if (histRange === 'ALL') return items;
    if (histRange === 'CUSTOM') {
      return items.filter(t => {
        const iso = fechaPartsToISO(t.fecha);
        return (!histRangeFrom || iso >= histRangeFrom) && (!histRangeTo || iso <= histRangeTo);
      });
    }
    const cutoff = getHistCutoff();
    return cutoff ? items.filter(t => new Date(fechaPartsToISO(t.fecha)) >= cutoff) : items;
  };

  // Pre-filtered chart data
  const filtSalesChart = filterChart(processedImportData.charts?.salesChartData || []);
  const filtDivsChart  = filterChart(processedImportData.charts?.dividendsChartData || []);
  const filtCommsChart = filterChart(processedImportData.charts?.commissionsChartData || []);

  // Pre-filtered table data (range + search combined)
  const filtSalesRange = filterTable(processedImportData.salesWithPL || []);
  const filtSales      = searchSales
    ? filtSalesRange.filter(t => (t.nombre || t.producto || t.isin || '').toLowerCase().includes(searchSales.toLowerCase()))
    : filtSalesRange;
  const filtDivs = filterTable(processedImportData.dividends || []).filter(t =>
    !searchDividends || (t.producto || '').toLowerCase().includes(searchDividends.toLowerCase())
  );
  const filtComms = filterTable(processedImportData.commissions || []).filter(t =>
    !searchCommissions || (t.descripcion || t.producto || '').toLowerCase().includes(searchCommissions.toLowerCase())
  );
  const filtCash = filterTable(processedImportData.cashTransfers || []).filter(t =>
    !searchCash || (t.descripcion || '').toLowerCase().includes(searchCash.toLowerCase())
  );

  // Filtered totals (preferred currency via exchangeRates)
  const filtSalesTotal = filtSales.reduce((s, t) => s + (t.profit || 0) * (exchangeRates[t.moneda || 'EUR'] || 1), 0);
  const filtDivsTotal  = filtDivs.reduce((s, t)  => s + (t.total  || 0) * (exchangeRates[t.moneda || 'EUR'] || 1), 0);
  const filtCommsTotal = filtComms.reduce((s, t) => s + Math.abs(t.total || 0) * (exchangeRates[t.moneda || 'EUR'] || 1), 0);
  const filtCashTotal  = filtCash.reduce((s, t)  => s + (t.total  || 0) * (exchangeRates[t.moneda || 'EUR'] || 1), 0);

  const renderCustomizedLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, percent }) => {
    const RADIAN = Math.PI / 180;
    const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
    const x = cx + radius * Math.cos(-midAngle * RADIAN);
    const y = cy + radius * Math.sin(-midAngle * RADIAN);

    if (percent < 0.05) return null; // Don't show labels for tiny slices

    return (
      <text
        x={x} y={y}
        fill="white"
        textAnchor="middle"
        dominantBaseline="central"
        className="text-[10px] font-bold fill-white pointer-events-none"
      >
        {formatPercent(percent * 100, 0)}
      </text>
    );
  };

  // Nada que enseñar: ni posiciones ni movimientos en lo seleccionado.
  const isEmptyBroker = !!selectedBrokerId
    && positionsLoadedFor === selectedBrokerId
    && !refreshing
    && positions.length === 0
    && (dbTransactions || []).length === 0;

  return (
    <div className="space-y-6">
      <Helmet><title>{t('cartera.page_title')}</title></Helmet>

      {/* pt-4: la barra de acciones (fixed) es el primer hijo; ver el comentario
          equivalente en Dashboard.jsx (hueco que Tailwind 3 daba por space-y-4). */}
      <div className="flex flex-col space-y-4 pt-4">

        {/* Broker picker — shown when an action is triggered from the general view */}
        <Dialog open={!!pendingBrokerAction} onOpenChange={(open) => { if (!open) setPendingBrokerAction(null); }}>
          <DialogContent className="max-w-sm dark:bg-slate-900 border-none">
            <DialogHeader>
              <DialogTitle className="dark:text-white">{t('cartera.pick_broker_title')}</DialogTitle>
              <DialogDescription>{t('cartera.pick_broker_desc')}</DialogDescription>
            </DialogHeader>
            <div className="py-2 space-y-2 max-h-[50vh] overflow-y-auto">
              {brokers.filter(b => b.id !== 'general').map(b => (
                <button
                  key={b.id}
                  onClick={() => confirmBrokerAction(b.id)}
                  className="w-full text-left px-4 py-3 rounded-lg border border-slate-200 dark:border-slate-700 hover:border-blue-400 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors text-sm font-semibold text-slate-900 dark:text-white"
                >
                  {b.name}
                </button>
              ))}
            </div>
          </DialogContent>
        </Dialog>

        {/* ── Floating Action Bar — extracted to components/cartera/PositionActionBar ── */}
        <PositionActionBar
          refreshing={refreshing}
          onRefresh={() => refreshPrices()}
          isGeneralView={selectedBrokerId === 'general'}
          isBrokerSaved={savedBrokerIds.has(selectedBrokerId) || !!isSavedByBroker[selectedBrokerId]}
          onOpenDividend={() => requestBrokerAction('dividend')}
          onOpenSale={() => requestBrokerAction('sale')}
          onOpenCommission={() => requestBrokerAction('commission')}
          onOpenCash={() => requestBrokerAction('cash')}
          onOpenSync={() => requestBrokerAction('sync')}
          onOpenImport={() => requestBrokerAction('import')}
          onOpenAddPosition={() => requestBrokerAction('position')}
          onOpenRebalance={() => navigate(selectedBrokerId === 'general'
            ? '/app/rebalance'
            : `/app/rebalance?broker=${selectedBrokerId}`)}
          onOpenTaxReport={() => setIsTaxReportOpen(true)}
        />

        {/* Header stat cards — extracted to components/cartera/PortfolioStatsCards.
            Un broker vacío no enseña tres tarjetas a cero: enseña qué hacer. */}
        {!isEmptyBroker && <PortfolioStatsCards
          stats={stats}
          preferredCurrency={preferredCurrency}
          maskMoney={maskMoney}
          onExplainMetric={setExplainingMetric}
          latentRoiPct={latentRoiPct}
          portfolioCagr={portfolioCagr}
          twrAllTime={twrAllTime}
        />}

        {/* Broker tab bar — extracted to components/cartera/BrokerTabBar */}
        <BrokerTabBar
          brokers={brokers}
          selectedBrokerId={selectedBrokerId}
          onSelectBroker={setSelectedBrokerId}
          onReorder={(newOrder) => {
            // `brokers` is derived from brokerOrder — one state update is enough.
            setBrokerOrder(newOrder.map(b => b.id));
          }}
          onEditBroker={(broker) => {
            setEditingBroker(broker);
            setEditBrokerName(broker.name);
          }}
          onAddBroker={handleAddBroker}
        />
      </div>

      {isEmptyBroker && (
        <BrokerEmptyState
          onImport={() => requestBrokerAction('import')}
          onAddPosition={() => requestBrokerAction('position')}
        />
      )}

      {selectedBrokerId && !isEmptyBroker && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-2xl overflow-hidden shadow-xs">

          {/* Mobile card list — extracted to components/cartera/PositionsMobileList */}
          <PositionsMobileList
            positions={positions}
            isGeneralView={isGeneralView}
            preferredCurrency={preferredCurrency}
            exchangeRates={exchangeRates}
            assetHistoricalCost={assetHistoricalCost}
            stats={stats}
            expandedAssetTicker={expandedAssetTicker}
            onToggleExpand={handleToggleExpandPosition}
            onOpenAsset={openAssetOverlay}
            assetTransactions={assetTransactions}
            maskMoney={maskMoney}
          />

          {/* Desktop table — extracted to components/cartera/PositionsDesktopTable */}
          <PositionsDesktopTable
            positions={positions}
            isGeneralView={isGeneralView}
            preferredCurrency={preferredCurrency}
            exchangeRates={exchangeRates}
            assetHistoricalCost={assetHistoricalCost}
            stats={stats}
            expandedAssetTicker={expandedAssetTicker}
            onToggleExpand={handleToggleExpandPosition}
            onOpenAsset={openAssetOverlay}
            onEditPosition={handleStartEditPosition}
            onDeletePosition={setPositionToDelete}
            assetTransactions={assetTransactions}
          />
        </div>
      )}

      {/* Analytics Summary — oculto en un broker vacío: sin datos solo eran
          gráficos y tablas a cero debajo del estado vacío. */}
      {!isEmptyBroker && (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
          <div className="flex items-center gap-3 border-l-4 border-blue-500 pl-4 py-1">
            <h2 className="font-display text-2xl font-black text-slate-900 dark:text-white">{t('cartera.portfolio_analysis')}</h2>
          </div>

          {/* Analytics Summary */}
          <div className="space-y-6">

            {/* F: Period filter bar + mini-charts */}
            <div className="space-y-4">
              {/* Period filter bar — extracted to components/cartera/HistoryPeriodFilterBar */}
              <HistoryPeriodFilterBar
                histRange={histRange}
                onRangeChange={(id) => {
                  setHistRange(id);
                  setVisibleSales(10); setVisibleDividends(10); setVisibleCommissions(10); setVisibleCash(10);
                  if (id !== 'CUSTOM') { setHistRangeFrom(''); setHistRangeTo(''); }
                }}
                histRangeFrom={histRangeFrom}
                onRangeFromChange={setHistRangeFrom}
                histRangeTo={histRangeTo}
                onRangeToChange={setHistRangeTo}
              />

              {/* Mini charts grid */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* P&L Ventas por Mes */}
                {(() => {
                  const data  = filtSalesChart;
                  const total = data.reduce((s, d) => s + d.value, 0);
                  const best  = data.reduce((m, d) => d.value > m ? d.value : m, -Infinity);
                  const worst = data.reduce((m, d) => d.value < m ? d.value : m,  Infinity);
                  const footer = (data.length > 0 && isFinite(best) && isFinite(worst))
                    ? [
                        { label: t('cartera.best'),  value: `${formatMoney(best, preferredCurrency, { decimals: 0 })}`,  tone: 'emerald' },
                        { label: t('cartera.worst'), value: `${formatMoney(worst, preferredCurrency, { decimals: 0 })}`, tone: 'rose' },
                      ]
                    : [];
                  return (
                    <MonthlyBreakdownChart
                      title={t('cartera.pnl_sales')}
                      accent="blue"
                      valueMode="signed"
                      yAxisAbbreviate
                      currency={preferredCurrency}
                      data={data}
                      total={total}
                      footer={footer}
                    />
                  );
                })()}

                {/* Dividendos por Mes */}
                {(() => {
                  const data  = filtDivsChart;
                  const total = data.reduce((s, d) => s + d.value, 0);
                  const best  = data.reduce((m, d) => d.value > m ? d.value : m, 0);
                  const count = data.filter(d => d.value > 0).length;
                  const footer = [
                    { label: t('cartera.months_with_div'), value: String(count), tone: 'neutral' },
                    ...(best > 0 ? [{ label: t('cartera.best'), value: `${formatMoney(best, preferredCurrency, { decimals: 2 })}`, tone: 'emerald' }] : []),
                  ];
                  return (
                    <MonthlyBreakdownChart
                      title={t('cartera.dividends_chart')}
                      accent="emerald"
                      valueMode="positive"
                      currency={preferredCurrency}
                      data={data}
                      total={total}
                      footer={footer}
                    />
                  );
                })()}

                {/* Comisiones por Mes */}
                {(() => {
                  const data  = filtCommsChart;
                  const total = data.reduce((s, d) => s + d.value, 0);
                  const max   = data.reduce((m, d) => d.value > m ? d.value : m, 0);
                  const paidMonths = data.filter(d => d.value > 0).length;
                  const avg   = paidMonths > 0 ? total / paidMonths : 0;
                  const footer = [
                    { label: t('cartera.most_expensive_month'), value: `${formatMoney(max, preferredCurrency, { decimals: 2 })}`, tone: 'rose' },
                    { label: t('cartera.avg_per_month'),        value: `${formatMoney(avg, preferredCurrency, { decimals: 2 })}`, tone: 'neutral' },
                  ];
                  return (
                    <MonthlyBreakdownChart
                      title={t('cartera.fees_chart')}
                      accent="rose"
                      valueMode="negative"
                      currency={preferredCurrency}
                      data={data}
                      total={total}
                      footer={footer}
                    />
                  );
                })()}
              </div>
            </div>
          </div>


          {/* Informe fiscal — el botón vive en la barra superior (PositionActionBar);
              el diálogo se queda aquí porque consume processedImportData. */}
          <TaxReportDialog
            isOpen={isTaxReportOpen}
            onOpenChange={setIsTaxReportOpen}
            sales={processedImportData.salesWithPL || []}
            buys={processedImportData.buys || []}
            dividends={processedImportData.dividends || []}
            commissions={processedImportData.commissions || []}
            preferredCurrency={preferredCurrency}
            maskMoney={maskMoney}
          />

          {/* Ventas Table via Custom Component */}
          <ErrorBoundary title={t('cartera.error_sales_table')}>
          <RealizedPnLTable
            salesWithPL={filtSales}
            exchangeRates={exchangeRates}
            visibleSales={visibleSales}
            setVisibleSales={setVisibleSales}
            setIsAddSaleOpen={setIsAddSaleOpen}
            setManualSale={setManualSale}
            handleDeleteTransaction={handleDeleteTransaction}
            selectedBrokerId={selectedBrokerId}
            totals={processedImportData.totals}
            preferredCurrency={preferredCurrency}
            filteredTotal={filtSalesTotal}
            search={searchSales}
            setSearch={(v) => { setSearchSales(v); setVisibleSales(10); }}
            totalCount={processedImportData.salesWithPL?.length || 0}
          />
          </ErrorBoundary>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Dividendos Table */}
            <TransactionListCard
              accent="emerald"
              Icon={FileText}
              title={t('cartera.dividends_received')}
              onAdd={selectedBrokerId !== 'general' ? () => setIsAddDividendOpen(true) : null}
              addTitle={t('cartera.placeholder_add_dividend')}
              headerTotalText={`${formatMoney(filtDivsTotal, preferredCurrency, { decimals: 2 })}`}
              recordsCount={filtDivs.length}
              showRecords={histRange !== 'ALL'}
              searchValue={searchDividends}
              onSearchChange={(v) => { setSearchDividends(v); setVisibleDividends(10); }}
              searchPlaceholder={t('cartera.placeholder_search_product')}
              labelHeader={t('cartera.product')}
              footerLabel={t('cartera.total')}
              footerTotalText={`${formatMoney(filtDivsTotal, preferredCurrency, { decimals: 2 })}`}
              data={filtDivs}
              visibleCount={visibleDividends}
              onSeeMore={() => setVisibleDividends(prev => prev + 20)}
              renderRow={(row, i) => (
                <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors group">
                  <td className="px-3 py-3 text-slate-500 text-xs">{row.fecha}</td>
                  <td className="px-3 py-3 font-medium text-[10px] leading-tight line-clamp-1">{row.producto}</td>
                  <td className="px-3 py-3 text-right text-emerald-600 dark:text-emerald-400 font-bold">{formatMoney(row.total, row.moneda, { decimals: 2 })}</td>
                  <td className="px-3 py-3 text-center">
                    {row.isFromDB && (
                      <div className="flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => {
                          setManualDividend({ id: row.id, positionId: row.position_id, amount: row.total, date: row.fecha.split('-').reverse().join('-'), notes: row.notes });
                          setIsAddDividendOpen(true);
                        }} className="p-0.5 text-slate-400 hover:text-blue-500"><Edit className="w-3 h-3" /></button>
                        <button onClick={() => handleDeleteTransaction(row)} className="p-0.5 text-slate-400 hover:text-red-500"><Trash2 className="w-3 h-3" /></button>
                      </div>
                    )}
                  </td>
                </tr>
              )}
            />

            {/* Comisiones Table */}
            <TransactionListCard
              accent="rose"
              Icon={HistoryIcon}
              title={t('cartera.fees')}
              titleClassName="text-slate-600 dark:text-slate-300"
              onAdd={selectedBrokerId !== 'general' ? () => setIsAddCommissionOpen(true) : null}
              addTitle={t('cartera.placeholder_add_commission')}
              headerTotalText={formatMoney(-filtCommsTotal, preferredCurrency, { decimals: 2 })}
              recordsCount={filtComms.length}
              showRecords={histRange !== 'ALL'}
              searchValue={searchCommissions}
              onSearchChange={(v) => { setSearchCommissions(v); setVisibleCommissions(10); }}
              searchPlaceholder={t('cartera.placeholder_search_concept')}
              labelHeader={t('cartera.concept')}
              footerLabel={t('cartera.total')}
              footerTotalText={formatMoney(-filtCommsTotal, preferredCurrency, { decimals: 2 })}
              data={filtComms}
              visibleCount={visibleCommissions}
              onSeeMore={() => setVisibleCommissions(prev => prev + 20)}
              renderRow={(row, i) => (
                <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors group">
                  <td className="px-3 py-3 text-slate-500 text-xs">{row.fecha}</td>
                  <td className="px-3 py-3 text-[10px] leading-tight font-medium line-clamp-1">{row.descripcion || row.producto}</td>
                  <td className="px-3 py-3 text-right text-rose-500 dark:text-rose-400 font-bold">
                    {formatMoney(Math.abs(row.total), row.moneda, { decimals: FIAT_CURRENCIES.includes(row.moneda) ? 2 : 8, minDecimals: 2 })}
                  </td>
                  <td className="px-3 py-3 text-center">
                    {row.isFromDB && (
                      <div className="flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => {
                          setManualCommission({ id: row.id, positionId: row.position_id, amount: Math.abs(row.total), date: row.fecha.split('-').reverse().join('-'), description: row.notes || row.descripcion });
                          setIsAddCommissionOpen(true);
                        }} className="p-0.5 text-slate-400 hover:text-blue-500"><Edit className="w-3 h-3" /></button>
                        <button onClick={() => handleDeleteTransaction(row)} className="p-0.5 text-slate-400 hover:text-red-500"><Trash2 className="w-3 h-3" /></button>
                      </div>
                    )}
                  </td>
                </tr>
              )}
            />

            {/* Líquidez Table */}
            <TransactionListCard
              accent="blue"
              Icon={DollarSign}
              title={t('cartera.liquidity_section')}
              onAdd={selectedBrokerId !== 'general' ? () => setIsAddCashOpen(true) : null}
              addTitle={t('cartera.placeholder_add_movement')}
              headerTotalText={`${formatMoney(filtCashTotal, preferredCurrency, { decimals: 2 })}`}
              recordsCount={filtCash.length}
              showRecords={histRange !== 'ALL'}
              searchValue={searchCash}
              onSearchChange={(v) => { setSearchCash(v); setVisibleCash(10); }}
              searchPlaceholder={t('cartera.placeholder_search_desc')}
              labelHeader={t('cartera.description')}
              footerLabel={t('cartera.cash_total')}
              footerTotalText={`${formatMoney(filtCashTotal, preferredCurrency, { decimals: 2 })}`}
              data={filtCash}
              visibleCount={visibleCash}
              onSeeMore={() => setVisibleCash(prev => prev + 20)}
              renderRow={(row, i) => (
                <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors group">
                  <td className="px-3 py-3 text-slate-500 text-xs">{row.fecha}</td>
                  <td className="px-3 py-3 text-[10px] leading-tight font-medium line-clamp-1">{row.descripcion}</td>
                  <td className={`px-3 py-3 text-right font-bold ${row.total >= 0 ? 'text-blue-600' : 'text-slate-500'}`}>
                    {formatMoney(row.total, row.moneda, { decimals: FIAT_CURRENCIES.includes(row.moneda) ? 2 : 8, minDecimals: 2 })}
                  </td>
                  <td className="px-3 py-3 text-center">
                    {row.isFromDB && (
                      <div className="flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => {
                          setManualCash({ id: row.id, amount: Math.abs(row.total), type: row.total >= 0 ? 'DEPOSIT' : 'WITHDRAWAL', date: row.fecha.split('-').reverse().join('-'), description: row.notes || row.descripcion });
                          setIsAddCashOpen(true);
                        }} className="p-0.5 text-slate-400 hover:text-blue-500"><Edit className="w-3 h-3" /></button>
                        <button onClick={() => handleDeleteTransaction(row)} className="p-0.5 text-slate-400 hover:text-red-500"><Trash2 className="w-3 h-3" /></button>
                      </div>
                    )}
                  </td>
                </tr>
              )}
            />
          </div>
        </div>
      )}

      <BrokerDialogs
        editingBroker={editingBroker}
        onEditOpenChange={() => setEditingBroker(null)}
        editBrokerName={editBrokerName}
        onEditBrokerNameChange={setEditBrokerName}
        onSave={handleUpdateBroker}
        onRequestDelete={handleDeleteBroker}
        isDeleteConfirmOpen={isDeleteBrokerConfirmOpen}
        onDeleteConfirmOpenChange={setIsDeleteBrokerConfirmOpen}
        onConfirmDelete={confirmDeleteBroker}
      />

      <DeletePositionDialog
        position={positionToDelete}
        onCancel={() => setPositionToDelete(null)}
        onConfirm={confirmDeletePosition}
      />


      {/* Add/Edit Position dialog — extracted to components/cartera/AddEditPositionDialog */}
      <AddEditPositionDialog
        open={isAddPositionOpen}
        onOpenChange={(open) => {
          setIsAddPositionOpen(open);
          if (!open) resetAddPositionForm();
        }}
        editingPositionId={editingPositionId}
        newPosition={newPosition}
        setNewPosition={setNewPosition}
        isAddingPosition={isAddingPosition}
        onSave={handleAddPosition}
        searchTerm={searchTerm}
        setSearchTerm={setSearchTerm}
        searchResults={searchResults}
        isSearching={isSearching}
        searchSelectedIndex={searchSelectedIndex}
        searchKeyDown={searchKeyDown}
        clearSearchResults={clearSearchResults}
      />

      {/* Import Data Dialog */}
      <Dialog
        open={isImportDialogOpen}
        onOpenChange={(open) => {
          setIsImportDialogOpen(open);
          if (!open) {
            setImportStep('upload');
            setUploadPhase('method');
            setReplaceBrokerData(false);
            setPendingImportData(null);
            clearIssues();
            setEnableAIValidation(true);
            setRawCsvText(null);
            setAiParseError(null);
            setIbkrParseWarnings([]);
            setIsResync(false);
          }
        }}
      >
        <DialogContent className={`${importStep === 'preview' ? 'max-w-lg' : 'max-w-md'} dark:bg-slate-900 border-none p-0 flex flex-col max-h-[90vh] overflow-hidden transition-all`}>

          {/* Fake loading overlay — mounts over all dialog content during import.
              onComplete fires after ~8s animation; at that point we await the real
              import promise (usually already done) then clean up and close. */}
          <ImportLoadingOverlay
            visible={importLoading}
            onComplete={async () => {
              if (importFinishRef.current) {
                await importFinishRef.current();
                importFinishRef.current = null;
              }
            }}
          />

          {/* Step progress accent bar — always fixed */}
          <div className={`h-[3px] w-full shrink-0 transition-all ${importStep === 'upload' ? 'bg-linear-to-r from-blue-500 to-indigo-500' : 'bg-linear-to-r from-emerald-500 to-teal-500'}`} />

          {/* Header — always fixed, never scrolls */}
          <div className="px-6 pt-6 pb-5 shrink-0">
            <DialogHeader>
              <DialogTitle className="dark:text-white flex items-center gap-2.5">
                {(importStep === 'preview' || uploadPhase !== 'method') && (
                  <button
                    onClick={() => {
                      if (importStep === 'preview') {
                        setImportStep('upload');
                        setPendingImportData(null);
                        clearIssues();
                        setRawCsvText(null);
                        setAiParseError(null);
                        setIbkrParseWarnings([]);
                        // freeform previews have no file phase to return to
                        setUploadPhase(importBroker === 'freeform' ? 'method' : 'file');
                      } else if (uploadPhase === 'file') {
                        setRawCsvText(null);
                        setParseHint(null);
                        setAiParseError(null);
                        setUploadPhase('brokers');
                      } else {
                        setUploadPhase('method');
                      }
                    }}
                    className="p-1.5 -ml-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0"
                  >
                    <ArrowLeft className="w-4 h-4 text-slate-500" />
                  </button>
                )}
                <div>
                  <p className="text-[15px] font-bold leading-tight">
                    {importStep === 'upload'
                      ? (isResync ? t('cartera.sync_title') : t('cartera.import_title'))
                      : t('cartera.import_review_title')}
                  </p>
                  <p className="text-[11px] font-normal text-slate-400 dark:text-slate-500 mt-0.5">
                    {importStep === 'upload'
                      ? (isResync
                          ? t('cartera.sync_step1')
                          : t(uploadPhase === 'file' ? 'cartera.import_step1_file' : 'cartera.import_step1'))
                      : (isResync ? t('cartera.sync_step2') : t('cartera.import_step2'))}
                  </p>
                </div>
              </DialogTitle>
            </DialogHeader>
          </div>

          {/* Scrollable body — expands, never pushes buttons off-screen */}
          <div className="flex-1 overflow-y-auto px-6">

            {/* ── STEP 1: Upload (method chooser → broker search → file) ──── */}
            {importStep === 'upload' && (
              <div className="space-y-4 pb-6">

                {uploadPhase === 'method' && (
                  <ImportMethodChooser
                    onReresolveFunds={isResync ? handleReresolveFunds : undefined}
                    reresolving={reresolvingFunds}
                    onSelectCsv={() => setUploadPhase('brokers')}
                    onSelectAi={() => { setImportBroker('freeform'); setIsFreeformOpen(true); }}
                    aiExhausted={importAIExhausted}
                    aiDailyLeft={importAIDailyLeft}
                  />
                )}

                {uploadPhase === 'brokers' && (
                  <ImportBrokerSelector
                    importBroker={importBroker}
                    onSelectBroker={(id) => { setImportBroker(id); setUploadPhase('file'); }}
                    onSelectFreeform={importAIExhausted ? undefined : () => { setImportBroker('freeform'); setIsFreeformOpen(true); }}
                  />
                )}

                {uploadPhase === 'file' && (
                  <ImportUploadStep
                    importBroker={importBroker}
                    isUploading={isUploading}
                    onFileSelected={handleCsvFileSelected}
                    rawCsvText={rawCsvText}
                    parseHint={parseHint}
                    aiParseError={aiParseError}
                    aiParsing={aiParsing}
                    onAnalyzeWithAI={handleAnalyzeWithAI}
                    onCancelAiFallback={() => { setRawCsvText(null); setParseHint(null); setAiParseError(null); }}
                    aiExhausted={importAIExhausted}
                    aiDailyLeft={importAIDailyLeft}
                    enableAIValidation={enableAIValidation}
                    onToggleValidation={setEnableAIValidation}
                    onReportCsv={handleReportCsv}
                    csvReportSent={csvReportSent}
                  />
                )}

              </div>
            )}

            {/* ── STEP 2: Preview + AI Validation ────────────────────────── */}
            {importStep === 'preview' && pendingImportData && (
              <ImportPreviewStep
                pendingImportData={pendingImportData}
                ibkrParseWarnings={ibkrParseWarnings}
                importAudit={importAudit}
                unrecognizedRows={unrecognizedRows}
                onReportCsv={handleReportCsv}
                csvReportSent={csvReportSent}
                enableAIValidation={enableAIValidation}
                validationIssues={validationIssues}
                validating={validating}
                validationWarning={validationWarning}
                onFixRow={handleFixRow}
                onAutoFix={handleAutoFixIssues}
              />
            )}
          </div>

          {/* Footer — fixed, never scrolls. Only shown in Step 2. */}
          {importStep === 'preview' && (
            <div className="px-6 pb-6 pt-3 shrink-0 border-t border-slate-100 dark:border-slate-800">
              {/* Warning: BUY/SELL rows with qty=0 or price=0 will create corrupt positions */}
              {(() => {
                const degenerate = (pendingImportData || []).filter(t =>
                  (t.type === 'BUY' || t.type === 'SELL') &&
                  (!t.cantidad || parseFloat(t.cantidad) === 0 || !t.precio || parseFloat(t.precio) === 0)
                );
                if (degenerate.length === 0) return null;
                return (
                  <div className="mb-3 px-3 py-2.5 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-[12px] font-semibold text-amber-700 dark:text-amber-300">
                        {t('cartera.degenerate_ops', { count: degenerate.length })}
                      </p>
                      <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">
                        {t('cartera.degenerate_ops_warn')}
                      </p>
                    </div>
                  </div>
                );
              })()}
              {/* Re-sync repair: replace this broker's imported data instead of merging.
                  Only offered when the broker already has saved data. */}
              {(savedBrokerIds.has(selectedBrokerId) || isSavedByBroker[selectedBrokerId]) && (
                <label className="mb-3 flex items-start gap-2.5 px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 cursor-pointer select-none hover:border-slate-300 dark:hover:border-slate-600 transition-colors">
                  <input
                    type="checkbox"
                    checked={replaceBrokerData}
                    onChange={(e) => setReplaceBrokerData(e.target.checked)}
                    className="mt-0.5 w-4 h-4 rounded accent-rose-600 cursor-pointer shrink-0"
                  />
                  <span className="min-w-0">
                    <span className="block text-[12px] font-semibold text-slate-700 dark:text-slate-200">{t('cartera.replace_broker_data')}</span>
                    <span className="block text-[11px] text-slate-400 mt-0.5">{t('cartera.replace_broker_data_hint')}</span>
                  </span>
                </label>
              )}
              <div className="flex gap-2.5">
                <button
                  onClick={() => { setImportStep('upload'); setPendingImportData(null); clearIssues(); setRawCsvText(null); setAiParseError(null); setIbkrParseWarnings([]); }}
                  className="flex-1 py-2.5 rounded-xl border-2 border-slate-200 dark:border-slate-700 text-sm font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                >
                  {t('cartera.import_back')}
                </button>
                <button
                  disabled={isUploading || importLoading}
                  onClick={handleConfirmImport}
                  className="flex-2 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-sm font-bold transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <CheckCircle2 className="w-4 h-4" /> {t('cartera.confirm_import')}
                </button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Free-form AI import: paste chaotic text → AI extraction → editable HITL table */}
      <FreeformImportDialog
        open={isFreeformOpen}
        onOpenChange={(v) => {
          setIsFreeformOpen(v);
          // Closing without confirming: leave 'freeform' selected would route the
          // CSV dropzone to the DeGiro parser silently — restore the default.
          if (!v && importBroker === 'freeform') setImportBroker('degiro');
        }}
        onConfirm={handleFreeformConfirm}
        onBrokerCsvDetected={handleFreeformBrokerDetected}
        isSaving={isUploading}
        dailyLeft={importAIDailyLeft}
        exhausted={importAIExhausted}
        onAnalyzed={refreshImportUsage}
      />

      {/* Global Search Overlay for Asset Details */}
      {overlayTicker && user?.id && (
        <GlobalSearchOverlay
          ticker={overlayTicker}
          onClose={() => setOverlayTicker(null)}
          userId={user.id}
        />
      )}
      {/* Explainer Dialog for Metrics — leads with the user's live value */}
      <MetricExplainerDialog
        metric={explainingMetric}
        explanations={metricExplanations}
        liveValues={{
          'Valor en Mercado':        { value: stats.investedValue, format: 'money' },
          'Ganancia Total':          { value: stats.gain,          format: 'money' },
          'Latente (hoy)':           { value: stats.latentGain,    format: 'money' },
          'Realizado (hist.)':       { value: stats.realizedGain,  format: 'money' },
          'Dividendos (hist.)':      { value: stats.dividendsGain, format: 'money' },
          'Comisiones (hist.)':      { value: -stats.feesTotal,    format: 'money' },
          'ROI Cartera actual':      { value: latentRoiPct,        format: 'pct' },
          'Rentabilidad Anualizada': {
            value: portfolioCagr,
            format: 'pct',
            // Qué ventana se ha usado, en el idioma del usuario. Sin esto, un
            // CAGR que no cuadra con la cabeza del que lo mira no se puede
            // contrastar con nada.
            note: cagrWindow && portfolioCagr != null
              ? t('cartera.metric_cagr_window', {
                  date: new Date(cagrWindow.start).toLocaleDateString(
                    i18n.language?.startsWith('es') ? 'es-ES' : 'en-GB',
                    { day: 'numeric', month: 'long', year: 'numeric' },
                  ),
                  // Los años invertido no son una cifra de la cartera: se ven siempre.
                  years: formatPlainNumber(cagrWindow.years, 2, 2),
                })
              : null,
            // La cuenta hecha con SUS números: quien divide el TWR entre los
            // años obtiene más y cree que la cifra está mal (caso real:
            // +75,08 % en 1,99 años → +32,45 %, no +37,7 %).
            example: (() => {
              // Con privacidad no se cuenta: lleva el TWR y la anualizada de la cartera.
              const ex = cagrWindow && !privacyMode ? cagrWorkedExample({ cagrPct: portfolioCagr, years: cagrWindow.years }) : null;
              if (!ex) return null;
              const pct = (v) => formatPercent(v, 2, { sign: true });
              const money = (v) => formatMoney(v, preferredCurrency, { decimals: 2 });
              const vars = {
                twr: pct(ex.twrPct), years: formatNumber(cagrWindow.years, 2, 2), avg: pct(ex.naiveAvgPct),
                cagr: pct(portfolioCagr), base: formatMoney(100, preferredCurrency, { decimals: 0 }),
                y1: ex.afterFirstYear != null ? money(ex.afterFirstYear) : null, final: money(ex.final),
              };
              return t(ex.afterFirstYear != null ? 'cartera.metric_cagr_example' : 'cartera.metric_cagr_example_short', vars);
            })(),
          },
          'TWR (Tiempo)':            { value: twrAllTime,          format: 'pct' },
        }}
        preferredCurrency={preferredCurrency}
        maskMoney={maskMoney}
        onClose={() => setExplainingMetric(null)}
      />

      <TransactionModals
        availablePositions={availablePositions}
        manualSale={manualSale} setManualSale={setManualSale}
        manualDividend={manualDividend} setManualDividend={setManualDividend}
        manualCommission={manualCommission} setManualCommission={setManualCommission}
        manualCash={manualCash} setManualCash={setManualCash}
        isAddSaleOpen={isAddSaleOpen} setIsAddSaleOpen={setIsAddSaleOpen}
        isAddDividendOpen={isAddDividendOpen} setIsAddDividendOpen={setIsAddDividendOpen}
        isAddCommissionOpen={isAddCommissionOpen} setIsAddCommissionOpen={setIsAddCommissionOpen}
        isAddCashOpen={isAddCashOpen} setIsAddCashOpen={setIsAddCashOpen}
        isDeleteConfirmOpen={isDeleteConfirmOpen} setIsDeleteConfirmOpen={setIsDeleteConfirmOpen}
        handleSaveManualSale={handleSaveManualSale}
        handleSaveManualDividend={handleSaveManualDividend}
        handleSaveManualCommission={handleSaveManualCommission}
        handleSaveManualCash={handleSaveManualCash}
        confirmDeleteTransaction={confirmDeleteTransaction}
        manualEntryLoading={manualEntryLoading}
        // Sin máscara: en un formulario hay que ver las participaciones o el saldo
        // con el que se opera (quien registra una operación es el propio usuario).
        formatNumber={formatPlainNumber}
        getCurrencySymbol={getCurrencySymbol}
        TODAY={localTodayIso()}
        cashBreakdown={processedImportData.totals.cashBreakdown}
        ALL_CURRENCIES={ALL_CURRENCIES}
      />
    </div>
  );
};

export default CarteraPage;