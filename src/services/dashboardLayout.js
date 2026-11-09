// Dashboard widget layout (order + visibility), persisted per user in
// user_preferences.dashboard_widgets as { order: [id], hidden: [id] }.
//
// Pure module: no React, no Supabase. The REGISTRY is the source of truth for
// which widgets exist and how wide they are; the saved config only reorders and
// hides. That way a widget added in code appears for every user (at the end,
// visible) without touching stored data, and a widget removed from code
// disappears even if it lingers in someone's saved order.

/**
 * `span` = columns taken in the 3-column desktop grid. `half: true` marks a
 * widget as PAIRABLE: two half widgets linked in `pairs` share one grid cell
 * stacked vertically (mitad y mitad). The default order below plus
 * DEFAULT_PAIRS reproduces the original hand-placed layout: 1+2 / 1+2 / 1+1+1 / 3.
 */
export const DASHBOARD_WIDGETS = [
  { id: 'invested', labelKey: 'dashboard.widget_invested', span: 1, half: true },
  { id: 'allocation', labelKey: 'dashboard.widget_allocation', span: 1, half: true },
  { id: 'growth', labelKey: 'portfolio_growth.title', span: 2 },
  { id: 'score', labelKey: 'portfolio_score.title', span: 1, half: true },
  { id: 'treemap', labelKey: 'portfolio_treemap.title', span: 2 },
  { id: 'watchlist', labelKey: 'watchlist_tracker.title', span: 1, half: true },
  { id: 'dividends', labelKey: 'analytics.dividend_calendar.title', span: 1, half: true },
  { id: 'earnings', labelKey: 'analytics.earnings_calendar.title', span: 1, half: true },
  { id: 'news', labelKey: 'portfolio_news.title', span: 1 },
];

/**
 * Interruptor ÚNICO de los widgets de Gastos EN EL DASHBOARD (2026-09-10).
 *
 * Apagado por decisión del owner: la pantalla principal es la cartera y los
 * widgets de gastos la llenaban de otra cosa. La PANTALLA `/app/gastos` no se
 * ve afectada — sigue colgando de `expenses_enabled` + la lista de cuentas de
 * `lib/expensesAccess`.
 *
 * Se conservan el registry de abajo y sus componentes porque volver a
 * encenderlos es poner esto a `true`: el layout resuelto ya está probado en
 * las DOS direcciones (`dashboardLayout.test.js`, "expenses on/off"), y un
 * orden guardado que aún mencione los `exp_*` se autolimpia al resolverse.
 */
export const DASHBOARD_EXPENSE_WIDGETS_ENABLED = false;

/**
 * Extra widgets appended ONLY when the user has the expenses/savings feature on.
 * Same registry contract — passed to resolveDashboardLayout as part of the
 * registry so a disabled feature simply drops them from the resolved layout.
 */
export const EXPENSES_WIDGETS = [
  { id: 'exp_summary', labelKey: 'dashboard.widget_exp_summary', span: 1, half: true },
  { id: 'exp_donut', labelKey: 'dashboard.widget_exp_donut', span: 1 },
  { id: 'exp_calendar', labelKey: 'dashboard.widget_exp_calendar', span: 2 },
];

/**
 * Order a user sees on their FIRST visit (no saved config). It cannot be the
 * registry order: the registry is split in two arrays (dashboard + expenses)
 * and the intended narrative interleaves them — patrimonio, gasto del mes,
 * rendimiento, mapa, distribución… Ids missing here fall to the end, visible,
 * so adding a widget in code never needs a data migration.
 *
 * Anything the user reorders afterwards is saved and wins over this.
 *
 * Colocación pedida por el owner (2026-09-10): Favoritos apilado bajo
 * Invertido, Puntuación apilada bajo el quesito y Noticias al lado de los dos
 * calendarios (dividendos + earnings + noticias, tres listas de una columna en
 * la misma fila). Noticias dejó de ser de ancho completo para eso — y de paso
 * su columna es la que rellena el hueco que dejaban las dos parejas, así que
 * con los widgets de gastos apagados el layout vuelve a teselar EXACTO (12).
 */
export const DEFAULT_DASHBOARD_ORDER = [
  'invested',      // 01 ┐ enlazados
  'watchlist',     // 02 ┘
  'growth',        // 03
  'treemap',       // 04
  'allocation',    // 05 ┐ enlazados
  'score',         // 06 ┘
  'dividends',     // 07 ┐ los tres calendarios/listas
  'earnings',      // 08 │ de una columna, en la misma fila
  'news',          // 09 ┘
  'exp_summary',   // 10 ┐ solo si DASHBOARD_EXPENSE_WIDGETS_ENABLED
  'exp_calendar',  // 11 │ (1 + 2 = fila completa; el donut cierra abajo)
  'exp_donut',     // 12 ┘
];

