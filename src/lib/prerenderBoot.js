/**
 * Estado del arranque de la SPA respecto al prerender (ver lib/prerender.js).
 *
 * Si main.jsx arranca sobre el HTML prerenderizado de ESTA URL, la página ya se
 * ve entera antes de que React monte: repetir la animación de entrada
 * (`initial={{ opacity: 0 }}` de framer-motion) la haría desaparecer y volver a
 * aparecer. Por eso los `initial=` de la web pública pasan por `motionInitial`.
 *
 * Mientras se PRERENDERIZA (Chromium en el postbuild) no se salta nada: el HTML
 * se captura cuando las animaciones ya terminaron.
 */

let booted = false;

/** Lo llama main.jsx antes del primer render cuando #root trae el prerender de esta URL. */
export function markBootedFromPrerender() {
  booted = true;
}

export function bootedFromPrerender() {
  return booted;
}

/** `initial` de framer-motion: false (sin animación de entrada) si se arrancó desde prerender. */
export function motionInitial(value) {
  return booted ? false : value;
}

/** ¿Lo está abriendo tools/prerender.mjs? (marca `window.__TRAZZA_PRERENDER__`). */
export function isPrerendering() {
  return typeof window !== 'undefined' && window.__TRAZZA_PRERENDER__ === true;
}
