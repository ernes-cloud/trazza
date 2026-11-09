import { describe, it, expect } from 'vitest';
import {
  DASHBOARD_WIDGETS,
  EXPENSES_WIDGETS,
  EXPENSES_PAGE_WIDGETS,
  DEFAULT_PAIRS,
  DEFAULT_DASHBOARD_ORDER,
  resolveDashboardLayout,
  moveWidget,
  toggleWidgetVisibility,
  serializeLayout,
  resolvePairs,
  applyPairAdjacency,
  togglePair,
  pairOf,
  computeRenderGroups,
  moveWidgetWithPairs,
  layoutForEmptyPortfolio,
} from './dashboardLayout';

const REGISTRY = [
  { id: 'a', labelKey: 'k.a', span: 1 },
  { id: 'b', labelKey: 'k.b', span: 2 },
  { id: 'c', labelKey: 'k.c', span: 3 },
];

describe('DASHBOARD_WIDGETS (default registry)', () => {
  it('the registry still declares every widget', () => {
    expect(DASHBOARD_WIDGETS.map((w) => w.id)).toEqual([
      'invested', 'allocation', 'growth', 'score', 'treemap', 'watchlist', 'dividends', 'earnings', 'news',
    ]);
  });

  // Ningún widget puede PARTIR una fila de 3 columnas, y el sobrante — si lo
  // hay — cae en la ÚLTIMA fila, nunca en medio de la retícula (un hueco
  // intermedio se lee como un widget que no cargó).
  //
  // Apagados los widgets de gastos —el estado que se sirve— el layout tesela
  // EXACTO: las dos parejas funden dos celdas y la columna de Noticias rellena
  // justo el sobrante. Encendidos quedan 13 de 15 y el resto cae al final.
  it.each([
    ['expenses on', [...DASHBOARD_WIDGETS, ...EXPENSES_WIDGETS]],
    ['expenses off', DASHBOARD_WIDGETS],
  ])('the default layout never splits a row, and any gap is the last one (%s)', (_name, registry) => {
    const layout = resolveDashboardLayout(null, registry, DEFAULT_DASHBOARD_ORDER);
    const pairs = resolvePairs(null, layout);
    const groups = computeRenderGroups(applyPairAdjacency(layout, pairs), pairs);
    const spans = groups.map((g) => registry.find((w) => w.id === g.ids[0]).span);
    // Reparte los grupos en filas de 3 columnas, como hace el grid.
    const rows = [[]];
    let row = 0;
    for (const span of spans) {
      expect(span).toBeLessThanOrEqual(3);
      if (row + span > 3) { rows.push([]); row = 0; } // salta de fila
      rows[rows.length - 1].push(span);
      row += span;
    }
    // Ninguna fila se pasa de 3, y solo la ÚLTIMA puede quedarse corta.
    rows.forEach((r, i) => {
      const filled = r.reduce((a, b) => a + b, 0);
      expect(filled).toBeLessThanOrEqual(3);
      if (i < rows.length - 1) expect(filled).toBe(3);
    });
  });

  it('tiles exactly with the expense widgets off (the shipped layout)', () => {
    const spansOf = (registry) => {
      const layout = resolveDashboardLayout(null, registry, DEFAULT_DASHBOARD_ORDER);
      const pairs = resolvePairs(null, layout);
      return computeRenderGroups(applyPairAdjacency(layout, pairs), pairs)
        .map((g) => registry.find((w) => w.id === g.ids[0]).span)
        .reduce((a, b) => a + b, 0);
    };
    expect(spansOf(DASHBOARD_WIDGETS) % 3).toBe(0);           // 9 columnas, 3 filas justas
    expect(spansOf([...DASHBOARD_WIDGETS, ...EXPENSES_WIDGETS]) % 3).toBe(1); // sobra 1 al final
  });

  // Los tres van juntos en una fila: si alguien le devuelve a Noticias el ancho
  // completo, la fila se parte y el layout deja de ser el que se pidió.
  it('dividends, earnings and news are three one-column widgets in a row', () => {
    const ids = ['dividends', 'earnings', 'news'];
    ids.forEach((id) => expect(DASHBOARD_WIDGETS.find((w) => w.id === id).span).toBe(1));
    const order = DEFAULT_DASHBOARD_ORDER.filter((id) => ids.includes(id));
    expect(order).toEqual(ids);
  });

  it('every widget has a translation key', () => {
    expect(DASHBOARD_WIDGETS.every((w) => typeof w.labelKey === 'string' && w.labelKey.includes('.'))).toBe(true);
  });

  it('pairable widgets carry the half flag', () => {
    const halves = DASHBOARD_WIDGETS.filter((w) => w.half).map((w) => w.id);
    expect(halves).toEqual(['invested', 'allocation', 'score', 'watchlist', 'dividends', 'earnings']);
    expect(EXPENSES_WIDGETS.find((w) => w.id === 'exp_summary').half).toBe(true);
  });
});

