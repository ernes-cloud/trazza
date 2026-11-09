import React from 'react';
import { ResponsiveContainer, Treemap, Tooltip } from 'recharts';
import { LayoutGrid } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePrivacyMode } from '@/contexts/PrivacyModeContext';
import { isOpaqueTicker } from '@/lib/tickerLabel';
import { formatPercent, formatNumber } from '@/lib/formatters';

/* ── Ledger palette ──
   Semantic colours match the rest of the platform (emerald gains, rose losses).
   The tile canvas / separator is theme-aware: deep navy in Ledger dark mode,
   warm paper in light mode, so the widget lives inside the standard card chrome
   in BOTH themes instead of always being a GitHub-dark island. */
const GAIN_COLOR = '#059669'; // emerald-600
const LOSS_COLOR = '#f43f5e'; // rose-500
const MONO = '"JetBrains Mono", ui-monospace, monospace';

const isDarkTheme = () =>
  typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

// Gap/canvas colour behind the tiles (also the tile stroke)
const canvasColor = () => (isDarkTheme() ? '#070d18' : '#e3ddd0');

// Gris para "no hay dato" Y para el cero exacto: un activo que no se ha movido
// no ha subido. Pintarlo de verde —que es lo que hacía el >= 0— convertía una
// cartera de fondos, que nunca traen variación diaria, en un tablero entero en
// verde con todos los valores a +0,00%.
const FLAT_COLOR = '#94a3b8';
export const getTileColor = (change) => {
  if (!Number.isFinite(change) || change === 0) return FLAT_COLOR;
  return change > 0 ? GAIN_COLOR : LOSS_COLOR;
};

/* Relleno de la baldosa en degradado: un +0,1 % y un +2,5 % no pueden pintarse
   del mismo verde. Va del tono suave al intenso y satura en ±GRADIENT_FULL_AT %
   (la escala de finviz). La raíz cuadrada abre las variaciones pequeñas, que
   son las habituales en una cartera de fondos: con una escala lineal todo lo
   que se mueve menos de un 1 % salía casi igual de pálido.
   Los extremos suaves aguantan el texto blanco gracias al contorno oscuro. */
const GRADIENT_FULL_AT = 3;
const GAIN_SCALE = ['#5fb894', '#047857'];
const LOSS_SCALE = ['#f08a99', '#be123c'];

const mixHex = (from, to, t) => {
  const channel = (i) => {
    const a = parseInt(from.slice(i, i + 2), 16);
    const b = parseInt(to.slice(i, i + 2), 16);
    return Math.round(a + (b - a) * t).toString(16).padStart(2, '0');
  };
  return `#${channel(1)}${channel(3)}${channel(5)}`;
};

export const getTileFill = (change) => {
  if (!Number.isFinite(change) || change === 0) return FLAT_COLOR;
  const t = Math.sqrt(Math.min(Math.abs(change) / GRADIENT_FULL_AT, 1));
  const [from, to] = change > 0 ? GAIN_SCALE : LOSS_SCALE;
  return mixHex(from, to, t);
};

/** '+1,20%' · '-0,40%' · '—' cuando no hay dato. */
export const formatChange = (change) => formatPercent(change, 2, { sign: true });

// Prefer the asset name when the ticker is opaque (lib/tickerLabel) OR the item
// is a known fund (isFund comes from the Dashboard's getFundExposure classification).
export { isOpaqueTicker };
export const tileLabel = (ticker, name, isFund = false) =>
  ((isFund || isOpaqueTicker(ticker)) ? (name || ticker) : ticker) || '';

