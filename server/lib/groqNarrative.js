/**
 * Parámetros comunes de las respuestas en PROSA de Groq (puntuación de cartera,
 * análisis de resultados, chat). Puro y testeado.
 *
 * Por qué existe (2026-10-03): el modelo de producción es `openai/gpt-oss-120b`,
 * que RAZONA antes de contestar, y ese razonamiento cuenta contra `max_tokens`.
 * Las rutas tenían 650–768 tokens pensados para la respuesta sola, así que
 * cuando el modelo pensaba un poco más el análisis llegaba cortado a media
 * frase ("…ETF de salud para reducir exposición") y se cobraba la cuota igual.
 * Las respuestas JSON ya lo resolvían en groqJson.js con reasoning_effort bajo.
 */

/** Presupuesto extra para el razonamiento interno de los modelos que razonan. */
export const REASONING_BUDGET = 1500;

export const isReasoningModel = (model) => /gpt-oss/i.test(String(model || ''));

/**
 * @param {string} model
 * @param {number} answerTokens  lo que debe caber de RESPUESTA visible
 * @returns {{ max_tokens: number, reasoning_effort?: string }}
 */
export function narrativeParams(model, answerTokens) {
  if (!isReasoningModel(model)) return { max_tokens: answerTokens };
  return { max_tokens: answerTokens + REASONING_BUDGET, reasoning_effort: 'low' };
}

/** La respuesta se cortó por el límite de tokens: no es un texto entregable. */
export const isTruncated = (completion) => completion?.choices?.[0]?.finish_reason === 'length';
