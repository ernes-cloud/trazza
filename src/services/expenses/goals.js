// Gastos: metas de ahorro (sobres), proyectos y flujo del dinero.
// Partido desde services/expenseService.js (2026-10-04), que reexporta la API.

import Decimal from 'decimal.js';
import { D, nextMonthKey } from './internal.js';
import { monthKeyOf, isTemplate } from './entries.js';
import {
  convertEntryForAggregate,
  excludedShape,
  attachExclusions,
} from './fx.js';

const fxSlice = (opts = {}) => (opts.preferredCurrency
  ? { preferredCurrency: opts.preferredCurrency, rates: opts.rates || {} }
  : null);

/**
 * Gasto de un PROYECTO (viaje, reforma, boda) desglosado por categoría.
 *
 * El proyecto es una etiqueta ortogonal a la categoría, así que esto responde a
 * "cuánto nos dejamos EN RESTAURANTES DENTRO del viaje" — imposible si el viaje
 * fuese una categoría más, porque cada movimiento solo tiene una.
 *
 * Los INGRESOS etiquetados al proyecto se restan del total (una devolución del
 * hotel o lo que puso un amigo no es gasto): `total` es el coste NETO, que es lo
 * que de verdad se ha dejado uno. El desglose por categoría es solo de gastos —
 * una categoría con importe negativo no se puede dibujar en una barra.
 *
 * `goal` (opcional) es el sobre de ahorro asociado: añade `allocated` y `pct`
 * (cuánto del sobre se lleva gastado). Sin sobre ambos son null: no hay
 * porcentaje que enseñar sin una referencia, y un 0% mentiría.
 *
 * @returns {{ total:number, spent:number, refunded:number, count:number,
 *   rows:Array<{category:string,value:number,pct:number}>, firstDate:string|null,
 *   lastDate:string|null, allocated:number|null, pct:number|null, overGoal:boolean }}
 */
export function computeProjectSummary(entries = [], { projectId, goal = null, preferredCurrency, rates } = {}) {
  const fxOpts = fxSlice({ preferredCurrency, rates });
  const byCategory = {};
  let spent = new Decimal(0);
  let refunded = new Decimal(0);
  let count = 0;
  let firstDate = null;
  let lastDate = null;
  const excluded = [];

  for (const e of entries) {
    if (isTemplate(e) || !projectId || e.project_id !== projectId) continue;
    const conv = convertEntryForAggregate(e, fxOpts);
    const day = (e.entry_date || '').split('T')[0] || null;
    count += 1;
    if (day) {
      if (!firstDate || day < firstDate) firstDate = day;
      if (!lastDate || day > lastDate) lastDate = day;
    }
    if (e.type === 'income') {
      if (!conv.convertible) {
        excluded.push(excludedShape(e));
        continue;
      }
      refunded = refunded.plus(new Decimal(conv.value));
      continue;
    }
    if (!conv.convertible) {
      excluded.push(excludedShape(e));
      continue;
    }
    const amt = new Decimal(conv.value);
    const cat = e.category || 'other';
    byCategory[cat] = (byCategory[cat] || new Decimal(0)).plus(amt);
    spent = spent.plus(amt);
  }

  const total = spent.minus(refunded);
  const rows = Object.entries(byCategory)
    .map(([category, value]) => ({
      category,
      value: value.toNumber(),
      // El % es sobre el GASTO bruto, no sobre el neto: con devoluciones el neto
      // puede ser menor que una categoría suelta y los porcentajes pasarían de 100.
      pct: spent.gt(0) ? value.div(spent).times(100).toNumber() : 0,
    }))
    .sort((a, b) => b.value - a.value);

  const allocatedRaw = goal ? D(goal.allocated_amount || 0) : null;
  const allocated = allocatedRaw ? allocatedRaw.toNumber() : null;

  return attachExclusions({
    total: total.toNumber(),
    spent: spent.toNumber(),
    refunded: refunded.toNumber(),
    count,
    rows,
    firstDate,
    lastDate,
    allocated,
    pct: allocatedRaw && allocatedRaw.gt(0)
      ? total.div(allocatedRaw).times(100).toNumber()
      : null,
    overGoal: !!(allocatedRaw && allocatedRaw.gt(0) && total.gt(allocatedRaw)),
  }, excluded);
}