const CustomTreemapContent = (props) => {
  const { x, y, width, height, name, ticker, isFund, change, depth } = props;
  if (depth === 0 || !Number.isFinite(width) || !Number.isFinite(height) || width <= 2 || height <= 2) return null;

  const rx  = 4;
  const tx  = x;
  const ty  = y;
  const tw  = width;
  const th  = height;
  if (tw <= 0 || th <= 0) return null;

  const baseColor = getTileFill(change);
  const separator = canvasColor();
  const layout    = layoutTileText(tileLabel(ticker, name, isFund), tw, th);
  const nameLineH = layout.nameSize * layout.lineHeight;
  const pctLineH  = layout.pctSize * layout.lineHeight;
  const blockH    = layout.inline
    ? nameLineH
    : layout.lines.length * nameLineH + (layout.showPct ? pctLineH + layout.gap : 0);
  const top       = ty + (th - blockH) / 2;
  const cx        = tx + tw / 2;
  // Línea de base que centra las mayúsculas (altura ≈ CAP_HEIGHT em) en su renglón.
  const baseline  = (lineTop, lineH, size) => lineTop + (lineH + size * CAP_HEIGHT) / 2;

  return (
    <g>
      <rect x={tx} y={ty} width={tw} height={th} rx={rx} ry={rx}
        style={{ fill: baseColor, stroke: separator, strokeWidth: 1.5 }} />

        {/* Contorno oscuro PINTADO DEBAJO del relleno (`paintOrder: stroke`).
            Blanco sobre las baldosas da 2,89:1 en rojo y 3,03:1 en verde: por
            debajo de AA incluso para texto grande. Con el contorno sube a
            ~18:1 y aguanta cualquier color de baldosa.
            OJO: el orden por defecto de SVG pinta el stroke ENCIMA y engorda el
            glifo desde dentro — eso es justo lo que cierra un `0` y lo convierte
            en un `8`. `paintOrder` es lo que lo hace seguro. */}
      {(layout.showPct || layout.lines.length > 0) && (
        <text
          textAnchor="middle"
          style={{
            pointerEvents: 'none',
            userSelect: 'none',
            paintOrder: 'stroke',
            stroke: 'rgba(8,15,28,0.5)',
            strokeWidth: 2.5,
            strokeLinejoin: 'round',
          }}
        >
          {layout.inline && (
            <>
              <tspan x={cx} y={baseline(top, nameLineH, layout.nameSize)} fontSize={layout.nameSize} fontWeight="700" fill="rgba(255,255,255,0.97)">
                {layout.lines[0]}
              </tspan>
              <tspan dx="0.45em" fontSize={layout.pctSize} fontWeight="700" fill="#ffffff" style={{ fontFamily: MONO }}>
                {formatChange(change)}
              </tspan>
            </>
          )}
          {!layout.inline && layout.lines.map((line, i) => (
            <tspan
              key={i}
              x={cx}
              y={baseline(top + i * nameLineH, nameLineH, layout.nameSize)}
              fontSize={layout.nameSize}
              fontWeight="700"
              fill="rgba(255,255,255,0.97)"
            >
              {line}
            </tspan>
          ))}
          {!layout.inline && layout.showPct && (
            <tspan
              x={cx}
              y={baseline(top + layout.lines.length * nameLineH + (layout.lines.length ? layout.gap : 0), pctLineH, layout.pctSize)}
              fontSize={layout.pctSize}
              fontWeight="700"
              fill="#ffffff"
              style={{ fontFamily: MONO }}
            >
              {formatChange(change)}
            </tspan>
          )}
        </text>
      )}
    </g>
  );
};

const CustomTooltip = ({ active, payload, formatMoney }) => {
  const { privacyMode } = usePrivacyMode();
  const { t } = useTranslation();
  if (!active || !payload?.length) return null;
  const d   = payload[0].payload;
  const chg = d.change;
  const color = getTileColor(chg);
  const dark = isDarkTheme();

  const bg     = dark ? '#0c1730' : '#ffffff';
  const ink    = dark ? '#f1f5f9' : '#070d18';
  const muted  = dark ? '#64748b' : '#64748b';
  const rule   = dark ? 'rgba(255,255,255,0.08)' : 'rgba(13,21,38,0.10)';
  const shadow = dark ? '0 20px 60px rgba(0,0,0,0.6)' : '0 20px 50px rgba(13,21,38,0.18)';

  return (
    <div style={{
      borderRadius: 14,
      backgroundColor: bg,
      border: `1px solid ${rule}`,
      color: ink,
      fontSize: 12,
      padding: '12px 16px',
      minWidth: 180,
      boxShadow: shadow,
    }}>
      <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 2, letterSpacing: '-0.3px' }}>
        {tileLabel(d.ticker, d.name, d.isFund)}
      </div>
      {d.name && d.name !== tileLabel(d.ticker, d.name, d.isFund) && (
        <div style={{ color: muted, fontSize: 11, marginBottom: 10 }}>{d.name}</div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {d.marketValue > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 20 }}>
            <span style={{ color: muted }}>{t('portfolio_treemap.tooltip_value')}</span>
            <span style={{ fontWeight: 700, fontFamily: MONO }}>
              {privacyMode ? '••••' : (formatMoney ? formatMoney(d.marketValue) : formatNumber(d.marketValue, 0, 0))}
            </span>
          </div>
        )}
        {d.weight != null && d.weight > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 20 }}>
            <span style={{ color: muted }}>{t('portfolio_treemap.tooltip_weight')}</span>
            {/* El peso es el reparto de TU cartera: privacidad lo oculta (misma regla que Gastos). */}
            <span style={{ fontWeight: 700, fontFamily: MONO }}>{privacyMode ? '••••' : formatPercent(d.weight, 1)}</span>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 20, paddingTop: 4, borderTop: `1px solid ${rule}` }}>
          <span style={{ color: muted }}>{t('portfolio_treemap.tooltip_change')}</span>
          <span style={{ fontWeight: 800, color, fontSize: 13, fontFamily: MONO }}>
            {formatChange(chg)}
          </span>
        </div>
      </div>
    </div>
  );
};

