/**
 * Latidos (heartbeats) de Better Stack para los crons.
 *
 * Un monitor de disponibilidad dice si el server RESPONDE; no dice si sus jobs
 * HACEN su trabajo. Hasta el 2026-10-02 el cron de fotos llevaba semanas
 * resolviendo 0 de 44 cotizaciones sin que nadie se enterase. Cada job hace un
 * ping a su latido SOLO cuando la pasada ha sido sana; si los pings se
 * interrumpen, Better Stack alerta.
 *
 * Las URLs van en el .env del server (HEARTBEAT_*_URL), nunca en el repo: con
 * la URL cualquiera podría falsear un latido. Sin la variable es un no-op.
 */

/** Ping fire-and-forget. Nunca lanza: un fallo de red no puede tumbar un job. */
export function pingHeartbeat(envName) {
  const url = process.env[envName];
  if (!url) return;
  fetch(url, { method: 'GET', signal: AbortSignal.timeout(10_000) })
    .catch((e) => console.warn(`[heartbeat] ${envName}: ${e.message}`));
}

/** Mínimo de cotizaciones resueltas para dar por buena una pasada de fotos. */
export const MIN_QUOTE_RATIO = 0.5;

/**
 * ¿Pasada de fotos sana? Sin error, y con al menos la mitad de las cotizaciones
 * resueltas. Sin nada que cotizar (0 tickers) también es sana: no es un fallo.
 * @param {{error?:string, tickers?:number, quotesResolved?:number}|null|undefined} summary
 */
export function isHealthySnapshotRun(summary) {
  if (!summary || summary.error || summary.skipped) return false;
  const tickers = Number(summary.tickers) || 0;
  if (tickers === 0) return true;
  return (Number(summary.quotesResolved) || 0) / tickers >= MIN_QUOTE_RATIO;
}

/**
 * ¿Envío semanal sano? Solo cuenta una pasada que de verdad se ejecutó y sin
 * envíos fallidos. Ojo: `skipped` significa dos cosas en ese resumen — TEXTO
 * cuando el job no se ejecutó ('outside window', 'already running') y NÚMERO
 * (usuarios saltados) en una pasada normal. Solo el texto la descarta.
 * @param {{skipped?:string|number, failed?:number, users?:number}|null|undefined} summary
 */
export function isHealthyWeeklyRun(summary) {
  if (!summary || typeof summary.skipped === 'string') return false;
  return (Number(summary.failed) || 0) === 0;
}
