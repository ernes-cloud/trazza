/**
 * useImportValidator
 *
 * Sends suspicious parsed rows to the Trazza validation server (Groq/Llama).
 * Non-blocking: the import can proceed regardless of this call's outcome.
 *
 * Usage (inside the CSV import preview step):
 *
 *   const { validate, issues, validating, validationWarning, clearIssues } = useImportValidator();
 *
 *   // After the local parser runs and before the user confirms:
 *   useEffect(() => {
 *     if (parsedRows.length > 0) {
 *       validate({ broker: 'degiro', parsedRows });
 *     }
 *   }, [parsedRows]);
 */

import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/customSupabaseClient';
import { aiHttpErrorMessage } from '@/lib/aiHttpErrorMessage';

// Use the Vite proxy path — the proxy in vite.config.js forwards this to the real server.
// Never call the server URL directly from the browser (CORS + port issues).
const VALIDATION_ENDPOINT = '/api/validate-import';

async function getAuthHeaders() {
  const { data: { session } } = await supabase.auth.getSession();
  return {
    'Content-Type': 'application/json',
    ...(session?.access_token ? { 'Authorization': `Bearer ${session.access_token}` } : {}),
  };
}

const KNOWN_TYPES = new Set([
  'BUY', 'SELL', 'DIVIDEND', 'FEE', 'FEES', 'TAX',
  'CASH', 'TRANSFER', 'Cash', 'CURRENCY_EXCHANGE',
]);

/**
 * Identifies parsed rows that are likely problematic.
 * Works directly on the parsed output — no raw-line index correlation needed.
 */
function collectProblematicRows(parsedRows) {
  const problematic = [];

  parsedRows.forEach((row, idx) => {
    const issues = [];

    // BUY/SELL with zero quantity or zero price → suspicious
    if (row.type === 'BUY' || row.type === 'SELL') {
      if (!row.cantidad || parseFloat(row.cantidad) === 0)
        issues.push(`qty=${row.cantidad}`);
      if (!row.precio || parseFloat(row.precio) === 0)
        issues.push(`price=${row.precio}`);
    }

    // Malformed date
    const dateStr = row.transaction_date || row.fecha || '';
    if (
      dateStr &&
      !/^\d{4}-\d{2}-\d{2}/.test(dateStr) &&
      !/^\d{2}-\d{2}-\d{4}/.test(dateStr)
    ) {
      issues.push(`date="${dateStr}"`);
    }

    // Unknown transaction type
    if (row.type && !KNOWN_TYPES.has(row.type)) {
      issues.push(`unknown type="${row.type}"`);
    }

    if (issues.length > 0) {
      // Normalize fecha to YYYY-MM-DD so the AI doesn't flag valid DD-MM-YYYY parser format
      const rawDate = row.fecha || '';
      const dm = rawDate.match(/^(\d{2})-(\d{2})-(\d{4})$/);
      const normalizedDate = dm ? `${dm[3]}-${dm[2]}-${dm[1]}` : rawDate;

      problematic.push({
        rowIndex: idx + 2, // 1-based, row 1 = header
        raw: [normalizedDate, row.type, row.producto || row.isin, row.cantidad, row.precio, row.moneda]
          .filter(v => v !== undefined && v !== null && v !== '')
          .join(' | '),
        parserError: issues.join('; '),
      });
    }
  });

  return problematic;
}

// Types that legitimately have no quantity or price — the AI must never flag these.
const NO_QTY_TYPES = new Set(['DIVIDEND', 'TAX', 'FEE', 'FEES', 'TRANSFER', 'CASH', 'CURRENCY_EXCHANGE']);

/**
 * Removes AI-reported issues that contradict rules we already know are correct.
 * This is a hard safeguard against LLM hallucinations — the prompt is the soft
 * constraint, this filter is the hard one.
 */