/**
 * Money-flow (Sankey) model of one month: where every euro that came in ended up.
 *
 * The diagram is only honest if both sides balance, so the model forces
 * sum(sources) === sum(sinks):
 * - Surplus month → the leftover appears as a `__saved__` SINK (it went to savings).
 * - Deficit month → the shortfall appears as a `__deficit__` SOURCE (it came out
 *   of savings). Inventing neither would draw a diagram that silently loses money.
 *
 * → { sources, sinks, total, income, expenses, net } where sources/sinks are
 * [{ category, value, pct, count, biggest }] sorted desc (the synthetic node
 * always last). `pct` is share of `total`; `count` is how many movements feed
 * the node and `biggest` the largest single one — both drive the hover card, so
 * a channel can explain itself without leaving the diagram. Synthetic nodes
 * (`__saved__`/`__deficit__`) are not movements: count 0, biggest null.
 * Empty month → total 0 and empty arrays.
 */
export function computeMoneyFlow(entries = [], opts = {}) {
  const { year, month, preferredCurrency, rates } = opts;
  const fxOpts = fxSlice({ preferredCurrency, rates });
  const mk = `${year}-${String(month).padStart(2, '0')}`;
  const rows = entries.filter((e) => !isTemplate(e) && monthKeyOf(e.entry_date) === mk);
  const excluded = [];

  // Per category: how many movements and the largest of them (for the hover card)
  const stats = {};
  for (const e of rows) {
    if (e.type !== 'income' && e.type !== 'expense') continue;
    const conv = convertEntryForAggregate(e, fxOpts);
    if (!conv.convertible) continue;
    const cat = e.category || 'other';
    const s = stats[cat] || (stats[cat] = { count: 0, biggest: null });
    s.count += 1;
    const amount = conv.value;
    if (!s.biggest || amount > s.biggest.amount) {
      s.biggest = { amount, notes: e.notes || null, entry_date: (e.entry_date || '').split('T')[0] };
    }
  }

  const byCategory = (type) => {
    const acc = {};
    for (const e of rows) {
      if (e.type !== type) continue;
      const conv = convertEntryForAggregate(e, fxOpts);
      if (!conv.convertible) {
        if (!excluded.some((x) => x.id === e.id)) excluded.push(excludedShape(e));
        continue;
      }
      const cat = e.category || 'other';
      acc[cat] = (acc[cat] || new Decimal(0)).plus(new Decimal(conv.value));
    }
    return acc;
  };

  const incomeCats = byCategory('income');
  const expenseCats = byCategory('expense');
  const sum = (obj) => Object.values(obj).reduce((a, v) => a.plus(v), new Decimal(0));
  const income = sum(incomeCats);
  const expenses = sum(expenseCats);
  const net = income.minus(expenses);

  // Past this many bands per side the ribbons become unreadable hairlines, so
  // the tail collapses into "Otros" (same rule as the category donut).
  const MAX_BANDS = 8;
  const collapseTail = (list) => {
    if (list.length <= MAX_BANDS) return list;
    const head = list.slice(0, MAX_BANDS - 1);
    const tail = list.slice(MAX_BANDS - 1);
    const rest = tail.reduce((a, n) => a.plus(n.value), new Decimal(0));
    // "Otros" hereda el recuento agregado de las categorías que absorbe
    const restCount = tail.reduce((a, n) => a + (stats[n.category]?.count || 0), 0);
    return [...head, { category: '__rest__', value: rest, count: restCount, collapsed: tail.length }];
  };

  let sources = Object.entries(incomeCats).map(([category, value]) => ({ category, value }));
  let sinks = Object.entries(expenseCats).map(([category, value]) => ({ category, value }));
  sources.sort((a, b) => b.value.minus(a.value).toNumber());
  sinks.sort((a, b) => b.value.minus(a.value).toNumber());
  sources = collapseTail(sources);
  sinks = collapseTail(sinks);

  if (net.gt(0)) sinks.push({ category: '__saved__', value: net });
  else if (net.lt(0)) sources.push({ category: '__deficit__', value: net.neg() });

  const total = Decimal.max(income, expenses);
  const decorate = (list, sideTotal) => list.map((node) => {
    const { category, value } = node;
    const stat = stats[category];
    return {
      category,
      value: value.toNumber(),
      pct: total.gt(0) ? value.div(total).times(100).toNumber() : 0,
      // Peso DENTRO de su lado (qué parte de tus gastos / de tus ingresos es):
      // más accionable que el % sobre el total, que ya se ve en la cinta.
      sidePct: sideTotal.gt(0) ? value.div(sideTotal).times(100).toNumber() : 0,
      count: node.count ?? stat?.count ?? 0,
      biggest: stat?.biggest ?? null,
      collapsed: node.collapsed ?? 0,
    };
  });

  return attachExclusions({
    sources: decorate(sources, income),
    sinks: decorate(sinks, expenses),
    total: total.toNumber(),
    income: income.toNumber(),
    expenses: expenses.toNumber(),
    net: net.toNumber(),
  }, excluded);
}

