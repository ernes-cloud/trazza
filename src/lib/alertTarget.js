// Valida el objetivo de una alerta de Favoritos antes de guardarla.
//
// Sin límites se guardaron alertas de "±1e-21%" y "±0.01%": saltan con
// CUALQUIER movimiento, así que cada día hábil producían un aviso (y un correo)
// que no significaba nada. Por debajo de 0,1% el movimiento es ruido de cotización.
export const MIN_PERCENT = 0.1;
export const MAX_PERCENT = 100;

/**
 * @param {'PERCENT_CHANGE'|'PRICE_TARGET'} type
 * @param {string} raw  lo que tecleó el usuario; admite coma decimal ("0,5")
 * @returns {{ ok: true, value: number } | { ok: false, reason: 'invalid'|'min_percent'|'max_percent' }}
 */
export function parseAlertTarget(type, raw) {
  const text = String(raw ?? '').trim().replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(text)) return { ok: false, reason: 'invalid' };
  const n = Number(text);
  if (!Number.isFinite(n)) return { ok: false, reason: 'invalid' };

  if (type === 'PERCENT_CHANGE') {
    const pct = Math.abs(n);
    if (pct < MIN_PERCENT) return { ok: false, reason: 'min_percent' };
    if (pct > MAX_PERCENT) return { ok: false, reason: 'max_percent' };
    return { ok: true, value: pct };
  }

  if (n <= 0) return { ok: false, reason: 'invalid' };
  return { ok: true, value: n };
}
