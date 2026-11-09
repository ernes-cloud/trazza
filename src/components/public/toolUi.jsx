import { TOOL_COLORS } from './PublicToolShell';

/* Piezas de formulario y resultado compartidas por las calculadoras públicas.
   Tema claro FIJO (sin `dark:`), como todas las páginas públicas. */
const { TEXT, MUTED, FAINT, RULE, ACCENT } = TOOL_COLORS;

/** Formato de importe según idioma, con separador de miles SIEMPRE (es-ES lo omite en 4 cifras). */
export function makeMoney(lang) {
  const locale = lang?.startsWith('en') ? 'en-US' : 'es-ES';
  const fmt = new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0, useGrouping: 'always' });
  const fmt2 = new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' });
  return { money: (v) => fmt.format(v || 0), money2: (v) => fmt2.format(v || 0), locale };
}

/**
 * Campo numérico. `type="text" inputMode="decimal"` y NO `type="number"`: el
 * number del HTML solo acepta punto decimal y un "12,50" llega vacío (ver
 * CLAUDE.md, anti-patterns). El valor se lee con parseAmountInput.
 */
export function NumberField({ id, label, hint, value, onChange, suffix }) {
  return (
    <label htmlFor={id} className="block">
      <span className="block text-[13px] font-semibold mb-1.5" style={{ color: TEXT }}>{label}</span>
      <span className="flex items-center rounded-lg bg-white focus-within:ring-2 focus-within:ring-blue-500/40" style={{ border: `1px solid ${RULE}` }}>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          size={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-[15px] tabular-nums outline-hidden"
          style={{ color: TEXT }}
        />
        {suffix && <span className="pr-3 text-[13px]" style={{ color: FAINT }}>{suffix}</span>}
      </span>
      {hint && <span className="block text-[12px] mt-1" style={{ color: FAINT }}>{hint}</span>}
    </label>
  );
}

/** Fila del desglose: etiqueta a la izquierda, importe a la derecha. */
export function ResultRow({ label, value, strong = false, tone }) {
  const color = tone === 'negative' ? '#b91c1c' : tone === 'accent' ? ACCENT : TEXT;
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5" style={{ borderBottom: `1px solid ${RULE}` }}>
      <span className={`text-[14px] ${strong ? 'font-semibold' : ''}`} style={{ color: strong ? TEXT : MUTED }}>{label}</span>
      <span className={`tabular-nums ${strong ? 'text-[17px] font-bold' : 'text-[15px] font-semibold'}`} style={{ color }}>{value}</span>
    </div>
  );
}

/** Cifra principal del resultado. */
export function HeroNumber({ label, value, sub }) {
  return (
    <div>
      <p className="font-ledger text-[11px] uppercase tracking-[0.2em]" style={{ color: FAINT }}>{label}</p>
      <p className="font-display text-4xl md:text-5xl font-black tracking-tight mt-1 tabular-nums" style={{ color: TEXT }}>{value}</p>
      {sub && <p className="text-[14px] mt-1.5" style={{ color: MUTED }}>{sub}</p>}
    </div>
  );
}
