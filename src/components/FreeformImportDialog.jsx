import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import {
  Sparkles, Loader2, Trash2, AlertTriangle, CheckCircle2, ArrowLeft, UploadCloud,
  Image as ImageIcon, X,
} from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { supabase } from '@/lib/customSupabaseClient';
import { validateFreeformRow, freeformToTrazza, resolveMissingTickers, FREEFORM_TYPES } from '@/lib/parsers/freeformMapper';
import { auditFreeformRows } from '@/lib/parsers/freeformAudit';
import { detectBrokerCsv } from '@/lib/parsers/brokerDetect';
import { extractXlsxRows, rowsToCsv } from '@/lib/xlsxReader';
import { yahooFinanceService } from '@/services/yahooFinance';
import { fileToImageDataUrls, isVisualFile } from '@/lib/fileToImages';
import { logImportEvent, headerLineOf } from '@/lib/importTelemetry';
import { aiHttpErrorMessage } from '@/lib/aiHttpErrorMessage';

const MAX_IMAGES = 8; // hard cap on image pages sent to the vision model per import

const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD', 'JPY'];

const inputBase =
  'w-full bg-transparent text-[12px] font-medium text-slate-800 dark:text-slate-100 rounded-lg px-2 py-1.5 border outline-hidden transition-colors focus:border-blue-400 dark:focus:border-blue-500';
const okBorder  = 'border-transparent hover:border-slate-200 dark:hover:border-slate-700';
const badBorder = 'border-amber-400/70 bg-amber-50/60 dark:bg-amber-900/15';

/**
 * Free-form AI import dialog — the 4-step UX:
 *   1. paste chaotic text / drop text files
 *   2. "Trazza AI is analysing…" animation
 *   3. editable spreadsheet-like review table (Human-in-the-Loop)
 *   4. "Confirmar e Importar" → onConfirm(trazzaRows)
 *
 * Extraction happens in /api/parse-freeform (neutral schema); the
 * deterministic mapping to the internal schema lives in freeformMapper.js.
 */
