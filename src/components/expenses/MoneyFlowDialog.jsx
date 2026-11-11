import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Waypoints, ArrowDown, ChevronDown } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { computeMoneyFlow, categoryLabel } from '@/services/expenseService';

// Same categorical palette as the donut, so a category keeps its colour across
// both widgets. Savings and deficit get semantic colours instead.
const PALETTE = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#6366f1', '#f97316', '#14b8a6', '#a855f7', '#64748b'];
const SAVED_COLOR = '#2563eb';
const DEFICIT_COLOR = '#f43f5e';
const INCOME_COLOR = '#059669';

// Geometry (viewBox units). Labels live inside the SVG so the whole thing
// scales as one piece on any width.
const VB_W = 900;
const LEFT_LABEL_X = 146;
const LEFT_NODE_X = 154;
const TRUNK_X = 434;
const TRUNK_W = 18;
const RIGHT_NODE_X = 726;
const RIGHT_LABEL_X = 748;
const NODE_W = 14;
const NODE_GAP = 6;   // vertical gap between stacked nodes
const MIN_NODE_H = 3; // a 0.4% slice must still be visible/clickable

/** Stacks nodes into [y, height] bands proportional to their value. */
const layout = (nodes, total, height) => {
  const gaps = NODE_GAP * Math.max(0, nodes.length - 1);
  const usable = Math.max(0, height - gaps);
  let y = 0;
  return nodes.map((n) => {
    const h = Math.max(MIN_NODE_H, total > 0 ? (n.value / total) * usable : 0);
    const band = { ...n, y, h };
    y += h + NODE_GAP;
    return band;
  });
};

/** Horizontal ribbon from (x1,y1,h1) to (x2,y2,h2) with cubic easing. */
const ribbon = (x1, y1, h1, x2, y2, h2) => {
  const cx = (x1 + x2) / 2;
  return [
    `M ${x1} ${y1}`,
    `C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`,
    `L ${x2} ${y2 + h2}`,
    `C ${cx} ${y2 + h2}, ${cx} ${y1 + h1}, ${x1} ${y1 + h1}`,
    'Z',
  ].join(' ');
};

/**
 * "Where did the money go" — a Sankey of one month: income sources on the left,
 * a single trunk in the middle, expense categories + savings on the right.
 *
 * The model (expenseService.computeMoneyFlow) guarantees both sides balance:
 * a surplus shows up as a savings sink, a deficit as a savings source, so the
 * ribbon widths never lie about where the money came from.
 *
 * Pure SVG (no chart lib): the ribbons are cubic beziers whose thickness IS the
 * amount, which is the whole point — you read proportions without a legend.
 */
