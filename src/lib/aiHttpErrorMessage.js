/**
 * Mensaje de error de endpoints de IA para la UI.
 * El server manda `code` (AI_OVERLOADED | AI_UNAVAILABLE | AI_REGION_BLOCKED) y
 * a veces `error` legacy (`service_unavailable`). Cada código → clave i18n;
 * no colapsar todos los 503 en un solo mensaje.
 *
 * @param {{ status?: number, error?: string, code?: string, t: (key: string) => string }} opts
 */

const CODE_TO_KEY = {
  AI_OVERLOADED: 'cartera.ai_overloaded',
  AI_UNAVAILABLE: 'cartera.ai_unavailable',
  AI_REGION_BLOCKED: 'cartera.ai_region_blocked',
  'Payload too large': 'cartera.ai_payload_too_large',
  // rateLimiter (TDD): sigue enviando solo { error: 'service_unavailable' }
  service_unavailable: 'cartera.ai_unavailable',
};

export function aiHttpErrorMessage({ status, error, code, t }) {
  const token = code || error;
  if (token && CODE_TO_KEY[token]) {
    return t(CODE_TO_KEY[token]);
  }
  // Mensaje humano legacy del server (antes de códigos): no mostrarlo crudo si
  // parece snake_case; sí si es texto (p. ej. 502 de visión sin code).
  if (error && typeof error === 'string' && !/^[a-z][a-z0-9_]*$/i.test(error) && !/^AI_/.test(error)) {
    return error;
  }
  return t('cartera.ai_unavailable');
}
