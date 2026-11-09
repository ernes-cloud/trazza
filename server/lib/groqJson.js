/**
 * Resilient Groq JSON-mode completion — shared by the AI import routes.
 *
 * Wraps one chat.completions.create call with the recovery ladder every AI
 * import call needs:
 *   1. 429 rate limit                    → wait Retry-After (capped) and retry once
 *   2. model gone (404 / decommissioned) → retry once on the fallback model
 *   3. json_validate_failed              → salvage rows from the failed generation
 *   4. non-JSON / truncated content      → tolerant parse (looseJson)
 *
 * Returns the parsed object, or null when the content was unusable.
 * Errors that survive the ladder are re-thrown: the CALLER decides whether one
 * failed call kills the whole request or just one chunk.
 */

import { getGroq } from './groqClient.js';
import { parseLooseJson } from './looseJson.js';

const MAX_RETRY_WAIT_MS   = 30_000;
const DEFAULT_RETRY_AFTER = 12; // seconds, when Groq omits the header

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const groqErrorCode = (err) => err?.error?.error?.code || err?.code || null;

const isModelGone = (err) =>
  err?.status === 404 ||
  ['model_decommissioned', 'model_not_found'].includes(groqErrorCode(err));

async function requestWithRecovery(request, model, fallbackModel, label) {
  try {
    return await request(model);
  } catch (err) {
    if (isModelGone(err) && fallbackModel) {
      console.warn(`[${label}] model "${model}" unavailable (${groqErrorCode(err) || err?.status}) — falling back to "${fallbackModel}"`);
      return request(fallbackModel);
    }
    if (err?.status === 429) {
      const retryAfter = Number(err?.headers?.['retry-after']);
      const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : DEFAULT_RETRY_AFTER;
      const waitMs = Math.min(seconds * 1000, MAX_RETRY_WAIT_MS);
      console.warn(`[${label}] rate-limited — retrying in ${waitMs}ms`);
      await sleep(waitMs);
      return request(model);
    }
    throw err;
  }
}

/**
 * @param {object} opts
 * @param {string}  opts.model          Primary model id
 * @param {string}  [opts.fallbackModel] Used once if the primary model is gone
 * @param {Array}   opts.messages       Chat messages
 * @param {number}  opts.maxTokens      Completion reservation (counts against Groq TPM)
 * @param {number}  [opts.temperature]
 * @param {number}  [opts.timeoutMs]    Per-call Groq client timeout
 * @param {string}  [opts.label]        Log prefix (route + chunk index)
 * @param {string}  [opts.reasoningEffort] Modelos que razonan (gpt-oss): el razonamiento
 *   consume cupo de TPM igual que la respuesta. Para EXTRAER, 'low' gasta un
 *   tercio y acierta más que el modo normal.
 * @param {object}  [opts.client]       Injectable Groq-like client (tests)
 * @returns {Promise<object|null>} parsed JSON object, or null if unusable
 */
export async function groqJsonCall({
  model,
  fallbackModel = null,
  messages,
  maxTokens,
  temperature = 0.1,
  timeoutMs = 60_000,
  label = 'groq',
  reasoningEffort = null,
  client = null,
}) {
  const groq = client || getGroq(timeoutMs);
  const request = (mdl) => groq.chat.completions.create({
    model: mdl,
    temperature,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    messages,
  });

  let completion;
  try {
    completion = await requestWithRecovery(request, model, fallbackModel, label);
  } catch (err) {
    // The completion overflowed max_tokens (or the model broke JSON mode):
    // Groq rejects it but ships the partial text — recover the complete rows.
    if (groqErrorCode(err) === 'json_validate_failed') {
      const salvaged = parseLooseJson(err?.error?.error?.failed_generation);
      console.warn(`[${label}] json_validate_failed — salvaged ${salvaged?.transactions?.length ?? 0} row(s)`);
      return salvaged;
    }
    throw err;
  }

  const raw = completion.choices?.[0]?.message?.content || '{}';
  try {
    return JSON.parse(raw);
  } catch {
    console.warn(`[${label}] non-JSON content — tolerant parse: ${raw.slice(0, 160).replace(/\s+/g, ' ')}`);
    return parseLooseJson(raw);
  }
}