/**
 * Pairs applied when the saved config has no `pairs` field (legacy saves and
 * first run). Cada pareja solo se aplica si sus DOS miembros están en el
 * registry; desde 2026-09-10 ninguna depende de la feature de gastos, así que
 * el layout inicial es el mismo con los widgets de gastos encendidos o no.
 */
export const DEFAULT_PAIRS = [
  ['invested', 'watchlist'],
  ['allocation', 'score'],
];

/**
 * Widgets of the standalone Expenses screen (src/pages/ExpensesPage.jsx),
 * persisted per user in user_preferences.expenses_widgets with the SAME
 * { order, hidden } contract. `span` = columns in the 2-column desktop grid.
 * The default order reproduces the page's narrative: hero + monthly summary,
 * budgets + breakdown, goals, analysis, movements.
 */
export const EXPENSES_PAGE_WIDGETS = [
  { id: 'savings_hero', labelKey: 'expenses.widget_savings_hero', span: 1 },
  { id: 'month_tiles', labelKey: 'expenses.widget_month_tiles', span: 1 },
  { id: 'budgets', labelKey: 'expenses.widget_budgets', span: 1 },
  { id: 'donut', labelKey: 'expenses.widget_donut', span: 1 },
  { id: 'goals', labelKey: 'expenses.widget_goals', span: 2 },
  // Proyectos va DESPUÉS de metas a propósito: primero lo que apartas, luego lo
  // que te has dejado. Widget nuevo = aparece al final y visible para quien ya
  // tenga un orden guardado (resolveDashboardLayout), sin romperle el layout.
  { id: 'projects', labelKey: 'expenses.widget_projects', span: 2 },
  { id: 'analysis', labelKey: 'expenses.widget_analysis', span: 2 },
  { id: 'movements', labelKey: 'expenses.widget_movements', span: 2 },
];

/**
 * Merges the saved config with the registry.
 * `defaultOrder` only applies when the user has no saved order (first visit or
 * after "restaurar"); a saved order always wins.
 * @returns {Array<{id,labelKey,span,visible}>} in display order.
 */
export function resolveDashboardLayout(saved, registry = DASHBOARD_WIDGETS, defaultOrder = []) {
  const byId = new Map(registry.map((w) => [w.id, w]));
  const hidden = new Set(Array.isArray(saved?.hidden) ? saved.hidden : []);
  const rawSaved = Array.isArray(saved?.order) ? saved.order : [];
  const savedOrder = rawSaved.length > 0 ? rawSaved : defaultOrder;

  const ordered = [];
  const seen = new Set();
  for (const id of savedOrder) {
    const w = byId.get(id); // unknown/removed ids are dropped
    if (!w || seen.has(id)) continue;
    seen.add(id);
    ordered.push({ ...w, visible: !hidden.has(id) });
  }
  // Widgets missing from the saved order (new in code) go last, visible.
  for (const w of registry) {
    if (seen.has(w.id)) continue;
    ordered.push({ ...w, visible: !hidden.has(w.id) });
  }
  return ordered;
}