/** Día (no mes) de una fecha ISO, para comparar vencimientos. */
const dayOf = (value) => (value ? String(value).split('T')[0] : null);

/**
 * Una meta CERRADA no retiene dinero: su saldo vuelve al ahorro disponible.
 * Dos formas de cerrarse, y las dos son deliberadas:
 *  - COMPLETADA: el usuario la dio por terminada (`completed_at`). Es un acto
 *    explícito y reversible ("Reabrir"), no una deducción del programa.
 *  - VENCIDA: tenía fecha límite, la fecha pasó y NO se alcanzó el objetivo.
 *    El plan se acabó; seguir reteniendo el dinero haría que "Disponible para
 *    asignar" mintiera indefinidamente por una meta que ya no existe.
 * Una meta CONSEGUIDA y aún abierta SÍ retiene: el dinero del viaje sigue ahí
 * hasta que te vas de viaje (y entonces lo descuenta su propio gasto).
 */
export function isGoalClosed(goal, today) {
  if (goal?.completed_at) return true;
  const due = dayOf(goal?.target_date);
  const now = dayOf(today);
  if (!due || !now || due >= now) return false;
  // Vencida solo si además NO se alcanzó: una meta cumplida cuya fecha pasó no
  // es un fracaso que haya que liquidar, es un logro esperando a gastarse.
  const target = D(goal?.target_amount);
  return !(target.gt(0) && D(goal?.allocated_amount || 0).gte(target));
}

/**
 * Progress of a savings goal under the ALLOCATION model: the user assigns money
 * from their accumulated savings to each goal (envelopes), so the same euro is
 * never counted toward two goals. `allocated` = goal.allocated_amount.
 *
 * TWO SHAPES share this function (and the same table):
 *  - Goal with a target: "1.500 € para el viaje antes del 2027-06-01" → progress
 *    bar, remaining, and `neededPerMonth` (what to assign per remaining month).
 *  - OPEN ENVELOPE (`isOpen`): no target amount and/or no date — "gasolina",
 *    "restaurante". There is nothing to reach, so there is no percentage, no
 *    remaining and no monthly pace: only the balance kept in it. The UI must
 *    read `isOpen` instead of inferring it from a zeroed target, and it must not
 *    render a 0% bar for an envelope that is working exactly as intended.
 *
 * Returns { allocated, saved, target, remaining, pct, reached, monthsLeft,
 * neededPerMonth, isOpen, hasTarget, hasDeadline, completed, expired, closed,
 * released, overspent }.
 */
