/**
 * Tope de correos de notificación por usuario y día. PURO: sin red, sin
 * estado, testeable.
 *
 * Por qué existe: nada impedía que un usuario recibiera cientos de correos.
 * El dedupe de `insertNotification` es por (user_id + prefijo del mensaje) en
 * 24 h, así que frena el mensaje REPETIDO pero no el VOLUMEN: un cron con un
 * fallo, una cartera con 60 posiciones en un día de resultados o una alerta
 * mal configurada generan decenas de avisos DISTINTOS, y cada uno sale por
 * correo. El daño no es solo la molestia: quien se ve inundado marca como
 * spam, y una queja de spam hace más daño a la reputación del dominio que
 * mil entregas buenas — justo lo que acabamos de migrar a Resend para
 * arreglar.
 *
 * El tope corta el CORREO, no la notificación: la fila de `notifications`
 * se inserta igual y el usuario la ve dentro de la app. No se pierde
 * información, se deja de empujarla al buzón.
 */

/** Correos de notificación que puede recibir un usuario en un día natural. */
export const DAILY_NOTIFICATION_EMAIL_LIMIT = 15;

/**
 * Milisegundos que una zona va por delante de UTC EN ESE INSTANTE (así el
 * horario de verano se resuelve solo, sin tabla de reglas ni dependencias).
 */
function tzOffsetMs(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  // `hour` puede venir como "24" a medianoche en algunos ICU: %24 lo normaliza.
  const asIfUtc = Date.UTC(
    +parts.year, +parts.month - 1, +parts.day,
    +parts.hour % 24, +parts.minute, +parts.second
  );
  return asIfUtc - date.getTime();
}

/**
 * Instante UTC en el que empezó el día NATURAL de Madrid que contiene `now`.
 *
 * Se cuenta por día de Madrid y no con `toISOString()` por el mismo motivo
 * que el resto del proyecto: el servidor corre en UTC, así que entre las
 * 00:00 y las 02:00 de Madrid el "hoy" de UTC es AYER y el contador se
 * reiniciaría con dos horas de retraso — o, peor, dejaría pasar un segundo
 * cupo de 15 correos en esa franja.
 *
 * @param {Date} [now]
 * @returns {Date} medianoche de Madrid, expresada en UTC
 */
export function madridDayStartUtc(now = new Date()) {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now).split('-').map(Number);

  // Medianoche "como si fuera UTC", corregida por el desfase real de Madrid
  // en ese momento. Se evalúa el desfase EN esa medianoche y no en `now`
  // porque son instantes distintos y pueden caer a distinto lado del cambio
  // de hora. Las transiciones ocurren a las 02:00/03:00, así que la
  // medianoche nunca es ambigua.
  const midnightAsUtc = Date.UTC(y, m - 1, d, 0, 0, 0);
  const offset = tzOffsetMs(new Date(midnightAsUtc), 'Europe/Madrid');
  return new Date(midnightAsUtc - offset);
}

/**
 * ¿Cabe un correo más hoy?
 *
 * @param {number} sentToday  correos ya enviados hoy a ese usuario
 * @param {number} [limit]
 * @returns {{ allowed: boolean, remaining: number }}
 */
export function checkDailyQuota(sentToday, limit = DAILY_NOTIFICATION_EMAIL_LIMIT) {
  // Un recuento que no es un número (una consulta que falló y devolvió null)
  // NO puede bloquear: el coste de perder un aviso legítimo por un tropiezo
  // de la base es mayor que el de dejar pasar unos correos de más. Misma
  // asimetría que la clasificación de reintentos.
  const n = Number.isFinite(sentToday) ? Math.max(0, sentToday) : 0;
  const remaining = Math.max(0, limit - n);
  return { allowed: n < limit, remaining };
}
