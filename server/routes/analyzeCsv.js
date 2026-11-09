/**
 * POST /api/analyze-csv
 *
 * Fallback AI parser: when the deterministic parser returns no transactions,
 * the client sends the raw CSV text and the broker hint. The LLM attempts to
 * extract investment transactions and returns them in the Trazza transaction
 * schema (same shape as parseDegiroCSV / parseIBKRCSV output).
 *
 * Resilience model (mirrors /api/parse-freeform):
 *  - The CSV is split into chunks (header repeated) instead of hard-truncated;
 *    chunks run SEQUENTIALLY to respect Groq's tokens-per-minute limit.
 *  - Each chunk call retries once on 429, falls back on a decommissioned
 *    model, and salvages rows from truncated/over-budget JSON (groqJson.js).
 *  - One failed chunk never kills the request — partial results are returned;
 *    only "every chunk failed AND zero rows" surfaces as an error.
 *  - Every returned row is sanitised (types, DD-MM-YYYY dates, numeric fields,
 *    money signs) before reaching the client preview (csvAiPipeline.js).
 *
 * Body (JSON):
 *   { csvText: string, broker: string }
 *
 * Response (JSON):
 *   { transactions, processingMs, truncated, analyzedRows, totalRows }
 */

import { addLog }      from '../lib/logBuffer.js';
import { groqJsonCall } from '../lib/groqJson.js';
import { buildCsvChunks, sanitiseCsvRow, csvRowHash } from '../lib/csvAiPipeline.js';
import { TEXT_MODEL, TEXT_FALLBACK_MODEL } from '../lib/groqModels.js';
import { aiErrorBody, AI_OVERLOADED, AI_UNAVAILABLE } from '../lib/aiErrors.js';
import { respondIfAiNotConfigured } from '../lib/aiRouteGate.js';

const MODEL          = TEXT_MODEL;
const FALLBACK_MODEL = TEXT_FALLBACK_MODEL;

// Groq on_demand TPM accounting = prompt tokens + max_tokens RESERVED. Reserve
// only what a chunk can plausibly produce (~80 output tokens per CSV row).
const MAX_OUT_TOKENS = 6_000;
const TOKENS_PER_ROW = 80;

const SYSTEM_PROMPT = `You are a financial data extraction engine. Your only job is to parse investment transaction CSVs and return structured JSON.

You may receive one fragment of a larger file: the header row is repeated at the top of every fragment. Parse only the data rows present in the fragment.

Output format — return ONLY a valid JSON object with a "transactions" array. Each transaction object MUST have these exact fields:
{
  "fecha": "DD-MM-YYYY",            // date in DD-MM-YYYY format
  "hora": "HH:MM",                  // time, use "00:00" if unknown
  "type": "BUY" | "SELL" | "DIVIDEND" | "FEES",
  "producto": string,               // asset name or ticker symbol
  "isin": string,                   // ISIN (e.g. US0231351067) or Yahoo ticker (e.g. BTC-USD). Never leave empty — use ticker if no ISIN.
  "cantidad": number,               // quantity of units (always positive)
  "precio": number,                 // price per unit in native currency
  "total": number,                  // negative for costs (BUY/FEES), positive for receipts (SELL/DIVIDEND)
  "moneda": string,                 // 3-letter ISO currency code (EUR, USD, GBP...)
  "comisiones": number              // commission/fee amount (0 if none)
}

Rules:
- Include only BUY, SELL, DIVIDEND, and FEES transactions.
- Skip deposits, withdrawals, cash transfers, account fees unrelated to specific assets.
- For crypto tickers with no ISIN, use Yahoo Finance format: BTC-USD, ETH-USD, SOL-USD, etc.
- "total" for BUY must be negative (it is a cost). "total" for SELL/DIVIDEND must be positive.
- If a field cannot be determined with confidence, use 0 for numbers and "" for strings.
- Return {"transactions": []} if no investment transactions are found.
- Do NOT include any explanation, markdown, or text outside the JSON object. Be compact: no indentation or extra whitespace.`;

// Auth: the Supabase JWT is verified by withRateLimit (index.js) — same as
// validate-import and portfolio-chat.
export async function analyzeCsv(req, res) {
  const start = Date.now();

  const { csvText, broker = 'unknown' } = req.body || {};

  if (!csvText || typeof csvText !== 'string' || csvText.trim().length < 10) {
    return res.status(400).json({ error: 'csvText is required and must be a non-empty string' });
  }
  if (respondIfAiNotConfigured(req, res)) return;

  const { chunks, truncated, totalRows, analyzedRows } = buildCsvChunks(csvText.trim());

  const seen = new Set();
  const transactions = [];
  let failedChunks = 0;
  let lastError = null;

  // Sequential — firing chunks with Promise.all blows through Groq's TPM limit
  for (let i = 0; i < chunks.length; i++) {
    const chunkRowCount = Math.max(chunks[i].split('\n').length - 1, 1);
    const label = `analyzeCsv ${i + 1}/${chunks.length}`;
    let parsed = null;
    try {
      parsed = await groqJsonCall({
        model: MODEL,
        fallbackModel: FALLBACK_MODEL,
        maxTokens: Math.min(MAX_OUT_TOKENS, 300 + chunkRowCount * TOKENS_PER_ROW),
        label,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: `Broker: ${broker}\n\nCSV content (fragment ${i + 1} of ${chunks.length}):\n${chunks[i]}` },
        ],
      });
    } catch (err) {
      failedChunks++;
      lastError = err;
      console.error(`[${label}] FAILED: ${err?.status || ''} ${err?.message}`);
      addLog('error', 'ai', `CSV AI chunk ${i + 1}/${chunks.length} failed: ${err?.status || ''} ${err?.message}`, { broker });
      continue;
    }

    for (const r of (Array.isArray(parsed?.transactions) ? parsed.transactions : [])) {
      const row = sanitiseCsvRow(r);
      if (!row) continue;
      const h = csvRowHash(row);
      if (seen.has(h)) continue;
      seen.add(h);
      transactions.push(row);
    }
  }

  // Every chunk failed and nothing was recovered → a real outage, not "no
  // transactions found". Distinguish saturation from unavailability.
  if (chunks.length > 0 && failedChunks === chunks.length && transactions.length === 0) {
    if (lastError?.status === 429) {
      return res.status(503).json(aiErrorBody(AI_OVERLOADED));
    }
    return res.status(503).json(aiErrorBody(AI_UNAVAILABLE));
  }

  await req.incrementUsage?.();

  const ms = Date.now() - start;
  console.log(`[analyzeCsv] broker=${broker} rows=${totalRows} chunks=${chunks.length} failedChunks=${failedChunks} found=${transactions.length} ms=${ms}`);
  addLog('ok', 'import',
    `CSV AI parse · ${transactions.length} transactions · ${chunks.length} chunk(s)${failedChunks ? ` · ${failedChunks} FAILED` : ''} · ${ms}ms${truncated ? ` · TRUNCATED ${analyzedRows}/${totalRows} rows` : ''}`,
    { broker, truncated, totalRows, failedChunks });
  return res.json({ transactions, processingMs: ms, truncated, analyzedRows, totalRows, failedChunks });
}
