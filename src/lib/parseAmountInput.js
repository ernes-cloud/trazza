/** Parse user-typed money from `type="text" inputMode="decimal"` fields (comma or dot decimals). */
export function parseAmountInput(raw) {
  const s = String(raw ?? '').trim().replace(/\s|\u00a0|€|\$|£/g, '');
  if (s === '') return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let normalized;
  if (lastComma === -1 && lastDot === -1) {
    normalized = s;
  } else if (lastComma > lastDot) {
    normalized = s.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma) {
    normalized = s.replace(/,/g, '');
  } else {
    normalized = s;
  }
  if (!/^-?\d*\.?\d*$/.test(normalized)) return null;
  const value = parseFloat(normalized);
  return Number.isFinite(value) ? value : null;
}