export function computeGoalProgress({ goal, today, spent = 0 } = {}) {
  const target = D(goal?.target_amount);
  const assigned = D(goal?.allocated_amount || 0);
  // `spent` = lo ya gastado a través de los proyectos enlazados. El sobre es un
  // SALDO: lo que metiste menos lo que ya has sacado. Por eso todo lo que sigue
  // (progreso, restante, ritmo) se calcula sobre el saldo y no sobre lo metido:
  // un sobre de viaje que ya se ha gastado entero no está "al 100% conseguido",
  // está a cero y disponible para volver a llenarse.
  const spentD = Decimal.max(D(spent), 0);
  const allocated = Decimal.max(assigned.minus(spentD), 0);
  // Lo gastado POR ENCIMA de lo que había en el sobre. El saldo se queda en 0
  // (restarlo otra vez del ahorro lo contaría dos veces: ese gasto ya bajó el
  // ahorro acumulado por sí mismo), pero el exceso no puede desaparecer de la
  // pantalla — es justo lo que el usuario necesita saber.
  const overspent = Decimal.max(spentD.minus(assigned), 0);
  const todayKey = monthKeyOf(today);
  const targetKey = monthKeyOf(goal?.target_date);

  // Meses en los que TODAVÍA puedes apartar dinero, contando el actual. Antes
  // arrancaba en `nextMonthKey(todayKey)` y el mes en curso no contaba, con dos
  // consecuencias malas:
  //  - El 1 de septiembre, con fecha límite el 14 de diciembre, decía "asigna
  //    901 €/mes" (3 meses) cuando quedan CUATRO oportunidades — sep, oct, nov,
  //    dic — o sea 676 €/mes: un 33% de más justo al empezar el mes.
  //  - En el mes del vencimiento daba 0 → `neededPerMonth` null → la línea
  //    "Asigna X/mes" DESAPARECÍA en el último tramo, que es cuando más falta
  //    hace. Ahora ese mes vale 1 y dice cuánto queda por apartar.
  // Una meta ya vencida no llega aquí: `neededPerMonth` exige `!closed`.
  let monthsLeft = 0;
  if (todayKey && targetKey && targetKey >= todayKey) {
    for (let mk = todayKey; mk <= targetKey; mk = nextMonthKey(mk)) monthsLeft += 1;
  }

  const hasTarget = target.gt(0);
  const hasDeadline = !!targetKey;

  // CONSEGUIDA se decide sobre lo ASIGNADO (lo que metiste), no sobre el saldo.
  // Una meta cumplida es un LOGRO, y un logro no se deshace porque después
  // gastes aquello para lo que ahorrabas: juntaste los 5.000 € del viaje y luego
  // te fuiste de viaje — eso es un éxito, no un retroceso al 40%. Como
  // `allocated_amount` solo lo cambia el usuario (los gastos del proyecto NO lo
  // tocan, se descuentan aparte), el estado queda congelado sin escrituras
  // automáticas: si algún día reasigna el dinero a mano, la meta deja de estar
  // cumplida, que es lo esperable. CONSEGUIDA es DERIVADA y no se persiste; no
  // confundir con `completed_at`, que es el cierre EXPLÍCITO del usuario
  // (`completed`) y sí libera el dinero.
  const reached = hasTarget && assigned.gte(target);

  // Estados de CIERRE (ver isGoalClosed). Se derivan aquí para que la tarjeta no
  // vuelva a decidirlos por su cuenta: el dinero que se libera y la etiqueta que
  // se pinta tienen que salir del mismo sitio.
  const completed = !!goal?.completed_at;
  const closed = isGoalClosed(goal, today);
  const expired = closed && !completed;

  // Mientras NO está conseguida, el progreso sí sigue al saldo: sacar dinero de
  // un sobre a medias es ir hacia atrás de verdad. Una vez conseguida, congela.
  const progressBase = reached ? assigned : allocated;
  const remaining = hasTarget ? Decimal.max(target.minus(progressBase), 0) : new Decimal(0);

  return {
    // Con la meta conseguida se muestra lo asignado (congelado); si no, el saldo.
    allocated: progressBase.toNumber(),
    balance: allocated.toNumber(),        // saldo real del sobre, siempre
    assigned: assigned.toNumber(),        // lo que se metió, antes de gastar
    spent: spentD.toNumber(),             // lo consumido por proyectos enlazados
    saved: progressBase.toNumber(), // alias kept for the UI
    target: hasTarget ? target.toNumber() : null,
    remaining: remaining.toNumber(),
    pct: hasTarget ? Math.max(0, Math.min(100, progressBase.div(target).times(100).toNumber())) : null,
    reached,
    completed,
    expired,
    closed,
    // Lo que vuelve al ahorro disponible por estar cerrada (0 si sigue abierta).
    released: closed ? allocated.toNumber() : 0,
    overspent: overspent.toNumber(),
    monthsLeft,
    // Sin objetivo no hay ritmo que calcular: repartir "lo que falta" (0) entre
    // los meses restantes daría un 0 €/mes que se lee como "ya no hace falta".
    neededPerMonth: hasTarget && !reached && !closed && monthsLeft > 0 ? remaining.div(monthsLeft).toNumber() : null,
    hasTarget,
    hasDeadline,
    isOpen: !hasTarget,
  };
}

