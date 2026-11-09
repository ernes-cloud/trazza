import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Tira horizontal scrollable con barra VISIBLE y difuminado en los bordes.
 *
 * Las listas de favoritos se salen del ancho en cuanto pasan de media docena, y
 * hasta ahora iban con `no-scrollbar`: se podía arrastrar, pero nada indicaba
 * que quedaran más a la derecha. Aquí la barra se ve (`custom-scrollbar-x`) y
 * además el contenido se desvanece por el lado hacia el que SE PUEDE seguir
 * desplazando — se apaga solo al llegar al extremo.
 *
 * El difuminado es un `mask-image` sobre el propio contenido, no un degradado
 * encima: así no hay que acertar con el color del fondo (que cambia entre la
 * tarjeta del Dashboard y la pantalla de Favoritos, y entre claro y oscuro).
 *
 * `touch-pan-x` + `overscroll-x-contain`: en táctil compromete el gesto al eje
 * horizontal y evita que el swipe encadene con el "atrás" del navegador.
 */
const FADE = '1.5rem';

export default function ScrollStrip({ children, className = '', innerClassName = '' }) {
  const ref = useRef(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    // 1 px de tolerancia: los anchos fraccionarios dejan un residuo que si no
    // haría parpadear el difuminado con la tira ya al final.
    setEdges({ left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 });
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    // El contenedor cambia de ancho al plegar la barra lateral o rotar el móvil.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => { el.removeEventListener('scroll', measure); ro?.disconnect(); };
  }, [measure, children]); // `children`: una lista nueva o renombrada re-mide

  // Sin nada que desplazar no se pone máscara: un `mask-image` constante
  // difuminaría la primera y la última pestaña sin motivo.
  const maskImage = (() => {
    if (!edges.left && !edges.right) return undefined;
    const start = edges.left ? `transparent, black ${FADE}` : 'black';
    const end = edges.right ? `black calc(100% - ${FADE}), transparent` : 'black';
    return `linear-gradient(to right, ${start}, ${end})`;
  })();

  return (
    <div className={`relative ${className}`}>
      <div
        ref={ref}
        style={{ maskImage, WebkitMaskImage: maskImage }}
        className={`flex items-center overflow-x-auto overflow-y-hidden custom-scrollbar-x touch-pan-x overscroll-x-contain ${innerClassName}`}
      >
        {children}
      </div>
    </div>
  );
}