describe('pairing (mitad y mitad)', () => {
  const REG = [
    { id: 'a', labelKey: 'k.a', span: 1, half: true },
    { id: 'b', labelKey: 'k.b', span: 1, half: true },
    { id: 'c', labelKey: 'k.c', span: 2 },
    { id: 'd', labelKey: 'k.d', span: 1, half: true },
  ];
  const layout = resolveDashboardLayout(null, REG);

  it('resolvePairs: defaults apply only when the save has no pairs field', () => {
    const enabled = [...DASHBOARD_WIDGETS, ...EXPENSES_WIDGETS];
    const full = resolveDashboardLayout(null, enabled);
    expect(resolvePairs(null, full)).toEqual(DEFAULT_PAIRS);
    // explicit empty pairs (user unlinked everything) stays empty
    expect(resolvePairs({ pairs: [] }, full)).toEqual([]);
  });

  it('resolvePairs drops pairs with missing/non-half members and duplicates', () => {
    expect(resolvePairs({ pairs: [['a', 'zzz'], ['a', 'c'], ['a', 'b'], ['b', 'd']] }, layout))
      .toEqual([['a', 'b']]);
  });

  it('applyPairAdjacency pulls the second member right after the first', () => {
    const shuffled = resolveDashboardLayout({ order: ['a', 'c', 'd', 'b'] }, REG);
    expect(applyPairAdjacency(shuffled, [['a', 'b']]).map((w) => w.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('togglePair links, unlinks, and steals members from other pairs', () => {
    let pairs = togglePair([], 'a', 'b');
    expect(pairs).toEqual([['a', 'b']]);
    expect(pairOf(pairs, 'b')).toEqual(['a', 'b']);
    expect(togglePair(pairs, 'b', 'a')).toEqual([]); // reversed order unlinks too
    expect(togglePair(pairs, 'b', 'd')).toEqual([['b', 'd']]); // steals b from a+b
  });

  it('computeRenderGroups: pair = one unit; hidden member degrades to single', () => {
    const groups = computeRenderGroups(layout, [['a', 'b']]);
    expect(groups.map((g) => g.ids)).toEqual([['a', 'b'], ['c'], ['d']]);
    expect(groups[0].order).toBe(0);
    const hidden = layout.map((w) => (w.id === 'b' ? { ...w, visible: false } : w));
    expect(computeRenderGroups(hidden, [['a', 'b']]).map((g) => g.ids)).toEqual([['a'], ['c'], ['d']]);
  });

  it('moveWidgetWithPairs moves the pair as a block and never splits it', () => {
    const moved = moveWidgetWithPairs(layout, [['a', 'b']], 'b', 1);
    expect(moved.map((w) => w.id)).toEqual(['c', 'a', 'b', 'd']);
    const back = moveWidgetWithPairs(moved, [['a', 'b']], 'a', -1);
    expect(back.map((w) => w.id)).toEqual(['a', 'b', 'c', 'd']);
    // singles hop over the whole pair in one step
    const dUp = moveWidgetWithPairs(layout, [['a', 'b']], 'd', -2);
    expect(dUp.map((w) => w.id)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('serializeLayout round-trips pairs', () => {
    const saved = serializeLayout(layout, [['a', 'b']]);
    expect(saved.pairs).toEqual([['a', 'b']]);
    expect(resolvePairs(saved, layout)).toEqual([['a', 'b']]);
  });
});

describe('expenses-aware registry (feature toggle)', () => {
  const enabled = [...DASHBOARD_WIDGETS, ...EXPENSES_WIDGETS];

  it('enabling the feature appends the expense widgets, keeping saved order+hidden', () => {
    const saved = { order: ['growth', 'invested'], hidden: ['news'] };
    const out = resolveDashboardLayout(saved, enabled);
    // saved ones first (in their order), then the rest of the registry incl. expenses
    expect(out.slice(0, 2).map((w) => w.id)).toEqual(['growth', 'invested']);
    expect(out.map((w) => w.id)).toEqual(expect.arrayContaining(['exp_summary', 'exp_donut', 'exp_calendar']));
    expect(out.find((w) => w.id === 'news').visible).toBe(false);
    expect(out.find((w) => w.id === 'exp_donut').visible).toBe(true);
  });

  it('disabling the feature drops the expense widgets even if they linger in saved config', () => {
    const saved = { order: ['exp_calendar', 'invested', 'exp_donut'], hidden: ['exp_summary'] };
    const out = resolveDashboardLayout(saved, DASHBOARD_WIDGETS);
    expect(out.some((w) => w.id.startsWith('exp_'))).toBe(false);
    expect(out[0].id).toBe('invested');
  });
});

describe('EXPENSES_PAGE_WIDGETS (expenses screen registry)', () => {
  // El orden es NARRATIVO, no alfabético ni casual: cuánto tengo → cómo ha ido
  // el mes → cuánto puedo gastar → en qué se ha ido → cuánto aparto → cuánto me
  // dejé en cada proyecto → análisis → el detalle. 'projects' entra tras 'goals'
  // (primero lo que apartas, luego lo que gastaste de ello).
  it('exposes the eight reorderable expense widgets in narrative order', () => {
    expect(EXPENSES_PAGE_WIDGETS.map((w) => w.id)).toEqual([
      'savings_hero', 'month_tiles', 'budgets', 'donut', 'goals', 'projects', 'analysis', 'movements',
    ]);
  });

  it('un widget nuevo aparece VISIBLE al final para quien ya tenía orden guardado', () => {
    // Un usuario con su layout de antes de "projects" no puede perder el widget
    // nuevo ni ver su orden reescrito: el registry manda, el orden guardado gana.
    const saved = { order: ['movements', 'goals', 'savings_hero', 'month_tiles', 'budgets', 'donut', 'analysis'], hidden: [] };
    const out = resolveDashboardLayout(saved, EXPENSES_PAGE_WIDGETS);
    expect(out.map((w) => w.id)).toEqual([...saved.order, 'projects']);
    expect(out.find((w) => w.id === 'projects').visible).toBe(true);
  });

  it('every widget has a translation key and a span', () => {
    expect(EXPENSES_PAGE_WIDGETS.every((w) => w.labelKey.includes('.') && (w.span === 1 || w.span === 2))).toBe(true);
  });

  it('resolves the same way as any other registry (order + hidden honoured)', () => {
    const out = resolveDashboardLayout({ order: ['movements', 'goals'], hidden: ['budgets'] }, EXPENSES_PAGE_WIDGETS);
    expect(out.slice(0, 2).map((w) => w.id)).toEqual(['movements', 'goals']);
    expect(out.find((w) => w.id === 'budgets').visible).toBe(false);
    expect(out).toHaveLength(EXPENSES_PAGE_WIDGETS.length);
  });
});

describe('resolveDashboardLayout', () => {
  it('with no saved config returns the registry order, all visible', () => {
    const out = resolveDashboardLayout(null, REGISTRY);
    expect(out.map((w) => w.id)).toEqual(['a', 'b', 'c']);
    expect(out.every((w) => w.visible)).toBe(true);
  });

  it('respects the saved order and hidden flags', () => {
    const out = resolveDashboardLayout({ order: ['c', 'a', 'b'], hidden: ['a'] }, REGISTRY);
    expect(out.map((w) => w.id)).toEqual(['c', 'a', 'b']);
    expect(out.find((w) => w.id === 'a').visible).toBe(false);
    expect(out.find((w) => w.id === 'c').visible).toBe(true);
  });

  it('appends widgets that are new in code (not in the saved order), visible', () => {
    const out = resolveDashboardLayout({ order: ['c', 'a'], hidden: [] }, REGISTRY);
    expect(out.map((w) => w.id)).toEqual(['c', 'a', 'b']);
    expect(out.find((w) => w.id === 'b').visible).toBe(true);
  });

  it('drops saved ids that no longer exist in the registry', () => {
    const out = resolveDashboardLayout({ order: ['zzz', 'b', 'a', 'c'], hidden: ['zzz'] }, REGISTRY);
    expect(out.map((w) => w.id)).toEqual(['b', 'a', 'c']);
  });

  it('ignores duplicated ids in the saved order', () => {
    const out = resolveDashboardLayout({ order: ['a', 'a', 'b'], hidden: [] }, REGISTRY);
    expect(out.map((w) => w.id)).toEqual(['a', 'b', 'c']);
  });

  it('tolerates a malformed saved config', () => {
    expect(resolveDashboardLayout({ order: 'nope', hidden: 5 }, REGISTRY).map((w) => w.id)).toEqual(['a', 'b', 'c']);
    expect(resolveDashboardLayout(undefined, REGISTRY)).toHaveLength(3);
  });
});

describe('moveWidget', () => {
  const layout = resolveDashboardLayout(null, REGISTRY);

  it('moves down and up', () => {
    expect(moveWidget(layout, 'a', 1).map((w) => w.id)).toEqual(['b', 'a', 'c']);
    expect(moveWidget(layout, 'c', -1).map((w) => w.id)).toEqual(['a', 'c', 'b']);
  });

  it('clamps at the edges and never mutates the input', () => {
    expect(moveWidget(layout, 'a', -1).map((w) => w.id)).toEqual(['a', 'b', 'c']);
    expect(moveWidget(layout, 'c', 5).map((w) => w.id)).toEqual(['a', 'b', 'c']);
    expect(layout.map((w) => w.id)).toEqual(['a', 'b', 'c']);
  });

  it('unknown id is a no-op', () => {
    expect(moveWidget(layout, 'zzz', 1)).toBe(layout);
  });
});

describe('toggleWidgetVisibility', () => {
  it('flips only the target widget', () => {
    const layout = resolveDashboardLayout(null, REGISTRY);
    const out = toggleWidgetVisibility(layout, 'b');
    expect(out.find((w) => w.id === 'b').visible).toBe(false);
    expect(out.find((w) => w.id === 'a').visible).toBe(true);
    expect(toggleWidgetVisibility(out, 'b').find((w) => w.id === 'b').visible).toBe(true);
  });
});

describe('serializeLayout', () => {
  it('round-trips through resolve', () => {
    const layout = toggleWidgetVisibility(moveWidget(resolveDashboardLayout(null, REGISTRY), 'c', -2), 'a');
    const saved = serializeLayout(layout);
    expect(saved).toEqual({ order: ['c', 'a', 'b'], hidden: ['a'] });
    const back = resolveDashboardLayout(saved, REGISTRY);
    expect(back.map((w) => w.id)).toEqual(['c', 'a', 'b']);
    expect(back.find((w) => w.id === 'a').visible).toBe(false);
  });
});

describe('DEFAULT_DASHBOARD_ORDER', () => {
  const fullRegistry = [...DASHBOARD_WIDGETS, ...EXPENSES_WIDGETS];

  it('is the order a first-time user sees (expenses feature on)', () => {
    const layout = resolveDashboardLayout(null, fullRegistry, DEFAULT_DASHBOARD_ORDER);
    expect(layout.map((w) => w.id)).toEqual([
      'invested', 'watchlist', 'growth', 'treemap', 'allocation',
      'score', 'dividends', 'earnings', 'news', 'exp_summary', 'exp_calendar', 'exp_donut',
    ]);
    expect(layout.every((w) => w.visible)).toBe(true);
  });

  it('covers every widget of both registries', () => {
    expect([...DEFAULT_DASHBOARD_ORDER].sort()).toEqual(fullRegistry.map((w) => w.id).sort());
  });

  it('drops the expenses widgets when the feature is off, keeping the rest in order', () => {
    const layout = resolveDashboardLayout(null, DASHBOARD_WIDGETS, DEFAULT_DASHBOARD_ORDER);
    expect(layout.map((w) => w.id)).toEqual([
      'invested', 'watchlist', 'growth', 'treemap', 'allocation', 'score', 'dividends', 'earnings', 'news',
    ]);
  });

  it('a SAVED order always wins over the default', () => {
    const saved = { order: ['news', 'invested'], hidden: [] };
    const layout = resolveDashboardLayout(saved, fullRegistry, DEFAULT_DASHBOARD_ORDER);
    expect(layout.slice(0, 2).map((w) => w.id)).toEqual(['news', 'invested']);
  });

  it('pairs invertido+favoritos and quesito+puntuación by default', () => {
    const layout = resolveDashboardLayout(null, fullRegistry, DEFAULT_DASHBOARD_ORDER);
    const pairs = resolvePairs(null, layout);
    expect(pairs).toEqual([['invested', 'watchlist'], ['allocation', 'score']]);
    // Ambos miembros ya son adyacentes en el orden por defecto
    expect(applyPairAdjacency(layout, pairs).map((w) => w.id)).toEqual(layout.map((w) => w.id));
  });

  // Desde 2026-09-10 ninguna pareja por defecto tiene un miembro de gastos, así
  // que apagar esos widgets ya no puede dejar a un widget emparejado colgado.
  it('both default pairs survive with the expense widgets off', () => {
    const layout = resolveDashboardLayout(null, DASHBOARD_WIDGETS, DEFAULT_DASHBOARD_ORDER);
    expect(resolvePairs(null, layout)).toEqual([['invested', 'watchlist'], ['allocation', 'score']]);
  });
});

describe('layoutForEmptyPortfolio', () => {
  const layout = [
    { id: 'invested', visible: true }, { id: 'watchlist', visible: true }, { id: 'growth', visible: true },
    { id: 'treemap', visible: true }, { id: 'allocation', visible: true }, { id: 'score', visible: true },
    { id: 'dividends', visible: true }, { id: 'earnings', visible: true }, { id: 'news', visible: true },
    { id: 'exp_summary', visible: true },
  ];

  it('sin posiciones oculta los widgets que solo dirían "sin datos"', () => {
    const out = layoutForEmptyPortfolio(layout);
    const visibles = out.filter((w) => w.visible !== false).map((w) => w.id);
    expect(visibles).toEqual(['watchlist', 'exp_summary']);
  });

  it('respeta lo que el usuario ya había ocultado y no muta el layout guardado', () => {
    const hiddenWatch = layout.map((w) => (w.id === 'watchlist' ? { ...w, visible: false } : w));
    expect(layoutForEmptyPortfolio(hiddenWatch).find((w) => w.id === 'watchlist').visible).toBe(false);
    expect(layout.every((w) => w.visible)).toBe(true);
  });

  it('una pareja con una mitad oculta se pinta como widget suelto', () => {
    const groups = computeRenderGroups(layoutForEmptyPortfolio(layout), [['invested', 'watchlist']]);
    expect(groups.map((g) => g.ids)).toEqual([['watchlist'], ['exp_summary']]);
  });
});
