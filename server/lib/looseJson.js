/**
 * Tolerant JSON parser for LLM output.
 *
 * Models (especially vision models that ignore json mode) wrap their answer in
 * ```json fences```, add prose around it, or get cut off mid-array by max_tokens.
 * This recovers the intended object in all three cases:
 *   1. clean JSON                          → JSON.parse
 *   2. fenced / prose-wrapped JSON         → strip fences, trim to outer { … }
 *   3. truncated array of objects          → cut to the last closed "}" + "]}"
 *
 * Returns the parsed value, or null when nothing salvageable is found.
 */
export function parseLooseJson(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;

  // 1. clean JSON
  try { return JSON.parse(raw); } catch { /* continue */ }

  // 2. strip markdown code fences and any prose outside the first/last brace
  let s = raw.replace(/```(?:json)?/gi, '').trim();
  const first = s.indexOf('{');
  const last  = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  try { return JSON.parse(s); } catch { /* continue */ }

  // 3. truncation repair: keep complete objects, close the transactions array
  for (let cut = s.lastIndexOf('}'); cut > 0; cut = s.lastIndexOf('}', cut - 1)) {
    try { return JSON.parse(s.slice(0, cut + 1) + ']}'); } catch { /* try previous } */ }
  }
  return null;
}