/** Moves a widget `delta` positions (clamped). Returns a NEW array. */
export function moveWidget(layout, id, delta) {
  const from = layout.findIndex((w) => w.id === id);
  if (from === -1) return layout;
  const to = Math.max(0, Math.min(layout.length - 1, from + delta));
  if (to === from) return layout;
  const next = [...layout];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Flips a widget's visibility. Returns a NEW array. */
export function toggleWidgetVisibility(layout, id) {
  return layout.map((w) => (w.id === id ? { ...w, visible: !w.visible } : w));
}

/** Layout → the compact shape stored in user_preferences. */
export function serializeLayout(layout, pairs) {
  const out = {
    order: layout.map((w) => w.id),
    hidden: layout.filter((w) => !w.visible).map((w) => w.id),
  };
  if (Array.isArray(pairs)) out.pairs = pairs;
  return out;
}

// ── Pairing (mitad y mitad) ─────────────────────────────────────────────────
// A pair links two `half` widgets so they render stacked in ONE grid cell and
// move as a unit in the customizer. Pairs are explicit user state (saved as
// config.pairs); DEFAULT_PAIRS applies only when the save has no pairs field.

const isPairable = (w) => !!w?.half;

/**
 * Valid pairs for a resolved layout: only pairs whose BOTH members exist in
 * the layout and are pairable; a widget can belong to at most one pair.
 * `saved` is the raw stored config (or null).
 */
export function resolvePairs(saved, layout) {
  const source = Array.isArray(saved?.pairs) ? saved.pairs : DEFAULT_PAIRS;
  const byId = new Map(layout.map((w) => [w.id, w]));
  const used = new Set();
  const out = [];
  for (const p of source) {
    if (!Array.isArray(p) || p.length !== 2) continue;
    const [a, b] = p;
    if (a === b || used.has(a) || used.has(b)) continue;
    if (!isPairable(byId.get(a)) || !isPairable(byId.get(b))) continue;
    used.add(a); used.add(b);
    out.push([a, b]);
  }
  return out;
}

/** Reorders the layout so every pair's second member sits right after the first. */
export function applyPairAdjacency(layout, pairs) {
  let next = layout;
  for (const [a, b] of pairs) {
    const ia = next.findIndex((w) => w.id === a);
    const ib = next.findIndex((w) => w.id === b);
    if (ia === -1 || ib === -1 || ib === ia + 1) continue;
    const copy = [...next];
    const [moved] = copy.splice(ib, 1);
    const insertAt = copy.findIndex((w) => w.id === a) + 1;
    copy.splice(insertAt, 0, moved);
    next = copy;
  }
  return next;
}

/** Adds the pair (or removes it if it already exists). Returns a NEW array. */
export function togglePair(pairs, a, b) {
  const exists = pairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  if (exists) return pairs.filter(([x, y]) => !((x === a && y === b) || (x === b && y === a)));
  // A widget can only be in one pair — drop any pair touching a or b first.
  const cleaned = pairs.filter(([x, y]) => x !== a && y !== a && x !== b && y !== b);
  return [...cleaned, [a, b]];
}

/** The pair containing `id`, or null. */
export function pairOf(pairs, id) {
  return pairs.find(([a, b]) => a === id || b === id) || null;
}

/**
 * Groups the layout into render/move units: [{ ids, order }]. A pair whose two
 * members are visible becomes one unit (stacked cell); a pair with one hidden
 * member degrades to a single. `order` = index of the unit's first member in
 * the FULL layout, so units interleave correctly with standalone widgets.
 */
export function computeRenderGroups(layout, pairs = []) {
  const paired = new Map(); // id → partner
  for (const [a, b] of pairs) { paired.set(a, b); paired.set(b, a); }
  const groups = [];
  const consumed = new Set();
  layout.forEach((w, idx) => {
    if (consumed.has(w.id) || w.visible === false) return;
    const partner = paired.get(w.id);
    if (partner) {
      const pw = layout.find((x) => x.id === partner);
      if (pw && pw.visible !== false && !consumed.has(partner)) {
        consumed.add(w.id); consumed.add(partner);
        groups.push({ ids: [w.id, partner], order: idx });
        return;
      }
    }
    consumed.add(w.id);
    groups.push({ ids: [w.id], order: idx });
  });
  return groups;
}

/**
 * moveWidget that treats pairs as blocks: moving any member moves the whole
 * pair one UNIT up/down (past the neighbouring unit, not one row). Returns a
 * NEW layout array.
 */
export function moveWidgetWithPairs(layout, pairs, id, delta) {
  const paired = new Map();
  for (const [a, b] of pairs) { paired.set(a, b); paired.set(b, a); }
  // Build units over the FULL layout (hidden included) so moves are stable.
  const units = [];
  const consumed = new Set();
  for (const w of layout) {
    if (consumed.has(w.id)) continue;
    const partner = paired.get(w.id);
    if (partner && layout.some((x) => x.id === partner) && !consumed.has(partner)) {
      consumed.add(w.id); consumed.add(partner);
      units.push([w.id, partner]);
    } else {
      consumed.add(w.id);
      units.push([w.id]);
    }
  }
  const from = units.findIndex((u) => u.includes(id));
  if (from === -1) return layout;
  const to = Math.max(0, Math.min(units.length - 1, from + delta));
  if (to === from) return layout;
  const nextUnits = [...units];
  const [moved] = nextUnits.splice(from, 1);
  nextUnits.splice(to, 0, moved);
  const byId = new Map(layout.map((w) => [w.id, w]));
  return nextUnits.flat().map((wid) => byId.get(wid));
}

// Widgets que, sin ninguna posición, solo pintarían "sin datos" o ceros.
// Favoritos y los de gastos funcionan sin cartera y se quedan.
const POSITION_WIDGETS = new Set(['invested', 'growth', 'treemap', 'allocation', 'score', 'dividends', 'earnings', 'news']);

/**
 * Layout que se PINTA cuando la cuenta aún no tiene posiciones: oculta los
 * widgets que dependen de ellas (una cuenta nueva veía 8 tarjetas vacías y
 * ninguna decía qué hacer; en su lugar va una tarjeta de bienvenida). No toca
 * el layout guardado: en cuanto hay posiciones vuelve el del usuario tal cual.
 * @param {Array<{ id: string, visible?: boolean }>} layout
 * @returns {Array<{ id: string, visible?: boolean }>}
 */
export function layoutForEmptyPortfolio(layout) {
  return layout.map((w) => (POSITION_WIDGETS.has(w.id) ? { ...w, visible: false } : w));
}