const MoneyFlowDialog = ({ open, onOpenChange, entries = [], year, month, fxOpts, formatMoney, formatPercent }) => {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(null); // `${side}:${category}`
  // Posición del puntero dentro del contenedor, para anclar la tarjeta de hover.
  // Se guarda en px de pantalla (no en unidades del viewBox) porque el SVG
  // escala: convertir de vuelta daría un desfase distinto en cada anchura.
  const [pointer, setPointer] = useState(null);
  // Móvil: el detalle de un canal se abre con un TOQUE, no con hover (que no
  // existe en una pantalla táctil). Estado aparte del `hovered` del SVG.
  const [expanded, setExpanded] = useState(null);

  const flow = useMemo(
    () => computeMoneyFlow(entries, { year, month, ...fxOpts }),
    [entries, year, month, fxOpts],
  );

  const monthNames = t('expenses.month_names', { returnObjects: true });
  const pct = formatPercent || ((v) => `${Math.round(v)}%`);

  // Taller diagram when there are more bands, so thin categories stay readable.
  const height = Math.max(320, Math.min(560, 40 * Math.max(flow.sources.length, flow.sinks.length) + 200));
  const VB_H = height + 40;
  const top = 20;

  const nodeLabel = (category) => {
    if (category === '__saved__') return t('expenses.flow_saved');
    if (category === '__deficit__') return t('expenses.flow_deficit');
    if (category === '__rest__') return t('expenses.donut_other');
    return categoryLabel(t, category);
  };
  const colorOf = (category, i, side) => {
    if (category === '__saved__') return SAVED_COLOR;
    if (category === '__deficit__') return DEFICIT_COLOR;
    return side === 'in' ? INCOME_COLOR : PALETTE[i % PALETTE.length];
  };

  const sources = layout(flow.sources, flow.total, height);
  const sinks = layout(flow.sinks, flow.total, height);

  // Ribbons meet the trunk in the same order as their nodes, so no two cross.
  const trunkH = height;
  let inCursor = 0;
  const inRibbons = sources.map((n, i) => {
    const th = flow.total > 0 ? (n.value / flow.total) * trunkH : 0;
    const seg = { node: n, i, trunkY: top + inCursor, trunkH: th };
    inCursor += th;
    return seg;
  });
  let outCursor = 0;
  const outRibbons = sinks.map((n, i) => {
    const th = flow.total > 0 ? (n.value / flow.total) * trunkH : 0;
    const seg = { node: n, i, trunkY: top + outCursor, trunkH: th };
    outCursor += th;
    return seg;
  });

  const isDimmed = (key) => hovered !== null && hovered !== key;

  // Nodo bajo el puntero (para la tarjeta de hover). `index` se conserva porque
  // el color de una banda depende de su POSICIÓN en la paleta, no del slug.
  const hoveredNode = (() => {
    if (!hovered) return null;
    const cut = hovered.indexOf(':');
    const side = hovered.slice(0, cut);
    const category = hovered.slice(cut + 1);
    const list = side === 'in' ? flow.sources : flow.sinks;
    const index = list.findIndex((n) => n.category === category);
    return index === -1 ? null : { ...list[index], side, index };
  })();

  const Band = ({ seg, side }) => {
    const { node, i } = seg;
    const key = `${side}:${node.category}`;
    const color = colorOf(node.category, i, side);
    const nodeX = side === 'in' ? LEFT_NODE_X : RIGHT_NODE_X;
    const path = side === 'in'
      ? ribbon(LEFT_NODE_X + NODE_W, top + node.y, node.h, TRUNK_X, seg.trunkY, seg.trunkH)
      : ribbon(TRUNK_X + TRUNK_W, seg.trunkY, seg.trunkH, RIGHT_NODE_X, top + node.y, node.h);
    return (
      <g
        onMouseEnter={() => setHovered(key)}
        onMouseLeave={() => setHovered(null)}
        onFocus={() => setHovered(key)}
        onBlur={() => setHovered(null)}
        tabIndex={0}
        role="img"
        aria-label={`${nodeLabel(node.category)}: ${formatMoney(node.value, 0)} (${pct(node.pct)})`}
        className="cursor-default focus:outline-hidden"
      >
        <path
          d={path}
          fill={color}
          className="transition-opacity duration-150"
          opacity={isDimmed(key) ? 0.08 : 0.42}
        />
        <rect
          x={nodeX} y={top + node.y} width={NODE_W} height={node.h} rx={3}
          fill={color}
          className="transition-opacity duration-150"
          opacity={isDimmed(key) ? 0.25 : 1}
        />
        {/* Las bandas finas no caben dos líneas de texto: se degrada a una sola
            y, por debajo de una línea, a ninguna — el nombre sigue disponible
            al pasar por encima y en el aria-label. Sin esto, una cartera con
            10 categorías pintaba las etiquetas unas sobre otras. */}
        {node.h >= 13 && (
          <text
            x={side === 'in' ? LEFT_LABEL_X : RIGHT_LABEL_X}
            y={top + node.y + node.h / 2 + (node.h >= 26 ? -2 : 4)}
            textAnchor={side === 'in' ? 'end' : 'start'}
            className="fill-slate-700 dark:fill-slate-200 transition-opacity duration-150"
            style={{ fontSize: 13, fontWeight: 600 }}
            opacity={isDimmed(key) ? 0.3 : 1}
          >
            {nodeLabel(node.category)}
          </text>
        )}
        {node.h >= 26 && (
          <text
            x={side === 'in' ? LEFT_LABEL_X : RIGHT_LABEL_X}
            y={top + node.y + node.h / 2 + 13}
            textAnchor={side === 'in' ? 'end' : 'start'}
            className="fill-slate-400 transition-opacity duration-150"
            style={{ fontSize: 11.5, fontFamily: '"JetBrains Mono", ui-monospace, monospace' }}
            opacity={isDimmed(key) ? 0.3 : 1}
          >
            {formatMoney(node.value, 0)} · {pct(node.pct)}
          </text>
        )}
      </g>
    );
  };

  /**
   * Detalle de un canal. UNA sola definición para las dos superficies: la
   * tarjeta de hover (escritorio) y la fila desplegada (móvil, donde no hay
   * hover que consultar). Si divergieran, el diagrama contaría una cosa
   * distinta según el tamaño de la pantalla.
   */
  const ChannelDetail = ({ node }) => (
    <>
      <dl className="space-y-1 text-[11px]">
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-slate-400">{t('expenses.flow_tip_of_month')}</dt>
          <dd className="font-ledger tabular-nums text-slate-600 dark:text-slate-300">{pct(node.pct)}</dd>
        </div>
        {node.category !== '__saved__' && node.category !== '__deficit__' && (
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-slate-400">
              {node.side === 'in' ? t('expenses.flow_tip_of_income') : t('expenses.flow_tip_of_expenses')}
            </dt>
            <dd className="font-ledger tabular-nums text-slate-600 dark:text-slate-300">{pct(node.sidePct)}</dd>
          </div>
        )}
        {node.count > 0 && (
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-slate-400">{t('expenses.flow_tip_movements')}</dt>
            <dd className="font-ledger tabular-nums text-slate-600 dark:text-slate-300">{node.count}</dd>
          </div>
        )}
      </dl>

      {node.collapsed > 0 && (
        <p className="mt-2 pt-2 border-t border-slate-100 dark:border-slate-700/60 text-[11px] text-slate-400">
          {t('expenses.flow_tip_collapsed', { count: node.collapsed })}
        </p>
      )}

      {/* El mayor movimiento del canal: el "¿y esto de dónde sale?"
          se responde sin salir del diagrama. */}
      {node.biggest && node.count > 1 && (
        <p className="mt-2 pt-2 border-t border-slate-100 dark:border-slate-700/60 text-[11px] text-slate-400">
          {t('expenses.flow_tip_biggest')}{' '}
          <span className="font-ledger tabular-nums font-bold text-slate-600 dark:text-slate-300">
            {formatMoney(node.biggest.amount, 0)}
          </span>
          {node.biggest.notes && <> · {node.biggest.notes}</>}
        </p>
      )}

      {(node.category === '__saved__' || node.category === '__deficit__') && flow.income > 0 && (
        <p className="mt-2 pt-2 border-t border-slate-100 dark:border-slate-700/60 text-[11px] text-slate-400">
          {t('expenses.flow_tip_savings_rate', { pct: pct((flow.net / flow.income) * 100) })}
        </p>
      )}
    </>
  );

  /**
   * Lado del flujo en móvil: una barra por canal cuyo ANCHO es su parte del mes
   * (el mismo `pct` que da el grosor de la cinta en el SVG), y un desplegable
   * con el detalle. Sustituye al diagrama porque el Sankey necesita ~620px de
   * ancho lógico: medido a 375px, el diálogo enseñaba SOLO la columna de
   * ingresos y los gastos quedaban fuera de pantalla tras un scroll horizontal
   * que casi nadie descubre.
   */
  const FlowSideList = ({ nodes, side }) => (
    <div className="space-y-1">
      {nodes.map((n, i) => {
        const key = `${side}:${n.category}`;
        const color = colorOf(n.category, i, side);
        const isOpen = expanded === key;
        return (
          <div key={n.category}>
            <button
              type="button"
              onClick={() => setExpanded(isOpen ? null : key)}
              aria-expanded={isOpen}
              className="w-full min-h-[44px] text-left rounded-lg px-2 py-2 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="flex items-baseline gap-1.5 min-w-0">
                  <span className="w-2 h-2 rounded-full shrink-0 self-center" style={{ backgroundColor: color }} />
                  <span className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 truncate">
                    {nodeLabel(n.category)}
                  </span>
                </span>
                <span className="flex items-baseline gap-1.5 shrink-0">
                  <span className="font-ledger tabular-nums text-[13px] font-bold text-slate-900 dark:text-white">
                    {formatMoney(n.value, 0)}
                  </span>
                  <span className="font-ledger tabular-nums text-[11px] text-slate-400">{pct(n.pct)}</span>
                  <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                </span>
              </div>
              <div className="mt-1.5 h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                {/* Suelo del 1,5%: un canal del 0,3% no puede quedar invisible */}
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.max(1.5, n.pct)}%`, backgroundColor: color }}
                />
              </div>
            </button>
            {isOpen && (
              <div className="mx-2 mb-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-800/50 p-2.5">
                <ChannelDetail node={{ ...n, side }} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  const sectionTitle = 'text-[10px] font-bold uppercase tracking-wider text-slate-400 px-2';

  const hasData = flow.total > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl dark:bg-slate-900 border-none">
        <DialogHeader>
          <DialogTitle className="dark:text-white flex items-center gap-2">
            <Waypoints className="w-4 h-4 text-blue-600" />
            {t('expenses.flow_title')}
          </DialogTitle>
          <DialogDescription>
            <span className="hidden md:inline">{monthNames[month - 1]} {year} · {t('expenses.flow_hint')}</span>
            {/* En móvil no hay diagrama que explicar (ver FlowSideList): la
                pista útil es que cada canal se despliega al tocarlo. */}
            <span className="md:hidden">{monthNames[month - 1]} {year} · {t('expenses.flow_tap_hint')}</span>
          </DialogDescription>
        </DialogHeader>

        {!hasData ? (
          <p className="text-sm text-slate-400 text-center py-16">{t('expenses.flow_empty')}</p>
        ) : (
          <>
            {/* Móvil: flujo en vertical. El Sankey necesita 620px de ancho
                lógico — por debajo de `md` no cabe ni con scroll horizontal
                usable, así que se sustituye (no se encoge). */}
            <div className="md:hidden space-y-3">
              <div>
                <p className={sectionTitle}>{t('expenses.flow_side_in')}</p>
                <FlowSideList nodes={flow.sources} side="in" />
              </div>

              {/* El tronco del mes: todo lo que entró y hay que repartir */}
              <div className="flex items-center gap-2 px-2">
                <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
                <ArrowDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                <span className="font-ledger tabular-nums text-[11px] font-bold text-slate-500 dark:text-slate-400">
                  {formatMoney(flow.total, 0)}
                </span>
                <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
              </div>

              <div>
                <p className={sectionTitle}>{t('expenses.flow_side_out')}</p>
                <FlowSideList nodes={flow.sinks} side="out" />
              </div>
            </div>

            <div
              className="relative overflow-x-auto custom-scrollbar hidden md:block"
              onMouseMove={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setPointer({ x: e.clientX - r.left, y: e.clientY - r.top, w: r.width });
              }}
              onMouseLeave={() => { setPointer(null); setHovered(null); }}
            >
              {/* Sin height fijo: el viewBox ya fija la proporción y un alto en
                  px con w-full solo produce bandas vacías arriba y abajo. */}
              <svg viewBox={`0 0 ${VB_W} ${VB_H}`} className="w-full min-w-[620px] h-auto">
                {/* Trunk — everything that came in during the month */}
                <rect
                  x={TRUNK_X} y={top} width={TRUNK_W} height={trunkH} rx={4}
                  className="fill-slate-300 dark:fill-slate-600"
                  opacity={hovered ? 0.45 : 0.9}
                />
                {inRibbons.map((seg) => <Band key={`in-${seg.node.category}`} seg={seg} side="in" />)}
                {outRibbons.map((seg) => <Band key={`out-${seg.node.category}`} seg={seg} side="out" />)}
                <text
                  x={TRUNK_X + TRUNK_W / 2} y={top - 6} textAnchor="middle"
                  className="fill-slate-400"
                  style={{ fontSize: 10, letterSpacing: '0.2em', fontFamily: '"JetBrains Mono", ui-monospace, monospace' }}
                >
                  {formatMoney(flow.total, 0)}
                </text>
              </svg>

              {/* Tarjeta de hover del canal. Se ancla al puntero y se voltea al
                  otro lado cuando quedaría fuera por la derecha. pointer-events
                  desactivados: no debe robarle el hover a la cinta de debajo. */}
              {hoveredNode && pointer && (
                <div
                  className="pointer-events-none absolute z-20 w-56 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl p-3"
                  style={{
                    left: pointer.x + (pointer.x > pointer.w - 240 ? -236 : 16),
                    top: Math.max(4, pointer.y - 12),
                  }}
                >
                  <p className="flex items-center gap-2 text-xs font-bold text-slate-900 dark:text-white">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: colorOf(hoveredNode.category, hoveredNode.index, hoveredNode.side) }}
                    />
                    {nodeLabel(hoveredNode.category)}
                  </p>
                  <p className="font-ledger text-lg font-bold tabular-nums tracking-tight text-slate-900 dark:text-white mt-0.5">
                    {formatMoney(hoveredNode.value, 2)}
                  </p>

                  <div className="mt-2 pt-2 border-t border-slate-100 dark:border-slate-700/60">
                    <ChannelDetail node={hoveredNode} />
                  </div>
                </div>
              )}
            </div>

            {/* Leyenda: las categorías pequeñas quedan en cintas de pocos píxeles
                sin etiqueta dentro del SVG. Aquí se leen todas. Solo acompaña al
                diagrama: en móvil la lista ya nombra cada canal, y estos chips
                de 21px de alto no llegan al mínimo táctil. */}
            <div className="hidden md:flex flex-wrap justify-center gap-x-4 gap-y-1.5 pb-3">
              {sinks.map((n, i) => (
                <button
                  key={n.category}
                  type="button"
                  onMouseEnter={() => setHovered(`out:${n.category}`)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(`out:${n.category}`)}
                  onBlur={() => setHovered(null)}
                  className={`inline-flex items-center gap-1.5 text-[11px] rounded-md px-1.5 py-0.5 transition-opacity ${isDimmed(`out:${n.category}`) ? 'opacity-40' : ''}`}
                >
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: colorOf(n.category, i, 'out') }} />
                  <span className="text-slate-600 dark:text-slate-300">{nodeLabel(n.category)}</span>
                  <span className="font-ledger tabular-nums text-slate-400">{formatMoney(n.value, 0)}</span>
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 pt-2 text-xs border-t border-slate-100 dark:border-slate-700/50">
              <span className="text-slate-400 font-ledger tabular-nums">
                {t('expenses.tile_income')}:{' '}
                <span className="font-bold text-emerald-600 dark:text-emerald-400">{formatMoney(flow.income, 0)}</span>
              </span>
              <span className="text-slate-400 font-ledger tabular-nums">
                {t('expenses.tile_expenses')}:{' '}
                <span className="font-bold text-rose-500 dark:text-rose-400">{formatMoney(flow.expenses, 0)}</span>
              </span>
              <span className="text-slate-400 font-ledger tabular-nums">
                {flow.net >= 0 ? t('expenses.flow_saved') : t('expenses.flow_deficit')}:{' '}
                <span className={`font-bold ${flow.net >= 0 ? 'text-blue-600 dark:text-blue-400' : 'text-rose-500 dark:text-rose-400'}`}>
                  {formatMoney(Math.abs(flow.net), 0)}
                </span>
              </span>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default MoneyFlowDialog;