/* ── Texto de una baldosa ──
   Anchura media de un glifo en mayúscula negrita (y de un dígito mono), en em.
   Es una estimación: SVG no mide texto sin pintarlo, así que se pide un poco de
   más para que una línea nunca se salga de su baldosa. */
const CHAR_WIDTH  = 0.62;
const LINE_HEIGHT = 1.15;
const CAP_HEIGHT  = 0.7;
const TILE_PAD    = 6;
const LINE_GAP    = 3;
const NAME_MIN = 9;
const NAME_MAX = 22;
const PCT_MIN  = 10;
const PCT_MAX  = 24;
const MAX_NAME_LINES = 3;
const PCT_CHARS = 6; // "-2.34%"

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** Reparte las palabras en líneas de como mucho `maxChars` (una palabra larga queda sola). */
const wrapWords = (label, maxChars) => {
  const lines = [];
  let current = '';
  for (const word of label.split(/\s+/).filter(Boolean)) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars) { current = next; continue; }
    if (current) lines.push(current);
    current = word;
  }
  return current ? [...lines, current] : lines;
};

/**
 * Mismo número de líneas, pero tan parejas como se pueda: estrecha el ancho
 * hasta justo antes de que haga falta una línea más. Sin esto la última línea
 * se quedaba con una palabra suelta ("FIDELITY MSCI PACFC EXJAPN / IDX").
 */
const balanceLines = (label, lines, maxChars) => {
  let best = lines;
  for (let c = maxChars - 1; c > 0; c -= 1) {
    const tighter = wrapWords(label, c);
    if (tighter.length !== lines.length || tighter.some((l) => l.length > c)) break;
    best = tighter;
  }
  return best;
};

const ellipsize = (line, maxChars) =>
  line.length + 1 > maxChars ? `${line.slice(0, maxChars - 1)}…` : `${line}…`;

/** Recorta a `maxLines` líneas de `maxChars`, con "…" donde se haya perdido texto. */
const truncateLines = (lines, maxChars, maxLines) => {
  const kept = lines.slice(0, maxLines).map((l) => (l.length > maxChars ? ellipsize(l.slice(0, maxChars - 1), maxChars) : l));
  if (lines.length <= maxLines || kept.at(-1).endsWith('…')) return kept;
  return [...kept.slice(0, -1), ellipsize(kept.at(-1), maxChars)];
};

/**
 * Qué texto cabe en una baldosa de `tw`×`th` y a qué tamaño.
 *
 * El PORCENTAJE es el dato principal del widget (el nombre solo dice de quién
 * es la baldosa): se coloca primero, nunca va más pequeño que el nombre y es lo
 * último que se quita. El suelo de 10px es lo que lo mantuvo legible al escalar
 * la imagen: a 8px un `0` se cierra y parece un `8`, y un `%` colapsa en una `X`.
 *
 * El nombre se parte en hasta 3 líneas y la letra baja hasta NAME_MIN antes de
 * recortar con "…": los nombres de fondo ("ISHARES ESG SCREENED GLB CORP") son
 * largos, y en una sola línea solo se leía "ISHARES ES…".
 *
 * @returns {{ lines: string[], nameSize: number, pctSize: number, showPct: boolean,
 *             lineHeight: number, gap: number, charWidth: number }}
 */
