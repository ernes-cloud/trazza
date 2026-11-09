/**
 * POST /api/log-import
 *
 * Client-side import telemetry. The CSV import runs entirely in the browser
 * against Supabase, so without this endpoint failed imports leave no trace on
 * the server and user complaints are impossible to diagnose. The client fires
 * one event per parse attempt and per save attempt (fire-and-forget).
 *
 * Body (JSON):
 *   {
 *     stage:  'parse' | 'save',
 *     broker: string,          // 'degiro' | 'ibkr' | 'binance' | 'myinvestor' | 'freeform'
 *     ok:     boolean,
 *     format?: string,         // detected format hint (e.g. 'transactions-file', 'empty')
 *     rows?: number,           // raw CSV lines
 *     transactions?: number,   // parsed transactions
 *     buySell?: number,        // parsed BUY/SELL/DIVIDEND rows (0 with rows>0 = format not understood)
 *     error?: string,
 *     unrecognized?: string[], // distinct unrecognized row descriptions (missing keywords)
 *     csvSample?: string,      // anonymized CSV sample — ONLY with explicit user consent
 *     details?: object,        // free-form diagnostic context: errorCode/errorStack,
 *                              // fileName/fileSize/source, headerLine, durationMs,
 *                              // audit summary, save-plan counts… (capped at 8 KB)
 *   }
 *
 * Events go to the live admin log buffer (Admin → Logs, service 'import') AND
 * are persisted to the import_logs table (survives restarts; powers the
 * success-rate metric). Persistence is best-effort: if Supabase is not
 * configured (local dev) the buffer still works.
 */

import { addLog } from '../lib/logBuffer.js';
import { supabaseAdmin } from '../lib/adminSupabase.js';
import { redactHeaderLine } from '../../src/lib/headerLineRedact.js';

// Las pruebas desde `npm run dev` escriben en la MISMA Supabase que producción
// (el server local apunta a ella): sin marcar el origen, la telemetría mezcla
// tus pruebas con usuarios reales y el panel de salud de imports miente. Se
// deduce del Origin/Referer de la petición, que el navegador pone solo.
const envOf = (req) => (/\/\/(localhost|127\.0\.0\.1)(:\d+)?\b/.test(`${req.headers.origin || ''} ${req.headers.referer || ''}`) ? 'dev' : 'prod');

// 'abandon': el usuario llegó a la revisión de la importación por IA y cerró
// sin guardar (2026-10-02). El panel de salud solo cuenta 'parse' y 'save'.
const STAGES = new Set(['parse', 'save', 'abandon']);
const MAX_SAMPLE_CHARS = 20_000;
const MAX_UNRECOGNIZED = 15;
const MAX_DETAILS_CHARS = 8_000;

const cleanStr = (v, max = 120) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const cleanNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);

// Free-form diagnostic object from the client. Kept as-is when it fits the
// budget; oversized payloads are truncated but never dropped (a cut stack
// trace beats no stack trace).
const cleanDetails = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  // Segunda pasada en el server: el endpoint es público y un cliente viejo (o
  // uno manual) puede mandar la primera línea sin limpiar — el XLSX de
  // MyInvestor la empieza con el nombre del titular.
  if (typeof v.headerLine === 'string') v = { ...v, headerLine: redactHeaderLine(v.headerLine) };
  try {
    const json = JSON.stringify(v);
    if (json.length <= MAX_DETAILS_CHARS) return v;
    return { _truncated: true, raw: json.slice(0, MAX_DETAILS_CHARS) };
  } catch (_) {
    return undefined;
  }
};

export async function logImport(req, res) {
  const { stage, broker, ok, format, rows, transactions, buySell, error, unrecognized, csvSample, details } = req.body || {};

  if (!STAGES.has(stage)) {
    return res.status(400).json({ error: 'stage must be "parse" or "save"' });
  }

  const meta = {
    stage,
    broker: cleanStr(broker, 30) || 'unknown',
    format: cleanStr(format, 60),
    rows: cleanNum(rows),
    transactions: cleanNum(transactions),
    buySell: cleanNum(buySell),
    // 300 chars: DB/Supabase error messages carry the constraint/column name
    // well past the old 120 cut
    error: cleanStr(error, 300),
    unrecognized: Array.isArray(unrecognized)
      ? unrecognized.slice(0, MAX_UNRECOGNIZED).map(d => cleanStr(String(d), 80)).filter(Boolean)
      : undefined,
    hasSample: typeof csvSample === 'string' && csvSample.length > 0,
    details: { ...(cleanDetails(details) || {}), env: envOf(req) },
  };

  const level = ok === false ? 'error' : 'ok';
  const d = meta.details || {};
  const parts = [
    `CSV ${stage}`,
    `broker=${meta.broker}`,
    meta.format ? `format=${meta.format}` : null,
    meta.rows != null ? `rows=${meta.rows}` : null,
    meta.transactions != null ? `tx=${meta.transactions}` : null,
    meta.buySell != null ? `buySell=${meta.buySell}` : null,
    d.source ? `source=${d.source}` : null,
    d.fileName ? `file=${cleanStr(String(d.fileName), 60)}` : null,
    d.durationMs != null ? `took=${d.durationMs}ms` : null,
    d.errorCode ? `code=${d.errorCode}` : null,
    meta.error ? `error=${meta.error}` : null,
    meta.hasSample ? 'sample=yes' : null,
  ].filter(Boolean);

  addLog(level, 'import', parts.join(' · '), meta);

  // Persist (best-effort — never block or fail the response over telemetry)
  if (supabaseAdmin) {
    try {
      const row = {
        stage,
        broker: meta.broker,
        ok: ok !== false,
        format: meta.format ?? null,
        rows: meta.rows ?? null,
        transactions: meta.transactions ?? null,
        buy_sell: meta.buySell ?? null,
        error: meta.error ?? null,
        unrecognized: meta.unrecognized?.length ? meta.unrecognized : null,
        csv_sample: meta.hasSample ? String(csvSample).slice(0, MAX_SAMPLE_CHARS) : null,
        details: meta.details ?? null,
      };
      let { error: insErr } = await supabaseAdmin.from('import_logs').insert(row);
      // details column not migrated yet → keep the event, drop only the extra
      if (insErr && /details/i.test(insErr.message || '')) {
        const { details: _omit, ...withoutDetails } = row;
        ({ error: insErr } = await supabaseAdmin.from('import_logs').insert(withoutDetails));
      }
      if (insErr) console.error('[logImport] insert failed:', insErr.message);
    } catch (e) {
      console.error('[logImport] persistence error:', e.message);
    }
  }

  return res.json({ ok: true });
}
