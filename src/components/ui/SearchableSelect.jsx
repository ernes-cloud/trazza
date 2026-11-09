import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search, Check } from 'lucide-react';
import { filterOptions } from '@/lib/optionSearch';

/**
 * Desplegable con buscador. Sustituye a un `<select>` cuando la lista crece lo
 * bastante como para que encontrar una opción a ojo sea el trabajo caro (el
 * caso real: las categorías de Gastos, que el usuario amplía con las suyas).
 *
 * Pensado para vivir DENTRO de un diálogo Radix:
 *  - el panel se renderiza en el flujo (no en un portal), así que el foco no
 *    se sale de la trampa de foco del diálogo;
 *  - Escape cierra el panel y NO el diálogo (stopPropagation) — cerrarle a
 *    alguien el formulario entero por descartar un desplegable es hostil.
 *
 * La lógica de filtrado vive en `lib/optionSearch.js` (pura y testeada).
 *
 * Props:
 *  - value / onChange(value)
 *  - options: [{ value, label, triggerLabel? }] — `triggerLabel` es la forma
 *    corta que se pinta en el botón; la búsqueda siempre casa contra `label`
 *  - action?: { value, label } — fila fija al final (p.ej. "Nueva categoría")
 *  - panelClassName? — ancho/anclado del panel (por defecto `w-full`, el ancho
 *    del disparador); útil cuando el disparador es demasiado estrecho
 */
const SearchableSelect = ({
  value, onChange, options = [], action,
  className = '', searchPlaceholder = '', emptyText = '', placeholder = '',
  // Por defecto el panel mide lo que el disparador (`w-full`), que es lo que
  // quiere un formulario. Cuando el disparador es estrecho —la moneda en la
  // cabecera de la cartera compartida— eso recorta las etiquetas a una letra,
  // así que el panel puede pedir su propio ancho y anclado (p.ej. "w-64 right-0").
  panelClassName = 'w-full',
  ariaLabel,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const selected = options.find((o) => o.value === value);
  const visible = useMemo(() => filterOptions(options, query), [options, query]);
  // La acción ("Nueva categoría") es una fila más para el teclado, pero NUNCA
  // se filtra: es la salida cuando la búsqueda no encuentra nada.
  const rows = action ? [...visible, action] : visible;

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setHighlight(Math.max(0, options.findIndex((o) => o.value === value)));
    // Autofoco SOLO con ratón: en un móvil abriría el teclado encima de la
    // lista que el usuario acaba de desplegar.
    if (window.matchMedia?.('(pointer: fine)').matches) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clic fuera: cierra sin elegir.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [open]);

  // Mantiene visible la fila resaltada al navegar con el teclado.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-highlighted="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [highlight, open]);

  const choose = (option) => {
    setOpen(false);
    onChange(option.value);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      if (!open) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      if (!rows.length) return;
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setHighlight((h) => (h + delta + rows.length) % rows.length);
      return;
    }
    if (e.key === 'Enter' && open) {
      e.preventDefault();
      const row = rows[highlight];
      if (row) choose(row);
    }
  };

  return (
    <div ref={rootRef} className="relative" onKeyDown={handleKeyDown}>
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        className={`${className} flex items-center justify-between gap-2 text-left`}
      >
        {/* `triggerLabel` (opcional) deja poner en el botón una forma corta de
            la opción y reservar la larga para la lista y la búsqueda: el caso
            real es la moneda de la cartera compartida, donde el botón vive en
            una cabecera estrecha ("USD") pero se busca por nombre ("dólar"). */}
        <span className={`truncate ${selected ? '' : 'text-slate-400'}`}>
          {selected ? (selected.triggerLabel ?? selected.label) : placeholder}
        </span>
        <ChevronDown className={`w-4 h-4 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className={`absolute z-30 mt-1 ${panelClassName} rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-xl overflow-hidden`}>
          <div className="flex items-center gap-2 px-2.5 py-2 border-b border-slate-100 dark:border-slate-700">
            <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            {/* size={1} + min-w-0: un input impone su ancho intrínseco (~20
                caracteres) como mínimo y estiraría el panel en un móvil. */}
            <input
              ref={inputRef}
              type="text"
              size={1}
              autoComplete="off"
              className="flex-1 min-w-0 bg-transparent outline-hidden text-sm text-slate-900 dark:text-white placeholder:text-slate-400"
              placeholder={searchPlaceholder}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setHighlight(0); }}
            />
          </div>

          <div ref={listRef} role="listbox" className="max-h-56 overflow-y-auto custom-scrollbar py-1">
            {rows.length === 0 && (
              <p className="px-3 py-3 text-xs text-slate-400 text-center">{emptyText}</p>
            )}
            {rows.map((opt, i) => {
              const isAction = action && opt.value === action.value;
              const isSelected = opt.value === value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-highlighted={i === highlight}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => choose(opt)}
                  className={`w-full min-h-[40px] lg:min-h-0 flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                    i === highlight ? 'bg-slate-100 dark:bg-slate-700/60' : ''
                  } ${isAction ? 'text-blue-600 dark:text-blue-400 font-semibold border-t border-slate-100 dark:border-slate-700' : 'text-slate-700 dark:text-slate-200'}`}
                >
                  <span className="truncate flex-1">{opt.label}</span>
                  {isSelected && !isAction && <Check className="w-3.5 h-3.5 shrink-0 text-blue-600 dark:text-blue-400" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default SearchableSelect;