export const layoutTileText = (label, tw, th) => {
  const base = { lineHeight: LINE_HEIGHT, gap: LINE_GAP, charWidth: CHAR_WIDTH };
  const nothing = { ...base, lines: [], nameSize: 0, pctSize: 0, showPct: false };
  const w = tw - 2 * TILE_PAD;
  const h = th - 2 * TILE_PAD;
  const pctFit = Math.min(w / (PCT_CHARS * CHAR_WIDTH), h / LINE_HEIGHT, PCT_MAX);
  if (!(pctFit >= PCT_MIN)) return nothing;

  const pctSize = clamp(Math.min(tw / 7, th / 5), PCT_MIN, pctFit);
  const nameH = h - pctSize * LINE_HEIGHT - LINE_GAP;
  const nameIdeal = Math.min(clamp(Math.min(tw / 10, th / 6), NAME_MIN, NAME_MAX), pctSize);
  const withPct = { ...base, pctSize, showPct: true };

  // De la letra ideal hacia abajo, de px en px, terminando SIEMPRE en NAME_MIN.
  const sizes = [];
  for (let s = nameIdeal; s > NAME_MIN; s -= 1) sizes.push(s);
  sizes.push(NAME_MIN);

  for (const size of sizes) {
    const maxLines = Math.min(MAX_NAME_LINES, Math.floor(nameH / (size * LINE_HEIGHT)));
    const maxChars = Math.floor(w / (size * CHAR_WIDTH));
    if (maxLines >= 1 && maxChars >= 3) {
      const lines = wrapWords(label, maxChars);
      const fits = lines.length <= maxLines && lines.every((l) => l.length <= maxChars);
      if (fits) return { ...withPct, lines: balanceLines(label, lines, maxChars), nameSize: size };
      if (size === NAME_MIN) return { ...withPct, lines: truncateLines(lines, maxChars, maxLines), nameSize: size };
    }
  }
  // Sin altura para una línea aparte: nombre y porcentaje en la MISMA línea
  // (el nombre no desaparece; con la baldosa diminuta solo quedaba el %).
  const inlineSize = Math.min(pctSize, h / LINE_HEIGHT);
  const inlineChars = Math.floor(w / (inlineSize * CHAR_WIDTH)) - PCT_CHARS - 1;
  if (inlineSize >= NAME_MIN && inlineChars >= 3) {
    const name = label.length > inlineChars ? ellipsize(label.slice(0, inlineChars - 1), inlineChars) : label;
    return { ...base, inline: true, showPct: true, lines: [name], nameSize: inlineSize, pctSize: inlineSize };
  }
  return { ...withPct, lines: [], nameSize: 0 };
};

/** Tamaño mínimo de una baldosa, como fracción de la MAYOR. */
const MIN_TILE_SHARE = 0.25;

/**
 * Sube las baldosas diminutas a MIN_TILE_SHARE de la mayor. El tamaño es la
 * variación del día, y un −0,07 % junto a un −3,72 % era una franja de pocos
 * píxeles en la que no cabía ni el nombre (BTC-USD, 2026-10-17). Se conserva
 * el orden de tamaños; solo dejan de ser invisibles las que se movieron poco.
 * @template {{ size: number }} T
 * @param {T[]} items
 * @returns {T[]}
 */
export const withMinTileSize = (items) => {
  const max = Math.max(0, ...items.map((d) => d.size || 0));
  const floor = max * MIN_TILE_SHARE;
  return items.map((d) => (d.size < floor ? { ...d, size: floor } : d));
};

/**
 * @param {{ data: Array, formatMoney?: (amount: number) => string }} props
 *   formatMoney: el formateador de importes del Dashboard (divisa y privacidad).
 */
