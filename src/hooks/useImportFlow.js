import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/customSupabaseClient';
import { useToast } from '@/components/ui/use-toast';
import { yahooFinanceService } from '@/services/yahooFinance';
import { eodhdService } from '@/services/eodhd';
import { parseDegiroCSV, auditDegiroLedger, listUnrecognizedDegiroRows } from '@/lib/parsers/degiroParser';
import { parseIBKRCSV } from '@/lib/parsers/ibkrParser';
import { auditMyInvestorLedger } from '@/lib/parsers/myinvestorParser';
import { parseMyInvestorAny } from '@/lib/parsers/myinvestorAny';
import { parseBinanceCSV } from '@/lib/parsers/binanceCsvParser';
import { parseTrading212CSV } from '@/lib/parsers/trading212Parser';
import { extractXlsxRows, rowsToCsv } from '@/lib/xlsxReader';
import { enrichFundRows } from '@/services/import/fundNavEnricher';
import { buildExistingTransMap, DEDUPE_SELECT_FIELDS } from '@/lib/importDedupe';
import { logImportEvent, describeImportError, headerLineOf } from '@/lib/importTelemetry';
import { redactCsvSample } from '@/lib/csvRedact';
import { calculateNetBuys as computeNetBuys } from '@/services/import/netHoldings';
import { computeImportPlan } from '@/services/import/importPlanner';
import { applyImportPlan } from '@/services/import/importExecutor';
import { collectImportAssetRefs, loadExistingAssetsByTicker } from '@/services/import/existingAssets';
import { resolveTicker } from '@/lib/tickerMap';
import { detectOtherBroker } from '@/lib/parsers/brokerDetect';
import { aiHttpErrorMessage } from '@/lib/aiHttpErrorMessage';

const BROKER_LABELS = { degiro: 'DEGIRO', ibkr: 'Interactive Brokers', binance: 'Binance', myinvestor: 'MyInvestor', trading212: 'Trading 212' };

/**
 * Import flow extracted from CarteraPage (fase 2 del split): CSV/XLSX parse
 * routing with ledger audits and telemetry, AI fallback, preview fixes,
 * confirm orchestration and the planner/executor save. State stays in
 * CarteraPage (it is loaded at init, persisted by an effect and consumed by
 * the stats memos) — the hook receives it as named deps, so any missing
 * binding is an eslint no-undef error here, never a silent runtime bug.
 * Handler names are unchanged; the page's JSX wiring stays identical.
 */
