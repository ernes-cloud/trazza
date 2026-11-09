/**
 * Sustituto de `react-style-singleton` (alias en vite.config.js) — misma API
 * que la 2.2.x: `stylesheetSingleton`, `styleHookSingleton`, `styleSingleton`.
 *
 * Por qué: Radix lo usa (vía react-remove-scroll-bar) para bloquear el scroll
 * del fondo al abrir un diálogo, un menú o un select, y lo hace metiendo un
 * `<style>` con texto en el <head>. La CSP no lleva 'unsafe-inline' en
 * style-src (2026-10-26, auditoría 7f2c915d M1), así que ese `<style>` se
 * bloqueaba: un error de CSP por apertura y el fondo seguía haciendo scroll
 * (medido con Playwright: `overflow: visible` en vez de `hidden`).
 *
 * Aquí la hoja es CONSTRUIDA (`new CSSStyleSheet()` + `adoptedStyleSheets`):
 * es CSSOM, que la CSP no restringe. Si el navegador no tiene hojas
 * construidas (Safari < 16.4) se cae al `<style>` de siempre, que con la CSP
 * estricta se bloquea — lo mismo que pasaría sin este fichero.
 */
import * as React from 'react';

const canAdopt = () => typeof document !== 'undefined'
  && typeof CSSStyleSheet === 'function'
  && 'replaceSync' in CSSStyleSheet.prototype
  && 'adoptedStyleSheets' in document;

function addSheet(css) {
  if (typeof document === 'undefined') return null;
  if (canAdopt()) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return { remove: () => { document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet); } };
  }
  const tag = document.createElement('style');
  tag.appendChild(document.createTextNode(css));
  (document.head || document.getElementsByTagName('head')[0]).appendChild(tag);
  return { remove: () => tag.parentNode?.removeChild(tag) };
}

/** Una hoja compartida: se añade con el primer `add` y se quita con el último `remove`. */
export const stylesheetSingleton = () => {
  let counter = 0;
  let handle = null;
  return {
    add: (style) => {
      if (counter === 0) handle = addSheet(style);
      counter += 1;
    },
    remove: () => {
      counter -= 1;
      if (!counter && handle) {
        handle.remove();
        handle = null;
      }
    },
  };
};

export const styleHookSingleton = () => {
  const sheet = stylesheetSingleton();
  return (styles, isDynamic) => {
    React.useEffect(() => {
      sheet.add(styles);
      return () => sheet.remove();
      // Mismo array de dependencias que el original (solo se rehace si es dinámico).
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [styles && isDynamic]);
  };
};

export const styleSingleton = () => {
  const useStyle = styleHookSingleton();
  const Sheet = ({ styles, dynamic }) => {
    useStyle(styles, dynamic);
    return null;
  };
  return Sheet;
};
