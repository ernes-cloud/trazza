import { lazy, createElement, useState } from 'react';

/**
 * `React.lazy` con `.preload()`. Si el módulo ya está descargado cuando se monta
 * la página, la pinta en el PRIMER render en vez de suspender: React 18 suspende
 * siempre un `lazy` la primera vez, aunque su promesa ya esté resuelta, y eso
 * enseñaba el spinner de la ruta encima del HTML prerenderizado (main.jsx
 * precarga la ruta antes de montar la app).
 *
 * La elección se fija al montar (useState): cambiar de `lazy` a directo en un
 * re-render remontaría la página y perdería su estado.
 */
export function lazyPage(factory) {
  let mod = null;
  let pending = null;
  const load = () => {
    if (!pending) {
      pending = factory().then(
        (m) => { mod = m; return m; },
        (e) => { pending = null; throw e; },
      );
    }
    return pending;
  };
  const Lazy = lazy(load);
  function LazyPage(props) {
    const [direct] = useState(() => mod !== null);
    return direct ? createElement(mod.default, props) : createElement(Lazy, props);
  }
  LazyPage.preload = load;
  return LazyPage;
}
