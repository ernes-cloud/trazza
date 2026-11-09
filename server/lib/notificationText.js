/**
 * Textos y calendario de los avisos del cron (notificaciones + correo).
 *
 * Módulo PURO: sin Supabase ni fecha del sistema. El cron le pasa "hoy" (fecha
 * de Madrid) y el idioma del usuario, y recibe { title, message, dedup }.
 *
 * - Idioma: el de `user_preferences.language` (lo guarda la app con el idioma
 *   detectado). Antes todo salía en español aunque el usuario usara Trazza en
 *   inglés. Cualquier valor que no sea 'en' cae a español.
 * - `dedup` es el PREFIJO estable del mensaje: el cron busca avisos previos con
 *   `ilike 'prefijo%'`, así que el prefijo no puede llevar valores que cambien
 *   entre pasadas (EPS corregido, % en vivo, "hoy"/"mañana").
 * - Fechas de calendario en 'YYYY-MM-DD'. Las cuentas son por DÍA, no por
 *   milisegundos: "en 7 días" con (fecha − ahora)/86400000 dependía de la hora
 *   de la pasada y el aviso de ex-dividendo de un lunes llegaba en domingo.
 */
import { formatMoney } from './money.js';

const LOCALE = { es: 'es-ES', en: 'en-GB' };
export const langOf = (lang) => (lang === 'en' ? 'en' : 'es');