/**
 * Gasto neto YA consumido de cada sobre, a través de los proyectos enlazados a
 * él: { [goal_id]: importe }.
 *
 * Un sobre es un SALDO, no un histórico: metes dinero (`allocated_amount`) y el
 * gasto del viaje lo saca. Sin esto el dinero se descontaba DOS VECES — el gasto
 * bajaba el ahorro acumulado y además el sobre seguía reservando su importe
 * íntegro, así que pagar el viaje reducía el "disponible para asignar" por el
 * doble de lo gastado.
 *
 * Derivado, nunca escrito en BD: borrar o editar un gasto recalcula solo. Mutar
 * `allocated_amount` al guardar cada movimiento exigiría revertirlo al borrar y
 * cualquier fallo dejaría el saldo mintiendo para siempre.
 */
export function computeGoalSpendingByGoal(projects = [], entries = [], fxOpts = null) {
  const out = {};
  for (const project of projects) {
    if (!project?.goal_id) continue;
    const summaryOpts = { projectId: project.id, ...(fxOpts || {}) };
    const { total } = computeProjectSummary(entries, summaryOpts);
    out[project.goal_id] = (out[project.goal_id] || new Decimal(0)).plus(D(total));
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.toNumber()]));
}

/**
 * Suma del dinero que sigue RESERVADO en los sobres — lo que hay que restar del
 * ahorro para saber cuánto queda libre.
 *
 * `spendingByGoal` (de computeGoalSpendingByGoal) descuenta lo ya gastado: un
 * sobre de 700 € con 691 € de viaje ya pagado solo retiene 9 €. Sin el mapa se
 * comporta como antes (suma íntegra), que es lo correcto cuando no hay proyectos.
 * `today` habilita el vencimiento: sin él, una meta con la fecha pasada seguiría
 * reteniendo su dinero (las completadas se excluyen con o sin fecha).
 */
export function computeAllocatedTotal(goals = [], spendingByGoal = {}, { today = null } = {}) {
  return goals.reduce((sum, g) => {
    // Una meta cerrada (completada o vencida sin alcanzarse) devuelve su saldo
    // al ahorro disponible: deja de contar aquí. Sin `today` no hay vencimiento
    // que evaluar, pero las completadas se excluyen igual.
    if (isGoalClosed(g, today)) return sum;
    const allocated = D(g.allocated_amount || 0);
    const spent = D(spendingByGoal[g.id] || 0);
    // Nunca negativo: si el viaje se pasó del sobre, el exceso ya bajó del ahorro
    // total por su propio gasto; restarlo otra vez aquí lo contaría dos veces.
    return sum.plus(Decimal.max(allocated.minus(spent), 0));
  }, new Decimal(0)).toNumber();
}