const PortfolioTreemap = ({ data, formatMoney }) => {
  const { t } = useTranslation();
  // `marketValue` y no `value`: Recharts SOBRESCRIBE `value` de cada nodo con
  // el dataKey (`size` = |variación diaria|). El tooltip leía eso y un BTC de
  // 33.016 € salía como "Valor 1".
  const validData = withMinTileSize((data || []).filter(d => d.size > 0)).map(d => ({ ...d, marketValue: d.value }));
  const nPos = validData.length;
  // Sólo compite quien tiene variación de verdad: sin esto, el "Mejor" de una
  // cartera de fondos era cualquiera de ellos con un +0,00% sin sentido.
  const conVariacion = validData.filter((d) => Number.isFinite(d.change) && d.change !== 0);
  const topGainer = conVariacion.length
    ? [...conVariacion].sort((a, b) => b.change - a.change)[0]
    : null;
  const separator = canvasColor();

  // La leyenda es la MISMA escala que las baldosas, de −3 % a +3 %.
  const legendGradient = `linear-gradient(to right, ${LOSS_SCALE[1]}, ${LOSS_SCALE[0]}, ${FLAT_COLOR}, ${GAIN_SCALE[0]}, ${GAIN_SCALE[1]})`;

  if (validData.length === 0) {
    return (
      <div className="h-[480px] min-h-[480px] flex flex-col items-center justify-center bg-white dark:bg-slate-800/80 rounded-2xl border border-slate-200/80 dark:border-slate-700/40 shadow-xs">
        <LayoutGrid className="w-10 h-10 text-slate-300 dark:text-slate-700 mb-3" />
        <p className="text-slate-500 text-sm font-medium">{t('portfolio_treemap.no_positions')}</p>
      </div>
    );
  }

  return (
    // min-h is load-bearing: ExpandableWidget's [&>div]:h-full overrides a plain
    // height (higher specificity), and on mobile the grid row is auto-sized, so
    // h-full resolves to 0 and the map collapses to just its header.
    <div className="bg-white dark:bg-slate-800/80 rounded-2xl border border-slate-200/80 dark:border-slate-700/40 shadow-xs overflow-hidden h-[480px] min-h-[480px] flex flex-col">
      {/* ── Header ── */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200/80 dark:border-slate-700/40 shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-1.5 bg-slate-100 dark:bg-slate-800 rounded-lg">
            <LayoutGrid className="w-3.5 h-3.5 text-slate-500 dark:text-slate-300" />
          </div>
          <div>
            <h2 className="font-display text-sm font-black text-slate-900 dark:text-white tracking-tight">{t('portfolio_treemap.title')}</h2>
            <p className="text-[10px] text-slate-500 font-medium mt-0.5">
              {t('portfolio_treemap.subtitle', { count: nPos })}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {topGainer && (
            <div className="hidden sm:flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800 px-3 py-1.5 rounded-lg">
              <span className="text-[10px] text-slate-500 font-medium">{t('portfolio_treemap.best')}</span>
              <span className="text-[11px] font-black text-slate-900 dark:text-white max-w-[140px] truncate">{tileLabel(topGainer.ticker, topGainer.name, topGainer.isFund)}</span>
              <span className="font-ledger text-[11px] font-bold" style={{ color: getTileColor(topGainer.change) }}>
                {formatChange(topGainer.change)}
              </span>
            </div>
          )}
          <div
            className="hidden sm:flex items-center gap-1.5"
            role="img"
            aria-label={t('portfolio_treemap.legend_scale', { max: GRADIENT_FULL_AT })}
            title={t('portfolio_treemap.legend_scale', { max: GRADIENT_FULL_AT })}
          >
            <span className="font-ledger text-[10px] font-semibold text-slate-500 tabular-nums">−{GRADIENT_FULL_AT}%</span>
            <div className="w-24 h-2 rounded-full" style={{ backgroundImage: legendGradient }} />
            <span className="font-ledger text-[10px] font-semibold text-slate-500 tabular-nums">+{GRADIENT_FULL_AT}%</span>
          </div>
        </div>
      </div>

      {/* ── Treemap — bg is the (theme-aware) separator/canvas colour ── */}
      <div className="flex-1 p-1" style={{ backgroundColor: separator }}>
        <ResponsiveContainer width="100%" height="100%">
          <Treemap
            data={[{ name: 'Portfolio', children: validData }]}
            dataKey="size"
            stroke={separator}
            content={<CustomTreemapContent />}
            isAnimationActive={false}
          >
            <Tooltip content={<CustomTooltip formatMoney={formatMoney} />} />
          </Treemap>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

export default PortfolioTreemap;