function filterKnownFalsePositives(issues, parsedRows) {
  return issues.filter(issue => {
    const row = parsedRows[issue.rowIndex - 2]; // rowIndex is 1-based, parsedRows is 0-based
    if (!row) return true;

    // Positive quantity for BUY/SELL is always correct — parser outputs Math.abs(qty).
    if (issue.field === 'Quantity' && (row.type === 'BUY' || row.type === 'SELL')) {
      const qty = parseFloat(row.cantidad);
      if (qty > 0) return false; // AI should never suggest negating a valid positive qty
    }

    // DIVIDEND/FEE/TAX/TRANSFER with no qty/price is correct by design.
    if (NO_QTY_TYPES.has(row.type) && (issue.field === 'Quantity' || issue.field === 'Price')) {
      return false;
    }

    return true;
  });
}

export function useImportValidator() {
  const { t } = useTranslation();
  const [issues, setIssues]                     = useState([]);
  const [validating, setValidating]             = useState(false);
  const [validationWarning, setValidationWarning] = useState(null);

  /**
   * @param {object} opts
   *   broker      – 'degiro' | 'ibkr' | 'binance'
   *   parsedRows  – array of parsed transaction objects from the parser
   */
  const validate = useCallback(async ({ broker, parsedRows }) => {
    setIssues([]);
    setValidationWarning(null);
    setValidating(true);

    const rows = parsedRows || [];
    if (rows.length === 0) { setValidating(false); return; }

    // Rows flagged by the local heuristic (qty=0, bad date, unknown type)
    const problematic = collectProblematicRows(rows);

    // Break the React batch so validating=true renders before we cancel it.
    // Without this, setValidating(true) + setValidating(false) are batched into
    // a single render where validating is false → panel stays permanently hidden.
    await Promise.resolve();

    // Only call the AI when the local heuristic actually found something suspicious.
    // Sending valid sample rows to the AI produces false positives (LLM hallucinations
    // on correct data) and wastes the user's daily AI quota.
    if (problematic.length === 0) {
      setValidating(false);
      return;
    }

    const problematicIndices = new Set(problematic.map(p => p.rowIndex - 2));
    const sampleValidRows = rows
      .filter((_, i) => !problematicIndices.has(i))
      .slice(0, 5)
      .map(r => {
        // Normalize date to YYYY-MM-DD regardless of parser format (DD-MM-YYYY or ISO)
        const rawDate = r.transaction_date?.split('T')[0] || r.fecha || '';
        const dateMatch = rawDate.match(/^(\d{2})-(\d{2})-(\d{4})$/);
        const date = dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : rawDate;
        return [date, r.type, r.producto || r.isin, r.cantidad, r.precio, r.moneda]
          .filter(Boolean)
          .join(', ');
      });

    try {
      const headers = await getAuthHeaders();
      const res = await fetch(VALIDATION_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify({ broker, sampleValidRows, problematicRows: problematic }),
        signal: AbortSignal.timeout(20_000),
      });

      if (res.status === 429) {
        const data = await res.json();
        const reason = data.reason === 'monthly' ? 'mensual' : 'diario';
        setValidationWarning(`Límite ${reason} de validación IA alcanzado. Puedes importar igualmente sin validación automática.`);
        return;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const detail = aiHttpErrorMessage({
          status: res.status, error: body.error, code: body.code, t,
        });
        setValidationWarning(t('cartera.ai_validation_unavailable', { detail }));
        return;
      }

      const data = await res.json();

      if (data.warning) setValidationWarning(data.warning);
      if (Array.isArray(data.issues)) {
        setIssues(filterKnownFalsePositives(data.issues, rows));
      }
    } catch (err) {
      console.error('[useImportValidator] Validation failed:', err.name, err.message);
      // Nunca `[Error: Server responded 503]` — mensaje i18n + detalle útil.
      const detail = err.name === 'TimeoutError'
        ? t('cartera.ai_timeout')
        : t('cartera.ai_unavailable');
      setValidationWarning(t('cartera.ai_validation_unavailable', { detail }));
    } finally {
      setValidating(false);
    }
  }, [t]);

  const clearIssues = useCallback(() => {
    setIssues([]);
    setValidationWarning(null);
  }, []);

  return { validate, issues, validating, validationWarning, clearIssues };
}
