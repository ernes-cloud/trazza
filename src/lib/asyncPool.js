/**
 * Concurrencia acotada y reintento para las llamadas a market data.
 *
 * POR QUÉ EXISTE ESTE MÓDULO: un `Promise.all` sobre todos los tickers de una
 * cartera es una RÁFAGA, y Yahoo estrangula las ráfagas. Cada 429 que provoca
 * deja un activo sin precio o sin histórico, y un activo sin histórico vale
 * CERO en toda la serie de rendimiento — así que el síntoma no es "falta un
 * dato", es un porcentaje equivocado enseñado como si fuera bueno (medido el
 * 2026-09-11: la misma cartera daba 78,76% en el Dashboard y 98,79% en
 * brokers). Es la misma razón por la que `fundNavEnricher` y `fundSectors` van
 * secuenciales.
 *
 * Vivía privado dentro de `usePortfolioPerformance`, así que la serie de
 * rendimiento estaba defendida y el resto del Dashboard (treemap/Wallet Map,
 * "Invertido", enriquecido de sectores) seguía disparando a ráfaga. Al sacarlo
 * aquí hay UNA sola definición: si se toca el tamaño del pool o la política de
 * reintento, cambia para todas las superficies a la vez.
 */

/** Peticiones simultáneas por defecto. Empírico, no teórico: por encima de esto
 *  Yahoo empieza a devolver 429 con carteras grandes. */
export const DEFAULT_POOL_SIZE = 4;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ejecuta `jobs` (thunks que devuelven promesa) de `size` en `size`.
 *
 * Devuelve los resultados EN EL ORDEN de entrada, no en el de finalización, para
 * que sea sustituible por un `Promise.all` sin tocar al llamante. Si un job
 * lanza, la excepción se propaga y el pool se detiene: los llamantes de UI deben
 * capturar DENTRO del job (que es lo que ya hacen), porque un ticker que falla
 * no puede cancelar el resto de la cartera.
 */
export async function runPooled(jobs, size = DEFAULT_POOL_SIZE) {
  const results = new Array(jobs.length);
  let next = 0;

  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= jobs.length) return;
      results[i] = await jobs[i]();
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(size, jobs.length) }, worker)
  );
  return results;
}

/**
 * Igual que `runPooled`, pero con la forma de `Promise.allSettled`: un job que
 * lanza NO detiene el pool, se anota como `{ status: 'rejected', reason }`.
 * Sustituye a un `Promise.allSettled(tickers.map(...))` sin tocar al llamante.
 */
export function runPooledSettled(jobs, size = DEFAULT_POOL_SIZE) {
  return runPooled(
    jobs.map((job) => async () => {
      try {
        return { status: 'fulfilled', value: await job() };
      } catch (reason) {
        return { status: 'rejected', reason };
      }
    }),
    size
  );
}

/**
 * Reintenta `fn` ante un fallo transitorio (el 429 de Yahoo lo es).
 *
 * La espera lleva JITTER a propósito: dos pestañas del mismo usuario que
 * reintentan a la vez no deben sincronizarse y volver a chocar. `sleepFn` es
 * inyectable para que los tests no esperen de verdad.
 *
 * Lanza el último error si se agotan los intentos — el llamante decide si eso
 * es un hueco tolerable (un `.catch(() => null)`) o un fallo que propagar.
 */
export async function withRetry(fn, { attempts = 2, baseDelay = 500, jitter = 500, sleepFn = sleep } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < attempts - 1) await sleepFn(baseDelay + Math.random() * jitter);
    }
  }
  throw lastErr;
}
