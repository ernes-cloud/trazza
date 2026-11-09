/**
 * POST /api/analyze-earnings
 *
 * AI reading of ONE company's earnings report: what the numbers say and how the
 * market has taken it (or is expected to take it, for an unpublished quarter).
 *
 * All the data comes from the client (Nasdaq/EODHD/Yahoo, already on screen) —
 * this route only turns it into a narrative. Rate limited under the 'analysis'
 * feature, same bucket as the portfolio score.
 *
 * Body: { ticker, name, lang, currency, event, history[], revenue[], priceReaction }
 * Response: { insight: string, processingMs } | { isFallback: true, processingMs }
 */

import { getGroq } from '../lib/groqClient.js';
import { addLog } from '../lib/logBuffer.js';
import { sanitizeEarningsPayload, buildEarningsPrompt } from '../prompts/earningsAnalysis.js';
import { TEXT_MODEL } from '../lib/groqModels.js';
import { narrativeParams, isTruncated } from '../lib/groqNarrative.js';
import { respondIfAiNotConfigured } from '../lib/aiRouteGate.js';

const MODEL = TEXT_MODEL;

export async function analyzeEarnings(req, res) {
  const start = Date.now();

  const payload = sanitizeEarningsPayload(req.body);
  if (!payload) {
    return res.status(400).json({ error: 'ticker is required' });
  }
  if (respondIfAiNotConfigured(req, res)) return;

  const { system, user, published } = buildEarningsPrompt(payload);

  try {
    const completion = await getGroq(30_000).chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      ...narrativeParams(MODEL, 650),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });

    const insight = completion.choices[0]?.message?.content?.trim() || '';

    // An empty completion is not a usable analysis — surface the fallback and
    // DON'T consume the user's AI quota for something they can't read.
    if (!insight || isTruncated(completion)) {
      addLog('error', 'ai', `Earnings analysis: empty AI response for ${payload.ticker} (usage not counted)`);
      return res.status(200).json({ isFallback: true, processingMs: Date.now() - start });
    }

    await req.incrementUsage?.();

    const ms = Date.now() - start;
    addLog('ok', 'ai', `Earnings analysis ${payload.ticker} (${payload.lang}) · ${ms}ms`, {
      ticker: payload.ticker,
      published,
      model: MODEL,
    });
    return res.json({ insight, processingMs: ms });

  } catch (err) {
    console.error('[analyze-earnings] Groq error:', err.message);
    addLog('error', 'ai', `Earnings analysis error (${payload.ticker}): ${err.message}`);
    return res.status(200).json({ isFallback: true, processingMs: Date.now() - start });
  }
}
