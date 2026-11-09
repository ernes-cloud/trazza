/**
 * Códigos de error de IA que el cliente mapea a i18n (es/en).
 * El body lleva `code` (y `error` = mismo código por compatibilidad).
 * No mandar mensajes en español: el cliente traduce.
 */

export const AI_OVERLOADED = 'AI_OVERLOADED';
export const AI_UNAVAILABLE = 'AI_UNAVAILABLE';
export const AI_REGION_BLOCKED = 'AI_REGION_BLOCKED';

/** @param {typeof AI_OVERLOADED | typeof AI_UNAVAILABLE | typeof AI_REGION_BLOCKED} code */
export function aiErrorBody(code) {
  return { error: code, code };
}
