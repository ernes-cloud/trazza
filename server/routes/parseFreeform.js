/**
 * POST /api/parse-freeform
 *
 * Free-form AI import: the user pastes chaotic text (broker screen copy-paste,
 * broken PDF dump, several files mixed together, multilingual) and the LLM
 * extracts individual transactions into the NEUTRAL extraction schema
 * (see server/prompts/freeformImport.js).
 *
 * This route only extracts + sanitises. The deterministic mapping to the
 * internal Trazza schema (signs, totals, DD-MM-YYYY dates) happens client-side
 * in src/lib/parsers/freeformMapper.js, where it is unit-tested.
 *
 * Body (JSON):
 *   { text: string }
 *
 * Response (JSON):
 *   { transactions: NeutralRow[], processingMs: number }
 *   NeutralRow: { date, ticker, assetName, type, quantity, price, amount, currency, sourceLine }
 */

import { getGroq } from '../lib/groqClient.js';
import { addLog }  from '../lib/logBuffer.js';
import { SYSTEM_PROMPT, VISION_SYSTEM_PROMPT, buildUserMessage, detectDateConvention } from '../prompts/freeformImport.js';
import { sanitiseImages } from '../lib/visionImages.js';
import { parseLooseJson } from '../lib/looseJson.js';
import { respondIfAiNotConfigured } from '../lib/aiRouteGate.js';
import { groqJsonCall } from '../lib/groqJson.js';
import { TEXT_MODEL, TEXT_FALLBACK_MODEL, VISION_MODEL, hasVisionModel } from '../lib/groqModels.js';
import {
  aiErrorBody, AI_OVERLOADED, AI_UNAVAILABLE, AI_REGION_BLOCKED,
} from '../lib/aiErrors.js';

const MODEL          = TEXT_MODEL;
const FALLBACK_MODEL = TEXT_FALLBACK_MODEL;

const NEUTRAL_TYPES = ['BUY', 'SELL', 'DIVIDEND', 'DEPOSIT', 'WITHDRAWAL', 'FEE', 'HOLDING'];
const MAX_CHARS        = 100_000; // hard cap on pasted text
// ⚠️ PRESUPUESTO POR LLAMADA — medido contra la API el 2026-09-18, no estimado:
//
//   límite del plan on_demand ..... 8.000 tokens/minuto (TPM), 1.000 req/minuto
//   system prompt ................. ~3.700 tokens, y viaja en CADA llamada
//   queda para chunk + reserva .... ~4.300
//
// Groq cuenta el prompt MÁS los max_tokens RESERVADOS (no los gastados), así que
// una reserva generosa no es gratis: consume cupo aunque no se use. Reservar
// 10.000 hacía que CADA llamada superase el límite entero y esperase a que se
// abriera la ventana — un import de 4 chunks tardaba 114 segundos.
//
// La otra mitad es reasoning_effort bajo: gpt-oss razona antes de responder
// y ese razonamiento sale del mismo cupo. Medido sobre 9 órdenes reales, el
// esfuerzo bajo gastó 121 tokens por fila frente a 250-400 del modo normal Y
// acertó las 9 cantidades (el modo normal desajustaba). Extraer no es razonar:
// aquí lo barato es además lo correcto.
//
// Las filas llevan un NÚMERO de línea en vez de copiar el texto de origen (~55
// tokens por fila en vez de ~90) y la ruta lo resuelve contra el original.
/**
 * ¿Esta línea puede ABRIR un registro?
 *
 * En un extracto apilado un registro son varias líneas seguidas (descripción,
 * importe, estado, unidades) y cortar por el medio es lo que provoca el fallo
 * más caro: el fragmento siguiente empieza con una cifra huérfana, el modelo la
 * engancha a la primera descripción que ve y a partir de ahí TODAS las
 * cantidades van corridas un registro. Medido con un extracto real: los cortes
 * caían en «0,29 participaciones» y en «Puntual», y diez de diecisiete filas
 * salieron con la cantidad del fondo anterior.
 */
