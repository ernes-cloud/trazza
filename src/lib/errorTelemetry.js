/**
 * Telemetría de errores de CLIENTE → POST /api/log-error.
 *
 * Por qué existe: los fallos de esta plataforma se descubrían mirándola. Un
 * interruptor que no apagaba lo que decía, un ISIN donde iba el nombre de la
 * empresa… todos con el servidor devolviendo 200 impecables, así que ningún
 * monitor de uptime los habría visto nunca. Esto es lo que faltaba.
 *
 * Los datos van al servidor propio (UE) y NO a un tercero: así la promesa de
 * "datos almacenados en Europa" de la landing y la lista de terceros de la
 * política de privacidad siguen siendo ciertas sin tocar una coma.
 *
 * Mismas reglas que `importTelemetry`: fire-and-forget, sin `await` desde el
 * llamante y tragándose todos los errores. Una telemetría que puede tumbar la
 * app es peor que no tener telemetría.
 */
import { scrubUrl, scrubText, fingerprint } from '@/lib/errorScrub';

// Tope por sesión. Un bug dentro de un `render` puede dispararse en bucle
// (React reintenta, el componente vuelve a fallar); sin tope, una pestaña
// abierta manda miles de peticiones y el que sufre el fallo además se come la
// red. 20 ocurrencias bastan para diagnosticar cualquier cosa.
const MAX_PER_SESSION = 20;

// Huellas ya enviadas EN ESTA SESIÓN: la segunda vez que pasa lo mismo no se
// reenvía. El contador de ocurrencias real lo lleva el servidor.
const seen = new Set();
let sent = 0;
// Cortacircuitos: si el propio reporte falla, no se intenta reportar ESE
// fallo (sería una recursión infinita a través de window.onerror).
let reporting = false;

/**
 * @param {object} p
 * @param {'render'|'window'|'promise'} p.kind  de dónde salió
 * @param {Error|any} p.error
 * @param {string} [p.componentStack]  el árbol de React, solo en 'render'
 */
export function reportClientError({ kind, error, componentStack }) {
  if (reporting || sent >= MAX_PER_SESSION) return;
  try {
    reporting = true;

    const message = scrubText(error?.message || String(error || 'unknown'), 300);
    const stack = scrubText(error?.stack || '', 4000);
    const fp = fingerprint({ kind, message, stack });
    if (seen.has(fp)) return;
    seen.add(fp);
    sent += 1;

    const body = {
      kind,
      fingerprint: fp,
      message,
      stack,
      component_stack: componentStack ? scrubText(componentStack, 2000) : undefined,
      // Ruta NORMALIZADA, nunca la URL real: `/share/:token`, no el token.
      route: scrubUrl(typeof window !== 'undefined' ? window.location.href : ''),
      user_agent: typeof navigator !== 'undefined' ? String(navigator.userAgent).slice(0, 300) : undefined,
      // Identifica el despliegue para saber si un error ya está arreglado.
      app_version: import.meta.env.VITE_APP_VERSION || undefined,
    };

    fetch('/api/log-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // Sobrevive a que el usuario cierre la pestaña justo tras el error, que
      // es exactamente lo que hace alguien cuando algo revienta.
      keepalive: true,
    }).catch(() => {});
  } catch (_) {
    // Best-effort por diseño.
  } finally {
    reporting = false;
  }
}

/**
 * Engancha los dos fallos que NO pasan por un ErrorBoundary de React:
 * errores sueltos de JS y promesas rechazadas sin `catch`.
 *
 * Se llama UNA vez desde main.jsx. Es idempotente.
 */
let installed = false;
export function installGlobalErrorHandlers() {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (e) => {
    // Los fallos de carga de un recurso (<img>, <script>) también disparan
    // 'error' pero no traen Error: no son bugs de código y solo harían ruido.
    if (!e?.error) return;
    reportClientError({ kind: 'window', error: e.error });
  });

  window.addEventListener('unhandledrejection', (e) => {
    reportClientError({ kind: 'promise', error: e?.reason });
  });
}
