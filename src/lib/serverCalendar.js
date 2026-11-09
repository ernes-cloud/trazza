/**
 * Calendario de Nasdaq ya montado por el server (`GET /api/market-calendar/:kind`).
 *
 * Antes cada navegador lo montaba pidiendo UN día cada vez: ~86 peticiones de
 * dividendos y ~43 de resultados por carga del Dashboard. El server hace ese
 * trabajo una vez y lo comparte entre todos los usuarios.
 *
 * Devuelve las filas, o `null` si no se pudieron obtener (server parado en dev,
 * ruta aún sin desplegar, Nasdaq caído). Con `null` el llamante cae a su camino
 * de siempre, día a día — nunca se pinta un calendario vacío por esto.
 *
 * @param {'dividends'|'earnings'} kind
 * @param {{ fetchImpl?: typeof fetch }} [deps]
 * @returns {Promise<object[]|null>}
 */
export async function fetchServerCalendar(kind, { fetchImpl = fetch } = {}) {
  try {
    const r = await fetchImpl(`/api/market-calendar/${kind}`, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) return null;
    const json = await r.json();
    return Array.isArray(json?.rows) && json.rows.length > 0 ? json.rows : null;
  } catch {
    return null;
  }
}