const isRecordStart = (line) => {
  const s = String(line || '').replace(/^\d+\|\s?/, '').trim();
  if (/^\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}$/.test(s)) return true; // cabecera de fecha
  if (/^\d/.test(s)) return false;                                  // importe o unidades
  const palabras = s.split(/\s+/).filter(Boolean);
  // Una sola palabra es un estado ("Puntual", "Finalizada"), no una descripción.
  return palabras.length >= 2 && palabras.some((w) => /[A-Za-zÁ-ÿ]{3,}/.test(w));
};

const CHUNK_LINES      = 50;      // lines per LLM call
const CHUNK_OVERLAP    = 6;       // lines repeated between chunks so border rows aren't lost
const MAX_CHUNKS       = 6;       // beyond this, ask the user to split the paste
const MAX_INPUT_LINES  = CHUNK_LINES + (MAX_CHUNKS - 1) * (CHUNK_LINES - CHUNK_OVERLAP);
const MAX_OUT_TOKENS   = 3_500;   // cabe junto al system prompt en los 8k de TPM

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const ISIN_RE     = /^[A-Z]{2}[A-Z0-9]{10}$/;

// Positive finite number or null — the LLM must never smuggle 0/NaN/negatives through
const cleanNumber = (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return (typeof n === 'number' && Number.isFinite(n) && n > 0) ? n : null;
};

const cleanString = (v, max = 120) =>
  (typeof v === 'string' && v.trim()) ? v.trim().slice(0, max) : null;

/**
 * Sanitise one LLM row into the neutral schema; null = discard row.
 * `getLine(n)` resolves the model's line number to the original pasted line —
 * the audit trail the HITL table shows (frontend keeps receiving `sourceLine`).
 */
function sanitiseRow(r, getLine) {
  if (!r || typeof r !== 'object') return null;
  const type = NEUTRAL_TYPES.includes(r.type) ? r.type : null;
  if (!type) return null;

  let ticker      = cleanString(r.ticker, 24);
  let isin        = cleanString(r.isin, 12);
  const assetName = cleanString(r.assetName, 120);

  // The model sometimes drops an ISIN into ticker despite the prompt — reroute it.
  if (ticker && ISIN_RE.test(ticker)) { isin = isin || ticker; ticker = null; }
  if (isin && !ISIN_RE.test(isin)) isin = null;

  // Asset rows without any identifier are unusable even for human review
  if (['BUY', 'SELL', 'DIVIDEND', 'HOLDING'].includes(type) && !ticker && !isin && !assetName) return null;

  const date = (typeof r.date === 'string' && ISO_DATE_RE.test(r.date)) ? r.date : null;
  const currency = (typeof r.currency === 'string' && CURRENCY_RE.test(r.currency.toUpperCase().trim()))
    ? r.currency.toUpperCase().trim() : null;

  return {
    date,
    ticker,
    isin,
    assetName,
    type,
    quantity: cleanNumber(r.quantity),
    price:    cleanNumber(r.price),
    amount:   cleanNumber(r.amount),
    currency,
    sourceLine: getLine(r.line) || cleanString(r.sourceLine, 200) || '',
  };
}

// Dedupe across chunk overlaps and "table + summary" repeats inside the text
const rowHash = (r) =>
  `${r.date}|${r.type}|${r.ticker || r.assetName}|${r.quantity}|${r.price}|${r.amount}|${r.currency}`;

// Chunks are built over GLOBALLY numbered lines ("42| …") so the model's `line`
// field maps back to the original paste regardless of which chunk it came from.
function buildChunks(numberedLines) {
  if (numberedLines.length <= CHUNK_LINES) return [numberedLines.join('\n')];
  const chunks = [];
  // Retrocede hasta la última línea que abre un registro, para no empezar un
  // fragmento a media ficha. Si no hay ninguna cerca, se corta donde tocaba.
  const snap = (idx) => {
    for (let i = idx; i > idx - CHUNK_OVERLAP && i > 0; i -= 1) {
      if (isRecordStart(numberedLines[i])) return i;
    }
    return idx;
  };

  for (let start = 0; start < numberedLines.length && chunks.length < MAX_CHUNKS;) {
    const desde = start === 0 ? 0 : snap(start);
    chunks.push(numberedLines.slice(desde, desde + CHUNK_LINES).join('\n'));
    if (desde + CHUNK_LINES >= numberedLines.length) break;
    start = desde + CHUNK_LINES - CHUNK_OVERLAP;
  }
  return chunks;
}