const FreeformImportDialog = ({
  open,
  onOpenChange,
  onConfirm,
  onBrokerCsvDetected,
  isSaving = false,
  dailyLeft = Infinity,
  exhausted = false,
  onAnalyzed,
}) => {
  const { t } = useTranslation();
  const [step, setStep] = useState('input'); // 'input' | 'analyzing' | 'review'
  const [text, setText] = useState('');
  const [images, setImages] = useState([]);  // [{ id, name, dataUrl }] for the vision model
  const [processingFiles, setProcessingFiles] = useState(false);
  const [rows, setRows] = useState([]);      // neutral rows, edited in place
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  // Dos orígenes para la misma señal ámbar: lo que FALTA (validateFreeformRow)
  // y lo que no cuadra con el texto pegado (auditFreeformRows, en `unverified`).
  // Las dos bloquean el import: un importe que no aparece en el origen es justo
  // el fallo que no se ve mirando la tabla, así que tiene que pasar por delante
  // de una persona.
  const issuesByRow = useMemo(
    () => rows.map(r => [...new Set([...validateFreeformRow(r), ...(r.unverified || [])])]),
    [rows]
  );
  const pendingCount = issuesByRow.filter(i => i.length > 0).length;
  const readyCount = rows.length - pendingCount;

  // ── Telemetría (2026-10-02) ───────────────────────────────────────────────
  // Este camino no registraba NADA: un usuario real lo intentó 6 veces en tres
  // meses sin conseguir importar y no quedó ni una fila en import_logs. Cada
  // intento acaba ahora en un evento con el MOTIVO; nunca con el contenido
  // (recuentos y la primera línea ya saneada por redactHeaderLine).
  const analyzeStartRef = useRef(0);
  const confirmedRef = useRef(false);
  const logAi = (ok, { stage = 'parse', format, error: errMsg, transactions, details } = {}) => {
    const cleanText = text.replace(/^--- .+ ---\r?$/gm, '').trim();
    logImportEvent({
      stage, broker: 'freeform', ok, format, error: errMsg, transactions,
      details: {
        source: 'ai',
        inputKind: images.length ? (cleanText ? 'text+images' : 'images') : 'text',
        textChars: cleanText.length,
        images: images.length,
        headerLine: cleanText ? headerLineOf(cleanText) : undefined,
        durationMs: analyzeStartRef.current ? Date.now() - analyzeStartRef.current : undefined,
        ...details,
      },
    });
  };

  const reset = () => {
    setStep('input'); setText(''); setImages([]); setRows([]); setError(null);
    confirmedRef.current = false;
    analyzeStartRef.current = 0;
  };

  // The parent may close via the `open` prop (e.g. after a confirmed import) —
  // Radix only fires onOpenChange for user-driven closes, so reset here too.
  useEffect(() => { if (!open) reset(); }, [open]);

  const handleOpenChange = (v) => {
    // Cerrar con la tabla de revisión delante y sin confirmar = abandono: la
    // IA extrajo filas y aun así la persona se fue. Es el punto donde se pierde
    // gente y no se veía.
    if (!v && step === 'review' && !confirmedRef.current) {
      logAi(false, { stage: 'abandon', format: `review rows=${rows.length} pending=${pendingCount}`, transactions: rows.length });
    }
    if (!v) reset();
    onOpenChange(v);
  };

  const removeImage = (id) => setImages(prev => prev.filter(im => im.id !== id));

  const appendFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setError(null);

    const isXlsx = (f) => /\.xlsx$/i.test(f.name || '');
    const xlsxFiles   = files.filter(isXlsx);
    const textFiles   = files.filter(f => !isVisualFile(f) && !isXlsx(f));
    const visualFiles = files.filter(f => isVisualFile(f) && !isXlsx(f));

    // XLSX: binary — convert to CSV text with the dependency-free reader
    // (reading it with f.text() would paste ZIP garbage into the box).
    if (xlsxFiles.length) {
      for (const f of xlsxFiles) {
        try {
          const csvText = rowsToCsv(await extractXlsxRows(await f.arrayBuffer()));
          if (csvText.trim()) {
            const block = `--- ${f.name} ---\n${csvText}`;
            setText(prev => (prev ? `${prev}\n\n${block}` : block));
          }
        } catch (e) {
          setError(t('freeform_import.file_error'));
          logAi(false, { format: 'file-unreadable', error: e?.message, details: { fileKind: 'xlsx', fileSize: f.size } });
        }
      }
    }

    // Plain text/CSV files: concatenate into the paste box (existing flow)
    if (textFiles.length) {
      const parts = await Promise.all(textFiles.map(f => f.text().catch(() => '')));
      const joined = textFiles.map((f, i) => `--- ${f.name} ---\n${parts[i]}`).join('\n\n');
      if (joined.trim()) setText(prev => (prev ? `${prev}\n\n${joined}` : joined));
    }

    // Images / PDFs: rasterise to JPEG data-URLs for the vision model
    if (visualFiles.length) {
      setProcessingFiles(true);
      try {
        for (const f of visualFiles) {
          const dataUrls = await fileToImageDataUrls(f);
          setImages(prev => {
            const room = MAX_IMAGES - prev.length;
            if (room <= 0) return prev;
            const additions = dataUrls.slice(0, room).map((dataUrl, i) => ({
              id: `${f.name}-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
              name: dataUrls.length > 1 ? `${f.name} · ${i + 1}` : f.name,
              dataUrl,
            }));
            return [...prev, ...additions];
          });
        }
      } catch (e) {
        console.error('[freeform-import] file processing failed:', e);
        setError(t('freeform_import.file_error'));
        logAi(false, { format: 'file-unreadable', error: e?.message, details: { fileKind: 'visual' } });
      } finally {
        setProcessingFiles(false);
      }
    }
  };

  const hasInput = text.trim().length > 0 || images.length > 0;

  const analyze = async () => {
    if (!hasInput || step === 'analyzing' || exhausted || processingFiles) return;

    // Pasted text that IS a known broker export: route it to the native
    // deterministic importer instead of the LLM — exact result (merged FX
    // legs, GBX prices, fees, ledger audit) and zero AI quota spent.
    // The "--- file.csv ---" separators appendFiles adds (context for the LLM)
    // are stripped first — a parser must never see them as data.
    if (!images.length && onBrokerCsvDetected) {
      try {
        const cleanText = text.replace(/^--- .+ ---\r?$/gm, '').trim();
        const detected = detectBrokerCsv(cleanText);
        if (detected) {
          onBrokerCsvDetected(cleanText, detected.broker);
          return;
        }
      } catch (_) { /* detection is best-effort — fall through to the LLM */ }
    }

    setStep('analyzing');
    setError(null);
    analyzeStartRef.current = Date.now();
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/parse-freeform', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ text, images: images.map(im => im.dataUrl) }),
        // Large pastes are processed in sequential chunks spaced by Groq's
        // per-minute token limit — worst case takes a few minutes.
        signal: AbortSignal.timeout(300_000),
      });

      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        throw Object.assign(
          new Error(t(data.reason === 'monthly' ? 'cartera.ai_limit_monthly' : 'cartera.ai_limit_daily')),
          { telemetryFormat: data.reason === 'monthly' ? 'quota-monthly' : 'quota-daily' },
        );
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const msg = aiHttpErrorMessage({ status: res.status, error: err.error, code: err.code, t });
        throw Object.assign(new Error(msg), { telemetryFormat: `http-${res.status}` });
      }

      const { transactions } = await res.json();
      // A 200 means the server consumed one unit of quota (it increments on any
      // successful parse, even when no rows are found) — refresh the counter.
      onAnalyzed?.();
      if (!transactions?.length) {
        setError(t('freeform_import.no_transactions'));
        setStep('input');
        logAi(false, { format: 'no-transactions', transactions: 0 });
        return;
      }
      // Rows where the AI only extracted the asset NAME: resolve the ticker by
      // quote search instead of making the user type it (Yahoo search only —
      // never marketDataService, whose EODHD fallback has a tiny daily quota).
      // Unresolvable names simply stay pending in the review table.
      const withTickers = await resolveMissingTickers(
        transactions,
        (q) => yahooFinanceService.searchTickers(q)
      );
      // Contraste determinista contra el texto original: el modelo puede
      // emparejar una descripción con el importe del grupo de al lado y eso no
      // se distingue a simple vista en la tabla.
      const audited = auditFreeformRows(withTickers, text);
      setRows(audited);
      setStep('review');
      const pending = audited.filter(r => validateFreeformRow(r).length > 0 || (r.unverified || []).length > 0).length;
      logAi(true, { format: `review pending=${pending}/${audited.length}`, transactions: audited.length });
    } catch (err) {
      setError(err.name === 'TimeoutError' ? t('cartera.ai_timeout') : (err.message || t('cartera.ai_unavailable')));
      setStep('input');
      logAi(false, {
        format: err.telemetryFormat || (err.name === 'TimeoutError' ? 'timeout' : 'network'),
        error: err.message,
      });
    }
  };

  const updateRow = (idx, field, value) => {
    // Tocar la celda ES la revisión humana: retira ese campo de `unverified`
    // (aunque se reescriba el mismo número — eso es confirmarlo a conciencia).
    setRows(prev => prev.map((r, i) => (i === idx
      ? { ...r, [field]: value, unverified: (r.unverified || []).filter(f => f !== field) }
      : r)));
  };
  const updateRowNumber = (idx, field, value) => {
    const n = value === '' ? null : Number(value);
    updateRow(idx, field, Number.isFinite(n) ? n : null);
  };
  const removeRow = (idx) => setRows(prev => prev.filter((_, i) => i !== idx));

  const confirm = () => {
    if (pendingCount > 0 || rows.length === 0 || isSaving) return;
    confirmedRef.current = true;   // el guardado lo registra el padre (stage 'save')
    onConfirm(freeformToTrazza(rows));
  };

  const cellClass = (rowIdx, field) =>
    `${inputBase} ${issuesByRow[rowIdx]?.includes(field) ? badBorder : okBorder}`;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className={`${step === 'review' ? 'max-w-4xl' : 'max-w-lg'} dark:bg-slate-900 border-none p-0 flex flex-col max-h-[90vh] overflow-hidden transition-all`}>
        <div className="h-[3px] w-full shrink-0 bg-linear-to-r from-violet-500 to-fuchsia-500" />

        {/* Header */}
        <div className="px-6 pt-5 pb-4 border-b border-slate-100 dark:border-slate-800 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-violet-50 dark:bg-violet-900/25 rounded-xl">
              <Sparkles className="w-4 h-4 text-violet-500" />
            </div>
            <div>
              <h2 className="text-base font-black text-slate-900 dark:text-white tracking-tight">
                {t('freeform_import.dialog_title')}
              </h2>
              <p className="text-[11px] text-slate-400 font-medium">
                {step === 'review' ? t('freeform_import.review_hint') : t('freeform_import.dialog_subtitle')}
              </p>
            </div>
          </div>
        </div>

        {/* ── Step 1: chaotic input ── */}
        {step === 'input' && (
          <div className="p-6 space-y-4 overflow-y-auto">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={10}
              placeholder={t('freeform_import.paste_placeholder')}
              className="w-full rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/50 p-3.5 text-[12px] font-mono text-slate-800 dark:text-slate-100 placeholder:text-slate-400 outline-hidden focus:border-violet-400 dark:focus:border-violet-500 transition-colors resize-y"
            />

            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={processingFiles || images.length >= MAX_IMAGES}
              className="w-full flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-200 dark:border-slate-700 py-3 text-[11px] font-bold text-slate-500 dark:text-slate-400 hover:border-violet-300 dark:hover:border-violet-700 hover:text-violet-600 dark:hover:text-violet-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {processingFiles
                ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />{t('freeform_import.processing_files')}</>
                : <><UploadCloud className="w-3.5 h-3.5" />{t('freeform_import.or_upload')}</>}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".csv,.txt,.tsv,.xlsx,.pdf,.png,.jpg,.jpeg,.webp,text/plain,text/csv,application/pdf,image/*"
              className="hidden"
              onChange={(e) => { appendFiles(e.target.files); e.target.value = ''; }}
            />

            {/* Attached image / PDF-page previews */}
            {images.length > 0 && (
              <div className="grid grid-cols-4 gap-2">
                {images.map((im) => (
                  <div key={im.id} className="relative group rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700 aspect-square bg-slate-50 dark:bg-slate-800">
                    <img src={im.dataUrl} alt={im.name} className="w-full h-full object-cover" />
                    <button
                      onClick={() => removeImage(im.id)}
                      title={t('freeform_import.remove_image')}
                      className="absolute top-1 right-1 p-0.5 rounded-md bg-black/60 text-white opacity-0 group-hover:opacity-100 hover:bg-black/80 transition-opacity"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <p className="text-[10px] text-slate-400 leading-relaxed flex gap-1.5">
              <ImageIcon className="w-3 h-3 shrink-0 mt-0.5" />
              {t('freeform_import.files_hint')}
            </p>

            {error && (
              <div className="flex items-start gap-2 rounded-xl bg-red-50 dark:bg-red-900/15 border border-red-200 dark:border-red-800/40 px-3.5 py-2.5">
                <AlertTriangle className="w-3.5 h-3.5 text-red-500 shrink-0 mt-0.5" />
                <p className="text-[11px] font-semibold text-red-600 dark:text-red-400">{error}</p>
              </div>
            )}

            {exhausted ? (
              <div className="flex items-start gap-2 rounded-xl bg-rose-50 dark:bg-rose-900/15 border border-rose-200 dark:border-rose-800/40 px-3.5 py-2.5">
                <AlertTriangle className="w-3.5 h-3.5 text-rose-500 shrink-0 mt-0.5" />
                <div className="space-y-1.5">
                  <p className="text-[11px] font-bold text-rose-600 dark:text-rose-400">{t('freeform_import.limit_reached')}</p>
                  <p className="text-[10px] text-rose-500/90 dark:text-rose-300/80 leading-relaxed">{t('freeform_import.limit_hint')}</p>
                </div>
              </div>
            ) : Number.isFinite(dailyLeft) && (
              <p className="flex items-center justify-end gap-1.5 text-[10px] font-semibold text-slate-400">
                <span className={`px-2 py-0.5 rounded-full ${dailyLeft <= 2 ? 'bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400' : 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400'}`}>
                  {t('ai_usage.remaining', { n: dailyLeft })}
                </span>
              </p>
            )}

            <button
              onClick={analyze}
              disabled={!hasInput || exhausted || processingFiles}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-linear-to-r from-violet-600 to-fuchsia-600 hover:from-violet-700 hover:to-fuchsia-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold py-3 shadow-lg shadow-violet-500/25 transition-all"
            >
              <Sparkles className="w-4 h-4" />
              {t('freeform_import.analyze_btn')}
            </button>
          </div>
        )}

        {/* ── Step 2: analyzing animation ── */}
        {step === 'analyzing' && (
          <div className="p-10 flex flex-col items-center justify-center gap-4 text-center">
            <motion.div
              animate={{ scale: [1, 1.12, 1] }}
              transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
              className="relative p-5 bg-violet-50 dark:bg-violet-900/25 rounded-3xl"
            >
              <Sparkles className="w-8 h-8 text-violet-500" />
              <Loader2 className="w-[72px] h-[72px] text-violet-300 dark:text-violet-700 animate-spin absolute -top-1 -left-1" strokeWidth={1} />
            </motion.div>
            <div>
              <p className="text-sm font-black text-slate-900 dark:text-white">{t('freeform_import.analyzing_title')}</p>
              <p className="text-[11px] text-slate-400 font-medium mt-1">{t('freeform_import.analyzing_hint')}</p>
            </div>
          </div>
        )}

        {/* ── Step 3: editable review table (Human-in-the-Loop) ── */}
        {step === 'review' && (
          <>
            <div className="flex-1 overflow-auto px-4 py-3">
              <table className="w-full border-separate border-spacing-0 min-w-[760px]">
                <thead>
                  <tr>
                    {['col_date', 'col_type', 'col_ticker', 'col_asset', 'col_qty', 'col_price', 'col_amount', 'col_currency', ''].map((k, i) => (
                      <th key={i} className="sticky top-0 bg-white dark:bg-slate-900 text-left text-[9px] font-black text-slate-400 uppercase tracking-widest px-2 py-2 border-b border-slate-100 dark:border-slate-800">
                        {k ? t(`freeform_import.${k}`) : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, idx) => {
                    const issues = issuesByRow[idx];
                    return (
                      <tr key={idx} className={issues.length ? 'bg-amber-50/40 dark:bg-amber-900/5' : ''} title={r.sourceLine || undefined}>
                        <td className="px-1 py-0.5 w-[130px]">
                          <input type="date" value={r.date || ''} onChange={(e) => updateRow(idx, 'date', e.target.value || null)} className={cellClass(idx, 'date')} />
                        </td>
                        <td className="px-1 py-0.5 w-[110px]">
                          <select value={r.type} onChange={(e) => updateRow(idx, 'type', e.target.value)} className={`${cellClass(idx, 'type')} dark:bg-slate-900`}>
                            {FREEFORM_TYPES.map(ty => <option key={ty} value={ty}>{t(`freeform_import.type_${ty.toLowerCase()}`)}</option>)}
                          </select>
                        </td>
                        <td className="px-1 py-0.5 w-[100px]">
                          <input value={r.ticker || ''} placeholder="AAPL" onChange={(e) => updateRow(idx, 'ticker', e.target.value.toUpperCase() || null)} className={`${cellClass(idx, 'ticker')} font-mono`} />
                        </td>
                        <td className="px-1 py-0.5 min-w-[140px]">
                          <input value={r.assetName || ''} onChange={(e) => updateRow(idx, 'assetName', e.target.value || null)} className={cellClass(idx, 'assetName')} />
                        </td>
                        <td className="px-1 py-0.5 w-[90px]">
                          <input type="number" step="any" min="0" value={r.quantity ?? ''} onChange={(e) => updateRowNumber(idx, 'quantity', e.target.value)} className={`${cellClass(idx, 'quantity')} tabular-nums text-right`} />
                        </td>
                        <td className="px-1 py-0.5 w-[100px]">
                          <input type="number" step="any" min="0" value={r.price ?? ''} onChange={(e) => updateRowNumber(idx, 'price', e.target.value)} className={`${cellClass(idx, 'price')} tabular-nums text-right`} />
                        </td>
                        <td className="px-1 py-0.5 w-[100px]">
                          <input
                            type="number" step="any" min="0"
                            value={r.amount ?? ''}
                            onChange={(e) => updateRowNumber(idx, 'amount', e.target.value)}
                            title={r.unverified?.includes('amount') ? t('freeform_import.amount_unverified') : undefined}
                            className={`${cellClass(idx, 'amount')} tabular-nums text-right`}
                          />
                        </td>
                        <td className="px-1 py-0.5 w-[80px]">
                          <select value={r.currency || ''} onChange={(e) => updateRow(idx, 'currency', e.target.value || null)} className={`${cellClass(idx, 'currency')} dark:bg-slate-900`}>
                            <option value="">—</option>
                            {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                            {r.currency && !CURRENCIES.includes(r.currency) && <option value={r.currency}>{r.currency}</option>}
                          </select>
                        </td>
                        <td className="px-1 py-0.5 w-[36px]">
                          <button onClick={() => removeRow(idx)} className="p-1.5 rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/15 transition-colors" title={t('freeform_import.remove_row')}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Footer: status + actions */}
            <div className="px-6 py-4 border-t border-slate-100 dark:border-slate-800 shrink-0 flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex items-center gap-3 flex-1 text-[11px] font-bold">
                <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {t('freeform_import.rows_ready', { count: readyCount })}
                </span>
                {pendingCount > 0 && (
                  <span className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    {t('freeform_import.rows_pending', { count: pendingCount })}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setStep('input')}
                  className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-xs font-bold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  {t('freeform_import.back_btn')}
                </button>
                <button
                  onClick={confirm}
                  disabled={pendingCount > 0 || rows.length === 0 || isSaving}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold shadow-lg shadow-emerald-500/25 transition-all"
                >
                  {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                  {t('freeform_import.confirm_btn')}
                </button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default FreeformImportDialog;