/** 'YYYY-MM-DD' (o ISO) → número de día (días desde epoch, UTC). */
export function dayNumber(dateStr) {
  const [y, m, d] = String(dateStr || '').slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

/** Días de calendario de `from` a `to` (positivo si `to` es posterior). */
export function daysBetween(from, to) {
  const a = dayNumber(from);
  const b = dayNumber(to);
  return a == null || b == null ? null : b - a;
}

const isoOfDay = (n) => new Date(n * 86400000).toISOString().slice(0, 10);

/**
 * Último día hábil (lun–vie) ANTERIOR a la fecha ex-dividendo: el último día en
 * que comprar da derecho al dividendo (con la fecha ex fijada según la
 * liquidación, vale igual con T+1 en EE. UU. y T+2 en Europa). Ex el lunes →
 * el viernes. No conoce festivos: en un festivo el aviso llega un día antes de
 * lo justo, nunca tarde.
 */
export function lastBuyDay(exDate) {
  let n = dayNumber(exDate);
  if (n == null) return null;
  do { n -= 1; } while ([0, 6].includes(new Date(n * 86400000).getUTCDay()));
  return isoOfDay(n);
}

const dateLabel = (iso, lang) =>
  new Date(`${String(iso).slice(0, 10)}T12:00:00Z`)
    .toLocaleDateString(LOCALE[langOf(lang)], { day: 'numeric', month: 'short', timeZone: 'UTC' });

const money = (amount, currency, lang, opts) => formatMoney(amount, currency, { ...opts, lang: langOf(lang) });

// ── Dividendos ───────────────────────────────────────────────────────────────

const perShare = (amount, currency, lang) =>
  amount != null ? ` (${money(amount, currency, lang, { decimals: 4 })}${lang === 'en' ? '/share' : '/acción'})` : '';

// Va al FINAL del mensaje: el dedupe es por prefijo y no debe cambiar.
const estimatedNote = (estimated, lang) => (!estimated ? ''
  : lang === 'en' ? ' · date estimated from the payment history, not announced'
    : ' · fecha estimada por el historial de pagos, no anunciada');

/**
 * Aviso de dividendo del día, o null si hoy no toca.
 * @param {{ ticker: string, exDate: string, amount?: number|null, currency?: string,
 *           estimated?: boolean, today: string, lang?: string }} p
 */
export function exDividendNotice({ ticker, exDate, amount = null, currency = 'USD', estimated = false, today, lang = 'es' }) {
  const l = langOf(lang);
  if (!exDate || !today) return null;
  const exLabel = dateLabel(exDate, l);
  const tail = `${perShare(amount, currency, l)}${estimatedNote(estimated, l)}`;

  if (lastBuyDay(exDate) === today) {
    const dedup = l === 'en'
      ? `⚠️ ${ticker} — last day to buy and get the dividend (ex-dividend ${exLabel})`
      : `⚠️ ${ticker} — último día para comprar y cobrar el dividendo (ex-dividendo el ${exLabel})`;
    return {
      title: l === 'en' ? '⚠️ Last day for the dividend' : '⚠️ Último día para el dividendo',
      message: `${dedup}${l === 'en' ? ': today' : ': hoy'}${tail}`,
      dedup, type: 'warning',
    };
  }
  if (daysBetween(today, exDate) === 7) {
    const dedup = l === 'en'
      ? `📅 ${ticker} — ex-dividend date in 7 days (${exLabel})`
      : `📅 ${ticker} — fecha ex-dividendo en 7 días (${exLabel})`;
    return {
      title: l === 'en' ? '📅 Upcoming dividend' : '📅 Dividendo próximo',
      message: `${dedup}${tail}`,
      dedup, type: 'dividend',
    };
  }
  return null;
}

/** Dividendo pagado en los últimos 3 días, o null. */
export function dividendPaidNotice({ ticker, paymentDate, amount = null, currency = 'USD', quantity = 0, today, lang = 'es' }) {
  const l = langOf(lang);
  const since = daysBetween(paymentDate, today);
  if (since == null || since < 0 || since > 3) return null;
  const payLabel = dateLabel(paymentDate, l);
  const total = amount && quantity > 0
    ? (l === 'en' ? ` — estimated total ${money(amount * quantity, currency, l)}` : ` — total estimado ${money(amount * quantity, currency, l)}`)
    : '';
  const dedup = l === 'en' ? `💰 ${ticker} — dividend paid on ${payLabel}` : `💰 ${ticker} — dividendo pagado el ${payLabel}`;
  return {
    title: l === 'en' ? `💰 Dividend received: ${ticker}` : `💰 Dividendo cobrado: ${ticker}`,
    message: `${dedup}${perShare(amount, currency, l)}${total}`,
    dedup, type: 'dividend',
  };
}

// ── Resultados ───────────────────────────────────────────────────────────────

/**
 * Aviso previo a la publicación de resultados (hoy/mañana o a 7 días), o null.
 * Tipo 'earnings': antes iban como 'dividend' y el correo salía con 💰 y la
 * etiqueta "Dividendos".
 */
export function earningsUpcomingNotice({ ticker, date, today, lang = 'es' }) {
  const l = langOf(lang);
  const days = daysBetween(today, date);
  if (days == null) return null;
  const label = dateLabel(date, l);
  if (days === 0 || days === 1) {
    const dedup = l === 'en' ? `⚡ ${ticker} reports earnings on ${label}` : `⚡ ${ticker} publica resultados el ${label}`;
    const when = days === 0 ? (l === 'en' ? 'today' : 'hoy') : (l === 'en' ? 'tomorrow' : 'mañana');
    return {
      title: l === 'en' ? '⚡ Earnings imminent' : '⚡ Resultados inminentes',
      message: `${dedup} (${when})`,
      dedup, type: 'earnings',
    };
  }
  if (days === 7) {
    const dedup = l === 'en' ? `📅 ${ticker} reports earnings in 7 days` : `📅 ${ticker} publica resultados en 7 días`;
    return {
      title: l === 'en' ? '📅 Upcoming earnings' : '📅 Resultados próximos',
      message: `${dedup} (${label})`,
      dedup, type: 'earnings',
    };
  }
  return null;
}

/** Resultado publicado (EPS real frente a la previsión). */
export function earningsResultNotice({ ticker, date, epsActual, epsForecast = null, surprisePct = null, lang = 'es' }) {
  const l = langOf(lang);
  const beat = epsForecast !== null && epsActual > epsForecast;
  const surprise = surprisePct !== null ? ` (${surprisePct > 0 ? '+' : ''}${surprisePct.toFixed(1)}%)` : '';
  const est = epsForecast !== null ? ` vs est. $${epsForecast.toFixed(2)}` : '';
  // Prefijo estable: ticker + fecha del trimestre (NO el EPS, que Nasdaq
  // suele corregir en las horas siguientes).
  const dedup = `${ticker} · ${date}:`;
  const verdict = l === 'en'
    ? (beat ? '✅ Beat estimates' : '❌ Missed estimates')
    : (beat ? '✅ Superó previsiones' : '❌ No alcanzó previsiones');
  return {
    title: `${beat ? '✅' : '❌'} ${l === 'en' ? 'Earnings' : 'Resultados'}: ${ticker}`,
    message: `${dedup} ${l === 'en' ? 'Actual EPS' : 'EPS real'} $${epsActual.toFixed(2)}${est}. ${verdict}${surprise}`,
    dedup, type: beat ? 'success' : 'error',
  };
}

// ── Alertas ──────────────────────────────────────────────────────────────────

export function priceTargetNotice({ ticker, target, currency, upside, lang = 'es' }) {
  const l = langOf(lang);
  const amount = money(target, currency, l, { minDecimals: 0 });
  const message = l === 'en'
    ? `${ticker} ${upside ? 'reached' : 'fell to'} the ${amount} target (${upside ? 'Up' : 'Down'})`
    : `${ticker} ${upside ? 'alcanzó el' : 'cayó al'} objetivo de ${amount} (${upside ? 'Sube' : 'Baja'})`;
  return { title: l === 'en' ? '🔔 Price alert' : '🔔 Alerta de precio', message, dedup: message, type: 'alert' };
}

export function percentMoveNotice({ ticker, change, target, lang = 'es' }) {
  const l = langOf(lang);
  const pct = Math.abs(change).toFixed(2);
  const message = l === 'en'
    ? `${ticker} ${change >= 0 ? 'rose' : 'fell'} ${pct}% today (Target: ±${target}%)`
    : `${ticker} ${change >= 0 ? 'subió' : 'bajó'} un ${pct}% hoy (Objetivo: ±${target}%)`;
  // Patrón ilike: ese ticker y ese umbral hoy, sea cual sea el % y el sentido.
  const dedup = l === 'en' ? `${ticker} %(Target: ±${target}%` : `${ticker} %(Objetivo: ±${target}%`;
  return { title: l === 'en' ? '🔔 Price alert' : '🔔 Alerta de precio', message, dedup, type: 'alert' };
}

export function portfolioMoveNotice({ brokerName = null, pct, threshold, lang = 'es' }) {
  const l = langOf(lang);
  const label = brokerName || (l === 'en' ? 'Your portfolio' : 'Tu cartera');
  const moved = l === 'en' ? (pct >= 0 ? 'rose' : 'fell') : (pct >= 0 ? 'subió' : 'bajó');
  const base = l === 'en' ? '📊 Portfolio alert' : '📊 Alerta de cartera';
  const dedup = `📊 ${label} ${moved}`;
  return {
    title: brokerName ? `${base} · ${brokerName}` : base,
    message: l === 'en'
      ? `${dedup} ${Math.abs(pct).toFixed(2)}% today (threshold: ±${threshold}%)`
      : `${dedup} un ${Math.abs(pct).toFixed(2)}% hoy (umbral: ±${threshold}%)`,
    dedup, type: pct >= 0 ? 'success' : 'warning',
  };
}

// ── Gastos recurrentes ───────────────────────────────────────────────────────

const EXPENSE_CATEGORY = {
  es: {
    housing: 'Vivienda', groceries: 'Supermercado', restaurants: 'Restaurantes', transport: 'Transporte',
    utilities: 'Suministros', subscriptions: 'Suscripciones', health: 'Salud', leisure: 'Ocio',
    shopping: 'Compras', travel: 'Viajes', education: 'Educación', taxes: 'Impuestos', insurance: 'Seguros',
    pets: 'Mascotas', salary: 'Nómina', freelance: 'Autónomo', gift: 'Regalo', other: 'Otros',
  },
  en: {
    housing: 'Housing', groceries: 'Groceries', restaurants: 'Restaurants', transport: 'Transport',
    utilities: 'Utilities', subscriptions: 'Subscriptions', health: 'Health', leisure: 'Leisure',
    shopping: 'Shopping', travel: 'Travel', education: 'Education', taxes: 'Taxes', insurance: 'Insurance',
    pets: 'Pets', salary: 'Salary', freelance: 'Freelance', gift: 'Gift', other: 'Other',
  },
};

export function recurringEndNotice({ label, category, type, amount, endDate, daysLeft, lang = 'es' }) {
  const l = langOf(lang);
  const catName = EXPENSE_CATEGORY[l][category] || category;
  const endLabel = new Date(`${endDate}T12:00:00Z`)
    .toLocaleDateString(LOCALE[l], { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const amountStr = money(amount, 'EUR', l);
  if (l === 'en') {
    const kind = type === 'income' ? 'income' : 'expense';
    const when = daysLeft === 0 ? 'today' : daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`;
    const dedup = `🔁 "${label}" (${catName}) — recurring ${kind} ending on ${endLabel}`;
    return {
      title: daysLeft <= 1 ? '🔁 A recurring entry ends now' : '🔁 A recurring entry is ending',
      message: `${dedup} · ${when}. ${amountStr}/month will stop being recorded.`,
      dedup, type: 'alert',
    };
  }
  const kind = type === 'income' ? 'ingreso' : 'gasto';
  const when = daysLeft === 0 ? 'hoy' : daysLeft === 1 ? 'mañana' : `en ${daysLeft} días`;
  const dedup = `🔁 "${label}" (${catName}) — ${kind} recurrente que termina el ${endLabel}`;
  return {
    title: daysLeft <= 1 ? '🔁 Un recurrente termina ya' : '🔁 Un recurrente va a terminar',
    message: `${dedup} · ${when}. Son ${amountStr}/mes que dejarán de anotarse.`,
    dedup, type: 'alert',
  };
}