export function useImportFlow({
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
}) {
  const { t } = useTranslation();
  const { toast } = useToast();

  // Net holdings live in src/services/import/ (pure, characterization-tested).
  // Asset refs for the save path go through collectImportAssetRefs (broker-aware).
  const calculateNetBuys = (transactions) => computeNetBuys(transactions, importBroker);

  // Parses import TEXT for a given broker and advances the dialog (preview /
  // AI fallback). Component-scope with an explicit broker argument so both the
  // file upload AND the freeform broker-CSV detection can call it (the latter
  // right after setImportBroker, before the state has re-rendered).
  // El lector del broker elegido no entendió el archivo, pero es el export de
  // OTRO broker conocido (p. ej. "Sincronizar" un MyInvestor con el selector
  // en DeGiro): se procesa con su lector nativo en vez de mandarlo a la IA.
  const redirectToDetectedBroker = async (text, broker, sourceMeta) => {
    const detected = detectOtherBroker(text, broker);
    if (!detected) return false;
    setImportBroker(detected);
    toast({
      title: t('cartera.broker_csv_detected_title'),
      description: t('cartera.broker_file_redirect_desc', {
        broker: BROKER_LABELS[detected] || detected,
        selected: BROKER_LABELS[broker] || broker,
      }),
    });
    await processImportText(text, detected, { ...sourceMeta, redirectedFrom: broker });
    return true;
  };

  const processImportText = async (text, broker, sourceMeta = {}) => {
    setIsUploading(true);
      const startedAt = Date.now();
      const rowCount = text.split('\n').filter(l => l.trim()).length;
      // Shared diagnostic context for every telemetry event of this attempt:
      // where the text came from, its header (column names only) and timing.
      const baseDetails = () => ({
        ...sourceMeta,
        headerLine: headerLineOf(text),
        durationMs: Date.now() - startedAt,
      });
      setCsvReportSent(false);
      lastCsvTextRef.current = text; // for the optional anonymized support report
      try {
        let data, ibkrWarnings = [];
        let navStats = null; // "resolved/total" NAV enrichment outcome (myinvestor)
        if (broker === 'ibkr') {
          const result = parseIBKRCSV(text);
          data = result.transactions;
          ibkrWarnings = result.warnings || [];
        } else if (broker === 'myinvestor') {
          // CSV de Operaciones, XLSX de Movimientos o texto copiado de la web:
          // la misma función que usa la detección (ver myinvestorAny.js — hasta
          // el 2026-10-02 el lector del CSV lanzaba antes de probar el de la web
          // y el texto de la pantalla no entraba nunca).
          data = parseMyInvestorAny(text);
          // Movimientos funds arrive without ISIN/units (noQuote, monetary):
          // resolve name → Yahoo fund → NAV at purchase date → real units.
          // Unresolved funds keep the monetary representation. The name→symbol
          // map feeds dynamicTickerMap (persisted) so price refresh and the
          // asset overlay resolve these funds from now on.
          if (data.some(r => r.noQuote)) {
            const { rows: navRows, tickerMap: navMap, resolved: navResolved, total: navTotal } = await enrichFundRows(data, {
              // Re-import determinism: reuse symbols resolved in previous
              // imports (persisted ticker_map) so the same file always yields
              // identical rows and the dedupe actually matches.
              knownSymbols: dynamicTickerMapRef.current || {},
              searchTickers: (q) => yahooFinanceService.searchTickers(q),
              getHistoricalData: (s, r, i) => yahooFinanceService.getHistoricalData(s, r, i),
              getQuote: (s) => yahooFinanceService.getQuote(s),
              // EODHD fallback (only fires for curated ISINs Yahoo can't price;
              // no-ops with a 403 when the user has no EODHD key configured).
              eodhdSearchTickers: (q) => eodhdService.searchTickers(q),
              eodhdGetHistory: async (symbol, range) => {
                const series = await eodhdService.getHistoricalData(symbol, range.toUpperCase());
                // navAtDate needs ISO dates; eodhd rows carry epoch seconds
                return (series || []).map(p => ({
                  time: new Date(p.timestamp * 1000).toISOString().split('T')[0],
                  close: p.close,
                }));
              },
            });
            data = navRows;
            navStats = `${navResolved}/${navTotal}`;
            if (Object.keys(navMap).length > 0) setDynamicTickerMap(prev => ({ ...prev, ...navMap }));
          }
        } else if (broker === 'binance') {
          data = parseBinanceCSV(text);
        } else if (broker === 'trading212') {
          const result = parseTrading212CSV(text);
          data = result.transactions;
          ibkrWarnings = result.warnings || [];
        } else {
          data = parseDegiroCSV(text);
        }

        // DeGiro self-validation: Account.csv is a ledger (every row carries the
        // resulting balance) — reconcile parsed amounts against it, and surface
        // rows no keyword list recognised (they get silently dropped otherwise).
        let audit = null;
        let unrecognized = [];
        if (broker === 'degiro') {
          try { audit = auditDegiroLedger(text); } catch (_) { /* audit is best-effort */ }
          try { unrecognized = listUnrecognizedDegiroRows(text); } catch (_) { /* ditto */ }
        } else if (broker === 'myinvestor') {
          // Movimientos XLSX is a ledger too (Saldo column); null for the Operaciones CSV
          try { audit = auditMyInvestorLedger(text); } catch (_) { /* best-effort */ }
        }
        setImportAudit(audit);
        setUnrecognizedRows(unrecognized);
        const unrecognizedDescs = [...new Set(unrecognized.map(r => r.descripcion))].slice(0, 15);

        // Guard against "successful" empty imports: a foreign-language DeGiro export
        // used to yield only a cash-snapshot row — non-empty, so it sailed into the
        // preview and the user imported an empty portfolio. No real transactions
        // (BUY/SELL/DIVIDEND) means the parser did not understand the file.
        const realTxCount = data.filter(tr => tr.type === 'BUY' || tr.type === 'SELL' || tr.type === 'DIVIDEND').length;

        if ((data.length === 0 || realTxCount === 0) && await redirectToDetectedBroker(text, broker, sourceMeta)) {
          return;
        }
        if (data.length === 0 || realTxCount === 0) {
          // Parser found nothing useful — store raw CSV for AI fallback
          setRawCsvText(text);
          setParseHint(data.length === 0 ? null : t('cartera.parse_no_trades_hint'));
          setAiParseError(null);
          setIbkrParseWarnings([]);
          logImportEvent({ stage: 'parse', broker, ok: false, format: data.length === 0 ? 'empty' : 'no-trades', rows: rowCount, transactions: data.length, buySell: realTxCount, unrecognized: unrecognizedDescs, details: baseDetails() });
        } else {
          setRawCsvText(null);
          setParseHint(null);
          setPendingImportData(data);
          setIbkrParseWarnings(ibkrWarnings);
          setImportStep('preview');
          logImportEvent({ stage: 'parse', broker, ok: true, rows: rowCount, transactions: data.length, buySell: realTxCount, unrecognized: unrecognizedDescs, ...(navStats ? { format: `nav=${navStats}` } : {}), details: { ...baseDetails(), audit: audit ? { checked: audit.checked, matched: audit.matched, mismatches: (audit.mismatches || []).slice(0, 3) } : undefined } });
        }
      } catch (err) {
        console.error('CSV parse error:', err);
        if (err.code === 'degiro_transactions_file') {
          // The user exported DeGiro's OTHER file (Transactions.csv). Explain which
          // one we need and leave the AI fallback available for the file they have.
          setRawCsvText(text);
          setParseHint(t('cartera.degiro_wrong_file_hint'));
          setAiParseError(null);
          setIbkrParseWarnings([]);
          logImportEvent({ stage: 'parse', broker, ok: false, format: 'degiro-transactions-file', rows: rowCount, details: baseDetails() });
        } else if (await redirectToDetectedBroker(text, broker, sourceMeta)) {
          return;
        } else {
          logImportEvent({ stage: 'parse', broker, ok: false, rows: rowCount, error: err.message, details: { ...baseDetails(), ...describeImportError(err) } });
          toast({ variant: 'destructive', title: t('common.error'), description: t('cartera.error_csv_process') });
          // No dejar un callejón sin salida: ofrecer la extracción por IA, igual
          // que cuando el lector no encuentra operaciones. Antes, si el texto
          // venía del diálogo de la IA (detectado como de un broker), ese diálogo
          // ya estaba cerrado y solo quedaba el toast de error.
          setRawCsvText(text);
          setParseHint(t('cartera.parse_failed_ai_hint'));
          setAiParseError(null);
          setIbkrParseWarnings([]);
        }
      } finally {
        setIsUploading(false);
      }
  };

  const handleCsvFileSelected = (file) => {
    if (!file) return;
    setIsUploading(true);

    // XLSX uploads (MyInvestor only exports XLSX for carteras de fondos) are
    // converted to CSV text up front so the ENTIRE existing text pipeline —
    // parsers, ledger audits, AI fallback, anonymized failure reports — works
    // unchanged for any broker.
    const isXlsx = /\.xlsx$/i.test(file.name || '');

    const reader = new FileReader();
    if (isXlsx) {
      reader.onload = async (event) => {
        try {
          const rows = await extractXlsxRows(event.target.result);
          processImportText(rowsToCsv(rows), importBroker, { fileName: file.name, fileSize: file.size, source: 'xlsx' });
        } catch (err) {
          logImportEvent({ stage: 'parse', broker: importBroker, ok: false, format: 'xlsx-unreadable', error: err.message, details: { fileName: file.name, fileSize: file.size, source: 'xlsx', ...describeImportError(err) } });
          toast({ variant: 'destructive', title: t('common.error'), description: t('cartera.error_csv_process') });
          setIsUploading(false);
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      reader.onload = (event) => processImportText(event.target.result, importBroker, { fileName: file.name, fileSize: file.size, source: 'file' });
      reader.readAsText(file);
    }
  };

  // A known broker CSV pasted into the AI import: route it to the native
  // (deterministic, ledger-audited) importer — the LLM would turn FX legs into
  // phantom cash movements, keep GBX ×100 prices, split merged trades…
  const handleFreeformBrokerDetected = (text, broker) => {
    setIsFreeformOpen(false);
    setImportBroker(broker);
    setUploadPhase('file');
    toast({
      title: t('cartera.broker_csv_detected_title'),
      description: t('cartera.broker_csv_detected_desc', { broker: BROKER_LABELS[broker] || broker }),
    });
    processImportText(text, broker, { source: 'ai-import-detect', textChars: text.length });
  };

  // Opt-in: share an anonymized sample of the failing CSV with support so the
  // exact format can be reproduced and fixed. PII is stripped client-side
  // (csvRedact.js) BEFORE anything leaves the browser.
  const handleReportCsv = () => {
    const raw = rawCsvText || lastCsvTextRef.current;
    if (!raw || csvReportSent) return;
    logImportEvent({
      stage: 'parse',
      broker: importBroker,
      ok: false,
      format: 'user-report',
      csvSample: redactCsvSample(raw),
      unrecognized: [...new Set(unrecognizedRows.map(r => r.descripcion))].slice(0, 15),
    });
    setCsvReportSent(true);
    toast({ title: t('cartera.report_sent_title'), description: t('cartera.report_sent_desc') });
  };

  // Apply a single AI-validation fix to one preview row (rowIndex is 1-based:
  // row 1 = CSV header, so parsedData idx = rowIndex - 2).
  const handleFixRow = (rowIndex, field, value) => {
    const idx = rowIndex - 2;
    if (idx < 0 || idx >= pendingImportData.length) return;

    const FIELD_MAP = {
      Price:    'precio',
      Quantity: 'cantidad',
      Date:     'transaction_date',
      ISIN:     'isin',
      Currency: 'moneda',
    };
    const key = FIELD_MAP[field];
    if (!key) return;

    const parsed = (key === 'precio' || key === 'cantidad')
      ? parseFloat(value)
      : value;
    if ((key === 'precio' || key === 'cantidad') && isNaN(parsed)) return;

    setPendingImportData(prev => {
      const updated = [...prev];
      updated[idx] = { ...updated[idx], [key]: parsed };
      return updated;
    });
  };

  // Apply all auto-fixable AI-validation issues at once to the preview data.
  const handleAutoFixIssues = () => {
    const fixable = validationIssues.filter(i => i.autoFixable);
    if (fixable.length === 0) return;

    const fixed = pendingImportData.map(row => {
      const r = { ...row };

      // Date: convert DD-MM-YYYY → YYYY-MM-DD in transaction_date
      if (fixable.some(i => i.field === 'Date' || i.field === 'date')) {
        if (r.transaction_date) {
          const m = r.transaction_date.match(/^(\d{2})-(\d{2})-(\d{4})/);
          if (m) r.transaction_date = `${m[3]}-${m[2]}-${m[1]}T00:00:00`;
        }
        if (r.fecha) {
          const m = r.fecha.match(/^(\d{2})-(\d{2})-(\d{4})$/);
          if (m) r.fecha = `${m[3]}-${m[2]}-${m[1]}`;
        }
      }

      // Number format: fix precio/cantidad by index when suggestion is a number
      fixable
        .filter(i => i.field !== 'Date' && i.field !== 'date' && i.suggestion)
        .forEach(issue => {
          const rowIdx = issue.rowIndex - 2;
          const rowInData = pendingImportData.indexOf(row);
          if (rowIdx !== rowInData) return;
          const num = parseFloat(issue.suggestion.replace(',', '.'));
          if (!isNaN(num)) {
            if (issue.field === 'Quantity' || issue.field === 'cantidad') r.cantidad = num;
            if (issue.field === 'Price' || issue.field === 'precio') r.precio = num;
          }
        });

      return r;
    });

    setPendingImportData(fixed);
    clearIssues();
  };

  // Confirm the preview: kick off the real DB import in the background and wire
  // the loading overlay's onComplete (importFinishRef) to finalize state.
  const handleConfirmImport = () => {
    const dataSnapshot = pendingImportData;
    const brokerSnapshot = selectedBrokerId;

    setIsUploading(true);

    // Kick off the real DB import immediately — runs in background.
    // handleSaveImportedData handles its own errors and returns false: relying on a
    // rejected promise here meant failures still closed the dialog and marked the
    // broker as saved (the error toast drowned under the loading overlay).
    let importOk = false;
    const importPromise = handleSaveImportedData(dataSnapshot)
      .then(ok => { importOk = ok === true; })
      .catch(err => { console.error('Import save error:', err); importOk = false; });

    // finish() is called by the overlay's onComplete (~8s later).
    // By then the real import is almost certainly already done.
    importFinishRef.current = async () => {
      await importPromise;
      setIsUploading(false);
      setImportLoading(false);
      if (!importOk) {
        // Specific toast already shown by handleSaveImportedData. Stay on the
        // preview step so the user can retry — nothing is marked as saved.
        toast({ variant: 'destructive', title: t('common.error'), description: t('cartera.error_save_import') });
        return;
      }
      setImportedTransactionsByBroker(prev => ({ ...prev, [brokerSnapshot]: dataSnapshot }));
      setIsSavedByBroker(prev => ({ ...prev, [brokerSnapshot]: true }));
      setIsImportDialogOpen(false);
      setImportStep('upload');
      setUploadPhase('method');
      setReplaceBrokerData(false);
      setPendingImportData(null);
      clearIssues();
      setVisibleSales(10);
      setVisibleDividends(10);
      setVisibleCommissions(10);
      setVisibleCash(10);
      fetchPricesForImported(dataSnapshot);
    };

    // Show the fake loading overlay (triggers the animation sequence)
    setImportLoading(true);
  };

  const handleAnalyzeWithAI = async () => {
    if (!rawCsvText || aiParsing || importAIExhausted) return;
    setAiParsing(true);
    setAiParseError(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/analyze-csv', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { 'Authorization': `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ csvText: rawCsvText, broker: importBroker }),
        // Long files are processed in sequential chunks spaced by Groq's
        // per-minute token limit — worst case takes a few minutes (same
        // budget as the freeform import).
        signal: AbortSignal.timeout(300_000),
      });

      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        setAiParseError(t(data.reason === 'monthly' ? 'cartera.ai_limit_monthly' : 'cartera.ai_limit_daily'));
        return;
      }

      if (!res.ok) {
        // Sin cuerpo JSON la respuesta no viene del API (proxy sin backend, 502
        // de nginx): "Server 500" no le dice nada al usuario. El 503 del rate
        // limiter trae `service_unavailable` — nunca se muestra crudo.
        const err = await res.json().catch(() => ({}));
        throw new Error(aiHttpErrorMessage({ status: res.status, error: err.error, code: err.code, t }));
      }

      const { transactions, truncated, analyzedRows, failedChunks } = await res.json();

      if (!transactions || transactions.length === 0) {
        setAiParseError(t('cartera.ai_no_transactions'));
        return;
      }

      refreshImportUsage();

      // A partial import that looks complete is worse than a visible warning:
      // warn when the file exceeded the AI's row budget (truncated) or when
      // some fragment failed even after retries (failedChunks).
      if (truncated) {
        toast({ variant: 'warning', title: t('common.warning'), description: t('cartera.ai_truncated_warning', { rows: analyzedRows }) });
      } else if (failedChunks > 0) {
        toast({ variant: 'warning', title: t('common.warning'), description: t('cartera.ai_partial_warning') });
      }

      // Mark rows as AI-parsed so the preview can show a badge
      const marked = transactions.map(row => ({ ...row, isAIParsed: true }));
      setRawCsvText(null);
      setParseHint(null);
      setPendingImportData(marked);
      setImportStep('preview');
    } catch (err) {
      const msg = err.name === 'TimeoutError'
        ? t('cartera.ai_timeout')
        : err.message || t('cartera.ai_unavailable');
      setAiParseError(msg);
    } finally {
      setAiParsing(false);
    }
  };

  // Free-form AI import confirm: rows arrive already mapped to the Trazza schema
  // (freeformMapper.js) and reviewed cell-by-cell by the user in the HITL table.
  // Mirrors the CSV confirm: save to DB, then sync the imported_data JSON copy
  // (deduped — freeform imports are incremental, unlike full-CSV replaces).
  const handleFreeformConfirm = async (trazzaRows) => {
    const brokerSnapshot = selectedBrokerId;
    if (!brokerSnapshot || brokerSnapshot === 'general') {
      toast({ variant: 'destructive', title: t('common.error'), description: t('cartera.error_select_portfolio') });
      return;
    }
    const ok = await handleSaveImportedData(trazzaRows);
    // On failure the error toast is already up — keep the dialog open for retry
    // instead of pretending the import went through.
    if (ok !== true) return;
    const rowKey = (r) => `${r.fecha}_${r.type}_${r.producto}_${Number(r.total || 0).toFixed(2)}`;
    setImportedTransactionsByBroker(prev => {
      const existing = prev[brokerSnapshot] || [];
      const seen = new Set(existing.map(rowKey));
      const fresh = trazzaRows.filter(r => !seen.has(rowKey(r)));
      return { ...prev, [brokerSnapshot]: [...existing, ...fresh] };
    });
    setIsFreeformOpen(false);
    setIsImportDialogOpen(false);
    setImportBroker('degiro'); // restore default so the CSV dropzone routing stays sane
    fetchPricesForImported(trazzaRows);
  };

  // Returns true when the import was fully saved, false otherwise — callers must
  // NOT mark the broker as saved or close the dialog on false.
  const handleSaveImportedData = async (manualData = null) => {
    if (!user || !selectedBrokerId || selectedBrokerId === 'general') {
      toast({ variant: "destructive", title: t('common.error'), description: t('cartera.error_select_portfolio') });
      return false;
    }

    const dataSource = manualData || currentImportedTransactions;
    if (!dataSource || dataSource.length === 0) return false;

    setIsUploading(true);
    try {
      // Find or create a portfolio for the user
      let portfolioId = positions[0]?.portfolio_id;
      if (!portfolioId && brokers.length > 0) {
        // Find existing positions for ANY broker to get portfolioId
        const { data: anyPos } = await supabase.from('positions').select('portfolio_id').limit(1).maybeSingle();
        if (anyPos?.portfolio_id) {
          portfolioId = anyPos.portfolio_id;
        } else {
          const { data: p, error: pErr } = await supabase.from('portfolios').select('id').eq('user_id', user.id).limit(1).maybeSingle();
          if (pErr) console.error("Error fetching portfolio:", pErr);
          portfolioId = p?.id;
        }
      }

      // Brand-new accounts have no portfolios row yet (nothing creates it at signup);
      // the manual add-position flow creates one on demand — the import must too,
      // otherwise the user's very first CSV import dies with a config error.
      if (!portfolioId) {
        const { data: newPortfolio, error: newPortfolioErr } = await supabase.from('portfolios').insert({
          user_id: user.id,
          name: 'Principal'
        }).select().single();
        if (newPortfolioErr || !newPortfolio) {
          toast({ variant: "destructive", title: t('common.error_config'), description: t('cartera.error_portfolio_config') });
          setIsUploading(false);
          return false;
        }
        portfolioId = newPortfolio.id;
      }

      // Replace mode (opt-in on re-sync): wipe this broker's positions and
      // transactions FIRST, then import against a clean slate. This is the
      // one-click repair when past imports left duplicated history (e.g. the
      // same fund imported under two representations — dedupe keys can't
      // reconcile rows whose qty/price changed).
      if (replaceBrokerData) {
        const { data: oldPositions, error: oldPosErr } = await supabase
          .from('positions').select('id').eq('broker_id', selectedBrokerId);
        if (oldPosErr) throw oldPosErr;
        const oldIds = (oldPositions || []).map(p => p.id);
        for (let i = 0; i < oldIds.length; i += 200) {
          const slice = oldIds.slice(i, i + 200);
          const { error: delTransErr } = await supabase.from('transactions').delete().in('position_id', slice);
          if (delTransErr) throw delTransErr;
          const { error: delPosErr } = await supabase.from('positions').delete().in('id', slice);
          if (delPosErr) throw delPosErr;
        }
        logImportEvent({ stage: 'save', broker: importBroker, ok: true, format: `replace-wiped=${oldIds.length}` });
      }

      // AUDIT RULE: "Sincronizar Datos" - Maintain historical transactions for accurate Realized Gain.
      // We no longer delete all data. Instead, we mark existing positions as 0 Qty if they aren't in the new file.
      // entry_price is needed by the planner's cost-basis guard (a price-0
      // in-kind transfer must not zero a known BEP).
      // assets(ticker,currency,asset_class): the planner resolves cash by the
      // broker's existing cash POSITION (findCashPosition), not only by asset ref.
      const { data: existingPositions, error: existingPosErr } = await supabase.from('positions')
        .select('id, asset_id, entry_price, quantity, broker_id, assets(ticker, currency, asset_class)')
        .eq('broker_id', selectedBrokerId);
      // A failed read here would create duplicate positions further down — abort.
      if (existingPosErr) throw existingPosErr;

      // Fetch existing transactions to avoid duplicates. The field list MUST stay in
      // sync with transCheckKey (src/lib/importDedupe.js): omitting total_amount made
      // every re-import duplicate all DIVIDEND/FEE/TAX/CASH/TRANSFER rows, because the
      // "existing" side of the key was always 0.00.
      const { data: existingTrans, error: existingTransErr } = await supabase.from('transactions')
        .select(DEDUPE_SELECT_FIELDS)
        .in('position_id', existingPositions?.map(p => p.id) || []);
      // If this read fails we'd proceed with an empty dedupe set and re-insert the
      // whole history — abort instead.
      if (existingTransErr) throw existingTransErr;
      // MULTISET key → existing rows so buildTransactionRows can dedupe + backfill.
      // Must be a multiset: identical partial fills are distinct real trades.
      const existingTransMap = buildExistingTransMap(existingTrans || []);

      // 1. Net holdings + mutation plan (pure — services/import/importPlanner)
      const netBuys = manualData ? calculateNetBuys(manualData) : processedImportData.netBuys;

      const stocksToSave = netBuys.filter(n => n.type !== 'CASH');
      const cashToSave = netBuys.filter(n => n.type === 'CASH');

      const currentBroker = (brokers || []).find(b => b.id === selectedBrokerId);

      if (netBuys.length === 0) {
        // This branch used to fail silently (no telemetry) — the Kraken in-kind
        // deposit bug hid here for a whole debugging session.
        logImportEvent({ stage: 'save', broker: importBroker, ok: false, format: 'no-net-holdings', transactions: dataSource.length, details: { replaceMode: replaceBrokerData, types: [...new Set(dataSource.map(r => r.type))] } });
        toast({ variant: 'warning', title: t('common.no_data'), description: t('cartera.no_assets_for_broker', { name: currentBroker?.name || selectedBrokerId }) });
        setIsUploading(false);
        return false;
      }

      toast({
        title: t('cartera.importing_for', { name: currentBroker?.name || 'Broker' }),
        description: t('cartera.importing_desc', { stocks: stocksToSave.length, cash: cashToSave.length })
      });

      // Batch-fetch the assets the plan may reference (one query per 100 tickers
      // instead of the old one-SELECT-per-asset loop). Refs come from the same
      // pure helper the tests use — broker-aware dbTicker + cash aliases + twins.
      const candidateRefs = collectImportAssetRefs({
        netBuys,
        dataSource,
        broker: importBroker,
      });

      const existingAssetsByTicker = await loadExistingAssetsByTicker({
        supabase,
        refs: candidateRefs,
        assetIds: (existingPositions || []).map(p => p.asset_id),
      });

      const plan = computeImportPlan({
        dataSource,
        netBuys,
        broker: importBroker,
        existingPositions,
        existingAssetsByTicker,
        dynamicTickerMap,
        importPrices,
        resolveTickerFn: resolveTicker,
      });
      plan.skipped.forEach(s => console.warn(`[import] Skipping asset with malformed ISIN: "${s.isin}"`));

      // Un fondo ya guardado en la OTRA representación (euros ↔ participaciones)
      // se contaría dos veces: la posición vieja no se cierra y su historial se
      // suma al nuevo. Sin el modo reemplazo, no se guarda nada y se explica.
      if (plan.representationConflicts.length > 0) {
        const funds = plan.representationConflicts.map(c => c.name).join(', ');
        logImportEvent({ stage: 'save', broker: importBroker, ok: false, format: 'representation-conflict', details: { conflicts: plan.representationConflicts.length, replaceMode: replaceBrokerData } });
        toast({
          variant: 'destructive',
          title: t('cartera.fund_representation_conflict_title'),
          description: t('cartera.fund_representation_conflict_desc', { funds }),
          duration: 15000,
        });
        return false;
      }

      // 2. Execute the plan (batched I/O — services/import/importExecutor)
      const { insertedCount, patchedCount } = await applyImportPlan({
        plan,
        dataSource,
        broker: importBroker,
        brokerId: selectedBrokerId,
        portfolioId,
        existingTransMap,
        supabase,
      });

      // Delta summary toast — lets the user know exactly what changed on re-imports.
      const unchangedCount = Math.max(0, (existingTrans?.length || 0) - patchedCount);
      logImportEvent({ stage: 'save', broker: importBroker, ok: true, transactions: insertedCount, format: `inserted=${insertedCount};patched=${patchedCount};unchanged=${unchangedCount}`, details: { replaceMode: replaceBrokerData, plan: Object.fromEntries(Object.entries(plan).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length])), existingPositions: existingPositions?.length ?? 0, existingTransactions: existingTrans?.length ?? 0 } });
      if (insertedCount === 0 && patchedCount === 0) {
        toast({ title: t('cartera.import_done_title'), description: t('cartera.import_done_uptodate') });
      } else {
        toast({
          title: t('cartera.import_done_title'),
          description: t('cartera.import_done_summary', { inserted: insertedCount, patched: patchedCount, unchanged: unchangedCount }),
        });
      }

      setIsSavedByBroker(prev => ({ ...prev, [selectedBrokerId]: true }));
      // Load fresh positions first, then refresh prices with the updated data.
      // Calling refreshPrices() before loadPositions used stale state and missed
      // positions that were just created/updated by the import.
      await loadPositions(selectedBrokerId, true);
      return true;
    } catch (error) {
      console.error("Error saving import:", error);
      logImportEvent({ stage: 'save', broker: importBroker, ok: false, error: error.message, details: { replaceMode: replaceBrokerData, ...describeImportError(error) } });
      toast({
        variant: "destructive",
        title: t('common.error_save'),
        description: t('cartera.error_save_import_desc', { message: error.message || '' })
      });
      // Positions/assets were already upserted before the failing transaction insert:
      // reload so the table reflects the saved state instead of appearing empty until
      // the user manually refreshes the page.
      try { await loadPositions(selectedBrokerId, true); } catch (_) { /* keep original error */ }
      return false;
    } finally {
      setIsUploading(false);
    }
  };
  return {
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
  };
}
