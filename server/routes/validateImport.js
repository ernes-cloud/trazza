/**
 * POST /api/validate-import
 *
 * Calls Groq (Llama 3.3 70B) to validate CSV import rows that the client-side
 * parser flagged as problematic. Returns structured issues with suggestions.
 *
 * Body (JSON):
 * {
 *   broker: 'degiro' | 'ibkr' | 'binance',
 *   sampleValidRows: string[],      // up to 5 raw CSV lines that parsed OK
 *   problematicRows: Array<{
 *     rowIndex: number,             // 1-based line number in the original file
 *     raw: string,                  // raw CSV line
 *     parserError?: string          // error message from the local parser (optional)
 *   }>
 * }
 *
 * Response (JSON):
 * {
 *   issues: Array<{
 *     rowIndex: number,
 *     rowPreview: string,
 *     severity: 'error' | 'warning',
 *     field: string,
 *     issue: string,
 *     suggestion: string,
 *     autoFixable: boolean
 *   }>,
 *   model: string,
 *   processingMs: number
 * }
 */

import { getGroq } from '../lib/groqClient.js';
import { addLog }  from '../lib/logBuffer.js';
import { SYSTEM_PROMPT, buildUserMessage } from '../prompts/csvValidation.js';
import { TEXT_MODEL } from '../lib/groqModels.js';
import { respondIfAiNotConfigured } from '../lib/aiRouteGate.js';


const ALLOWED_BROKERS = ['degiro', 'ibkr', 'binance', 'myinvestor'];
const MAX_PROBLEMATIC_ROWS = 30;
const MODEL = TEXT_MODEL;

export async function validateImport(req, res) {
  const start = Date.now();

  // ── Input validation ──────────────────────────────────────────────────────
  const { broker, sampleValidRows = [], problematicRows = [] } = req.body || {};
  console.log('[validate-import] request:', { broker, sampleRows: sampleValidRows?.length, problematicRows: problematicRows?.length });

  if (!ALLOWED_BROKERS.includes(broker)) {
    return res.status(400).json({ error: `broker must be one of: ${ALLOWED_BROKERS.join(', ')}` });
  }
  const hasRows = (Array.isArray(sampleValidRows) && sampleValidRows.length > 0) ||
                  (Array.isArray(problematicRows)  && problematicRows.length  > 0);
  if (!hasRows) {
    return res.status(400).json({ error: 'No rows provided for validation' });
  }
  if (respondIfAiNotConfigured(req, res)) return;

  // Cap to avoid sending too much data and hitting token limits
  const rowsToSend = problematicRows.slice(0, MAX_PROBLEMATIC_ROWS);

  // ── Groq call ─────────────────────────────────────────────────────────────
  try {
    const userMessage = buildUserMessage({
      broker,
      sampleValidRows: (sampleValidRows || []).slice(0, 5),
      problematicRows: rowsToSend,
    });

    const completion = await getGroq(25_000).chat.completions.create({
      model: MODEL,
      temperature: 0.1,       // low temperature → deterministic, factual output
      max_tokens: 2048,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userMessage },
      ],
    });

    const raw = completion.choices[0]?.message?.content || '[]';

    // Groq with json_object mode sometimes wraps the array in an object key
    let issues = [];
    try {
      const parsed = JSON.parse(raw);
      const candidate = Array.isArray(parsed)
        ? parsed
        : (parsed.issues || parsed.errors || Object.values(parsed)[0]);
      issues = Array.isArray(candidate) ? candidate : [];
    } catch {
      console.error('[validate-import] Failed to parse Groq response:', raw.slice(0, 200));
      issues = [];
    }

    // Sanitise output — only forward known fields to the client
    const sanitised = issues.map(item => ({
      rowIndex:    typeof item.rowIndex === 'number' ? item.rowIndex : 0,
      rowPreview:  String(item.rowPreview || '').slice(0, 100),
      severity:    item.severity === 'error' ? 'error' : 'warning',
      field:       String(item.field || '').slice(0, 50),
      issue:       String(item.issue || '').slice(0, 200),
      suggestion:  String(item.suggestion || '').slice(0, 200),
      autoFixable: Boolean(item.autoFixable),
    }));

    // Increment usage counters only after a successful AI response
    await req.incrementUsage?.();

    const ms = Date.now() - start;
    addLog('ok', 'import', `CSV validation · ${sanitised.length} issues · ${ms}ms`, { broker: req.body?.broker });
    return res.json({ issues: sanitised, model: MODEL, processingMs: ms });

  } catch (err) {
    console.error('[validate-import] Groq error:', err.message);
    addLog('error', 'import', `CSV validation error: ${err.message}`);

    // Return a graceful degradation — never block the import because of AI failure
    return res.status(200).json({
      issues: [],
      model: MODEL,
      processingMs: Date.now() - start,
      warning: 'AI validation unavailable — please review the rows manually.',
    });
  }
}
