/**
 * POST /api/portfolio-chat
 *
 * Natural language Q&A over the user's portfolio data.
 * Portfolio context is sent by the client (already computed in React state — no DB query needed).
 *
 * Body (JSON):
 * {
 *   messages: Array<{ role: 'user' | 'assistant', content: string }>,
 *   context: {
 *     totalWealth, totalInvested, cashPosition, totalGainAbs, totalGainPct,
 *     dailyChangePct, totalDividends, totalFees, realizedGain,
 *     currency, date,
 *     positions: Array<{ name, ticker, quantity, price, currency, value, gainAbs, gainPct, weight }>
 *   }
 * }
 *
 * Response (JSON):
 * { reply: string, processingMs: number }
 */

import { getGroq } from '../lib/groqClient.js';
import { addLog }  from '../lib/logBuffer.js';
import { buildSystemMessage } from '../prompts/portfolioChat.js';
import { TEXT_MODEL } from '../lib/groqModels.js';
import { narrativeParams, isTruncated } from '../lib/groqNarrative.js';
import { respondIfAiNotConfigured } from '../lib/aiRouteGate.js';

const MODEL = TEXT_MODEL;
const MAX_HISTORY_TURNS = 8; // keep last 8 turns to stay within context budget

export async function portfolioChat(req, res) {
  const start = Date.now();
  const { messages = [], context } = req.body || {};

  if (!context || typeof context !== 'object') {
    return res.status(400).json({ error: 'context is required' });
  }
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages must be an array' });
  }
  // Each entry must be an object with string role + content (blocks null / primitives)
  if (!messages.every((m) => m && typeof m === 'object' && typeof m.role === 'string' && typeof m.content === 'string')) {
    return res.status(400).json({ error: 'messages must be objects with role and content strings' });
  }

  // Validate message roles to prevent prompt injection via role spoofing
  const safeMessages = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-MAX_HISTORY_TURNS)
    .map(m => ({ role: m.role, content: String(m.content).slice(0, 1000) }));

  if (safeMessages.length === 0 || safeMessages[safeMessages.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'Last message must be from user' });
  }
  if (respondIfAiNotConfigured(req, res)) return;

  try {
    const systemMessage = buildSystemMessage(context);

    const completion = await getGroq(30_000).chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      ...narrativeParams(MODEL, 768),
      messages: [
        { role: 'system', content: systemMessage },
        ...safeMessages,
      ],
    });

    const reply = completion.choices[0]?.message?.content?.trim() || '';

    // Empty reply = unusable; surface the unavailable message without charging quota.
    if (!reply || isTruncated(completion)) {
      addLog('error', 'ai', 'Chat: empty AI response (usage not counted)');
      return res.status(200).json({
        reply: 'Lo siento, el asistente no está disponible en este momento. Inténtalo de nuevo.',
        processingMs: Date.now() - start,
      });
    }

    // Increment usage counters only after a successful AI response
    await req.incrementUsage?.();

    const ms = Date.now() - start;
    addLog('ok', 'ai', `Chat reply generated · ${ms}ms`, { turns: safeMessages.length });
    return res.json({ reply, processingMs: ms });

  } catch (err) {
    console.error('[portfolio-chat] Groq error:', err.message);
    addLog('error', 'ai', `Chat error: ${err.message}`);
    return res.status(200).json({
      reply: 'Lo siento, el asistente no está disponible en este momento. Inténtalo de nuevo.',
      processingMs: Date.now() - start,
    });
  }
}
