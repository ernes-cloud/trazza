/**
 * Avisos de FIN de un gasto/ingreso recurrente.
 *
 * Una plantilla recurrente con `recurrence_until` deja de generar movimientos ese
 * día sin decir nada: el usuario se entera cuando echa de menos el apunte, o peor,
 * cuando sigue pagando algo que creía cancelado. Esto avisa con la antelación que
 * cada uno elija (7 y 1 día por defecto).
 *
 * Módulo PURO a propósito: sin Supabase, sin fechas del sistema, sin efectos.
 * Toda la decisión de "a quién y cuándo avisar" es testeable en milisegundos; el
 * cron solo aporta los datos y escribe el resultado.
 */

/** Antelaciones ofrecidas en Settings. 0 = el mismo día en que termina. */
export const LEAD_DAY_OPTIONS = [0, 1, 3, 7, 14, 30];

/** Config por defecto: avisar una semana antes y la víspera. */
export const DEFAULT_RECURRING_END_ALERTS = { enabled: true, leadDays: [7, 1] };

/** 'YYYY-MM-DD' (o ISO con T) → días de calendario entre dos fechas, en UTC. */
const dayNumber = (dateStr) => {
  const day = String(dateStr || '').split('T')[0];
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return null;
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
};

/**
 * Normaliza la preferencia guardada. Tolera null (usuario que nunca la tocó),
 * JSON corrupto y valores fuera de catálogo: una preferencia inválida no puede
 * dejar sin avisos al usuario NI reventar el cron de todos los demás.
 */
export function normalizeAlertPrefs(raw) {
  if (raw === null || raw === undefined) return { ...DEFAULT_RECURRING_END_ALERTS };
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { return { ...DEFAULT_RECURRING_END_ALERTS }; }
  }
  if (typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_RECURRING_END_ALERTS };

  const enabled = value.enabled !== false;
  const leadDays = Array.isArray(value.leadDays)
    ? [...new Set(value.leadDays.map(Number).filter((n) => LEAD_DAY_OPTIONS.includes(n)))].sort((a, b) => b - a)
    : [...DEFAULT_RECURRING_END_ALERTS.leadDays];
  // Activado pero sin ninguna antelación = no avisar nunca; es una configuración
  // legítima (el usuario desmarcó todas), no un motivo para volver al default.
  return { enabled, leadDays };
}

/**
 * Qué avisos de fin de recurrente tocan HOY.
 *
 * @param {Array} templates  filas de expense_entries que son plantillas
 *   (`recurrence === 'monthly'`) con user_id, name/notes, category, amount,
 *   recurrence_until y recurrence_active.
 * @param {Object} prefsByUser  user_id → preferencia cruda (jsonb o null).
 * @param {string} today  'YYYY-MM-DD' del día en curso.
 * @returns {Array<{userId,templateId,label,category,amount,type,endDate,daysLeft}>}
 */
export function computeRecurringEndAlerts({ templates = [], prefsByUser = {}, today } = {}) {
  const todayNum = dayNumber(today);
  if (todayNum === null) return [];

  const out = [];
  for (const tpl of templates) {
    if (!tpl || tpl.recurrence !== 'monthly') continue;
    if (tpl.recurrence_active === false) continue;
    if (!tpl.user_id || !tpl.recurrence_until) continue;

    const endNum = dayNumber(tpl.recurrence_until);
    if (endNum === null) continue;

    const daysLeft = endNum - todayNum;
    // Ya terminó: avisar a toro pasado solo genera ruido.
    if (daysLeft < 0) continue;

    const prefs = normalizeAlertPrefs(prefsByUser[tpl.user_id]);
    if (!prefs.enabled) continue;
    // Coincidencia EXACTA con la antelación elegida, no "menor o igual": con <=
    // un aviso a 7 días se repetiría cada día hasta el final (el dedupe del cron
    // solo cubre 24 h) y acabaría siendo ruido que se ignora.
    if (!prefs.leadDays.includes(daysLeft)) continue;

    out.push({
      userId: tpl.user_id,
      templateId: tpl.id,
      label: (tpl.notes || '').trim() || tpl.category || 'other',
      category: tpl.category || 'other',
      amount: Number(tpl.amount) || 0,
      type: tpl.type === 'income' ? 'income' : 'expense',
      endDate: String(tpl.recurrence_until).split('T')[0],
      daysLeft,
    });
  }
  return out;
}