// Auth: the Supabase JWT is verified by withRateLimit (index.js) — same as
// validate-import and portfolio-chat. No additional x-api-key gate: nothing in
// the frontend or proxies sends that header.
export async function parseFreeform(req, res) {
  const start = Date.now();
  // Un 403 de Groq NO es una saturación pasajera: es un rechazo de RED (la misma
  // respuesta llega SIN api key, o sea antes de autenticar). Lo marcan tanto el
  // camino de texto como el de imágenes, porque la causa y el remedio son los
  // mismos y decirle al usuario que reintente en unos segundos no le sirve.
  let networkBlocked = false;

  const { text, images } = req.body || {};

  const hasText = typeof text === 'string' && text.trim().length >= 20;
  const visionImages = sanitiseImages(images);

  if (!hasText && !visionImages.length) {
    return res.status(400).json({ error: 'Provide text (min 20 chars) or at least one image' });
  }
  if (typeof text === 'string' && text.length > MAX_CHARS) {
    return res.status(413).json({ error: `text too large (max ${MAX_CHARS} chars) — split the import` });
  }
  if (respondIfAiNotConfigured(req, res)) return;

  // Text-pipeline scaffolding — only built when there is pasted text.
  let lines = [];
  let chunks = [];
  const getLine = (n) => (Number.isInteger(n) && n >= 1 && n <= lines.length) ? lines[n - 1].slice(0, 200) : null;
  if (hasText) {
    lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length > MAX_INPUT_LINES) {
      return res.status(413).json({ error: 'too many lines — split the import into smaller pastes' });
    }
    chunks = buildChunks(lines.map((l, i) => `${i + 1}| ${l}`));
  }

  // Tolerant JSON recovery (fences / prose / truncation) — see lib/looseJson.js.
  const salvageTruncatedJson = parseLooseJson;

  // Surface the REAL Groq error for a vision call — model id, response_format or
  // image-support problems all land here. Without this the cause is invisible
  // (the request just returns "0 transactions").
  const logVisionError = (idx, err) => {
    // Un 403 aquí es el MISMO rechazo de red que en el camino de texto, no un
    // problema del modelo de visión: sin distinguirlo, el mensaje mandaba al
    // usuario a revisar GROQ_VISION_MODEL, que estaba perfectamente bien.
    if (err?.status === 403) networkBlocked = true;
    const detail = err?.error?.error?.message || err?.message || String(err);
    console.error(`[parseFreeform] vision img ${idx + 1} FAILED (model="${VISION_MODEL}", status=${err?.status || '?'}): ${detail}`);
    addLog('error', 'ai', `Vision import error (${VISION_MODEL}): ${err?.status || ''} ${detail}`);
  };

  // One Groq call per chunk via the shared resilient helper (429 retry, model
  // fallback, JSON salvage — lib/groqJson.js). Chunks run SEQUENTIALLY:
  // firing them with Promise.all blew through Groq's tokens-per-minute limit on
  // large pastes (429 on every chunk → blanket 503 to the user).
  // Returns the PARSED {transactions: []} object (or null for an unusable chunk).
  // Una sola vez, sobre el texto COMPLETO: el troceado esconde la prueba de la
  // convención en fragmentos que el modelo no ve (ver detectDateConvention).
  const dateConvention = detectDateConvention(text || '');
  const callGroq = (chunk, i) => {
    // Reserve only what this chunk can plausibly produce (~80 tokens/row worst
    // case) — Groq counts the reservation against the TPM limit, not real usage.
    const chunkLineCount = chunk.split('\n').length;
    return groqJsonCall({
      model: MODEL,
      fallbackModel: FALLBACK_MODEL,
      maxTokens: Math.min(MAX_OUT_TOKENS, 400 + chunkLineCount * 60),
      reasoningEffort: 'low',
      label: `parseFreeform ${i + 1}/${chunks.length}`,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: buildUserMessage({ rawText: chunk, chunkIndex: i + 1, totalChunks: chunks.length, dateConvention }) },
      ],
    });
  };

  // One vision call per image (screenshot / PDF page). Sequential like the text
  // chunks so a multi-page PDF doesn't trip Groq's per-minute limit. Same 429
  // retry + JSON salvage. Vision rows carry no line number — sanitiseRow falls
  // back to the model-provided sourceLine snippet for the audit trail.
  const callVision = async (dataUrl, idx) => {
    // Sin modelo multimodal configurado no hay nada que intentar: fallar aquí da
    // un mensaje que se entiende, en vez de un 404 de Groq sobre un id inventado.
    if (!hasVisionModel()) {
      console.error('[parseFreeform] sin modelo de visión configurado (GROQ_VISION_MODEL)');
      addLog('error', 'ai', 'Import por imagen: no hay modelo de visión configurado (GROQ_VISION_MODEL)');
      return null;
    }
    // Groq vision models drop the image when a separate `system` message is
    // present (they answer from the instructions alone → always {transactions:[]}).
    // Put the full instructions AND the image in ONE user turn instead.
    const request = () => getGroq(60_000).chat.completions.create({
      model: VISION_MODEL,
      temperature: 0.1,
      max_tokens: MAX_OUT_TOKENS,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'user', content: [
          { type: 'text', text: `${VISION_SYSTEM_PROMPT}\n\nNow read the attached image and return the JSON object.` },
          { type: 'image_url', image_url: { url: dataUrl } },
        ] },
      ],
    });
    let completion;
    try {
      completion = await request();
    } catch (err) {
      if (err?.error?.error?.code === 'json_validate_failed') {
        const salvaged = salvageTruncatedJson(err.error.error.failed_generation);
        console.warn(`[parseFreeform] vision img ${idx + 1} (${VISION_MODEL}): json_validate_failed — salvaged ${salvaged?.transactions?.length ?? 0} rows`);
        return salvaged;
      }
      if (err?.status === 429) {
        const waitMs = Math.min((Number(err?.headers?.['retry-after']) || 12) * 1000, 30_000);
        console.warn(`[parseFreeform] Groq rate-limited on vision img ${idx + 1} — retrying in ${waitMs}ms`);
        await new Promise(r => setTimeout(r, waitMs));
        try { completion = await request(); }
        catch (e2) { logVisionError(idx, e2); return null; }
      } else {
        // Model-config errors (bad/decommissioned model id, response_format or
        // image not supported…) must not 503 the whole import — log loudly,
        // skip this image, let any text/other images still produce rows.
        logVisionError(idx, err);
        return null;
      }
    }
    const raw = completion.choices[0]?.message?.content || '{}';
    const parsed = (() => {
      try { return JSON.parse(raw); } catch { return salvageTruncatedJson(raw); }
    })();
    const n = Array.isArray(parsed?.transactions) ? parsed.transactions.length : 0;
    const u = completion.usage || {};
    // promptTokens is the smoking gun: if the image was actually ingested it costs
    // hundreds-to-thousands of extra tokens; a value ~ the text-prompt size means
    // the image was ignored (model id isn't really vision-capable on this account).
    console.log(`[parseFreeform] vision img ${idx + 1} (${completion.model || VISION_MODEL}): ${n} row(s); promptTokens=${u.prompt_tokens} completionTokens=${u.completion_tokens}; imgChars=${dataUrl.length} mime=${dataUrl.slice(5, dataUrl.indexOf(';'))}; raw[0..160]=${raw.slice(0, 160).replace(/\s+/g, ' ')}`);
    return parsed;
  };

  try {
    const seen = new Set();
    const transactions = [];
    const ingest = (parsed, lineResolver) => {
      if (!parsed) return;
      for (const r of (Array.isArray(parsed.transactions) ? parsed.transactions : [])) {
        const row = sanitiseRow(r, lineResolver);
        if (!row) continue;
        const h = rowHash(row);
        if (seen.has(h)) continue;
        seen.add(h);
        transactions.push(row);
      }
    };

    // TEXT chunks (sequential — Groq TPM limit). A chunk whose call fails even
    // after the helper's retries is skipped — one bad chunk must not kill the
    // rows the other chunks already produced.
    let textFailures = 0;
    let textRateLimitFailures = 0;
    for (let i = 0; i < chunks.length; i++) {
      let parsed = null;
      try {
        parsed = await callGroq(chunks[i], i);
        // Un chunk que no devuelve un objeto con su array `transactions` NO es un
        // chunk vacío: es un chunk que falló (el helper devuelve null cuando ni
        // siquiera pudo rescatar el JSON). Sin contarlo como fallo, un modelo roto
        // se colaba como "éxito con cero filas" y el usuario leía "La IA no
        // encontró operaciones" — mandándole a buscar un problema en su texto que
        // no existía. Fue exactamente lo que pasó al retirar Groq el modelo.
        if (!parsed || !Array.isArray(parsed.transactions)) {
          textFailures++;
          console.error(`[parseFreeform] chunk ${i + 1}/${chunks.length} sin JSON utilizable`);
          addLog('error', 'ai', `Freeform chunk ${i + 1}/${chunks.length}: respuesta sin JSON utilizable`);
        }
      } catch (err) {
        textFailures++;
        if (err?.status === 429) textRateLimitFailures++;
        if (err?.status === 403) networkBlocked = true;
        console.error(`[parseFreeform] chunk ${i + 1}/${chunks.length} FAILED: ${err?.status || ''} ${err?.message}`);
        addLog('error', 'ai', `Freeform chunk ${i + 1}/${chunks.length} failed: ${err?.status || ''} ${err?.message}`);
      }
      ingest(parsed, getLine);
    }

    // VISION images / PDF pages (sequential). No line numbers → resolver is null.
    // callVision returns null when the model call itself failed (vs. an object
    // with an empty array when it simply found nothing).
    let visionFailures = 0;
    for (let i = 0; i < visionImages.length; i++) {
      const parsed = await callVision(visionImages[i], i);
      if (parsed == null) visionFailures++;
      ingest(parsed, () => null);
    }

    // EVERY call errored (text and vision) and nothing was recovered → don't
    // masquerade as "no transactions found". Surface it.
    const totalCalls    = chunks.length + visionImages.length;
    const totalFailures = textFailures + visionFailures;
    if (totalCalls > 0 && totalFailures === totalCalls && transactions.length === 0) {
      if (chunks.length > 0 && textRateLimitFailures === chunks.length && visionImages.length === 0) {
        return res.status(503).json(aiErrorBody(AI_OVERLOADED));
      }
      if (chunks.length === 0) {
        // Visión / config: sin código AI_* (no son saturación ni red genérica).
        return res.status(502).json({
          error: hasVisionModel()
            ? (networkBlocked
                ? AI_REGION_BLOCKED
                : 'No se pudieron procesar las imágenes con el modelo de visión. Revisa los logs del servidor (GROQ_VISION_MODEL).')
            : 'La lectura de imágenes y PDFs está desactivada: no hay modelo de visión configurado (GROQ_VISION_MODEL). Pega el texto en su lugar.',
          ...(networkBlocked && hasVisionModel() ? { code: AI_REGION_BLOCKED } : {}),
        });
      }
      return res.status(503).json(
        aiErrorBody(networkBlocked ? AI_REGION_BLOCKED : AI_UNAVAILABLE),
      );
    }

    await req.incrementUsage?.();

    const ms = Date.now() - start;
    console.log(`[parseFreeform] chars=${(text || '').length} chunks=${chunks.length} textFailures=${textFailures} images=${visionImages.length} visionFailures=${visionFailures} found=${transactions.length} ms=${ms}`);
    addLog('ok', 'import', `Freeform AI parse · ${transactions.length} transactions · ${chunks.length} chunk(s) · ${visionImages.length} image(s) · ${ms}ms`);
    return res.json({ transactions, processingMs: ms });

  } catch (err) {
    // Log the full picture — the generic catch hid the real cause (e.g. Groq 429s)
    console.error('[parseFreeform] Groq error:', err.status || '', err.message, err.error?.error?.message || '');
    addLog('error', 'ai', `Freeform AI parse error: ${err.status || ''} ${err.message}`);
    if (err?.status === 429) {
      return res.status(503).json(aiErrorBody(AI_OVERLOADED));
    }
    if (err?.status === 403) {
      return res.status(503).json(aiErrorBody(AI_REGION_BLOCKED));
    }
    return res.status(503).json(aiErrorBody(AI_UNAVAILABLE));
  }
}
