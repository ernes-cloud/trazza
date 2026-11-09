/**
 * Título y descripción de la vista previa de una cartera compartida (lo que
 * enseñan WhatsApp, Telegram, X o LinkedIn al pegar /share/:token). PURO.
 *
 * Por qué existe: la SPA servía a todas las carteras el <head> de la portada,
 * así que cada enlace compartido se veía como un anuncio genérico de Trazza y
 * no como la cartera de alguien. La cartera compartida es el único sitio por el
 * que un usuario enseña Trazza a otros sin que se lo pidamos.
 *
 * Reglas de privacidad:
 *   - NUNCA importes en euros, aunque el dueño los muestre en la página: una
 *     vista previa se reenvía y se queda en chats ajenos.
 *   - Porcentajes solo con `show_pnl` (el mismo interruptor que los tapa en la
 *     página).
 *   - Enlace caducado o inexistente → texto genérico, sin la etiqueta.
 */

const MAX_LABEL = 60;
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const CLOSING = 'Cartera compartida con Trazza. Lleva la tuya gratis: importa DeGiro, IBKR o Trading 212 en minutos.';
const UNAVAILABLE = {
  title: 'Cartera compartida · Trazza',
  description: 'Este enlace ya no está disponible. Lleva el seguimiento de tu cartera con Trazza, gratis.',
};

/** +27,4 % / −3,1 % (signo menos tipográfico), o null si no es un número. */
export function formatSignedPct(value) {
  const v = Number(value);
  if (value == null || !Number.isFinite(v)) return null;
  const abs = Math.abs(v).toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (abs === '0,0') return '0,0 %';
  return `${v > 0 ? '+' : '−'}${abs} %`;
}

/** "octubre de 2024" a partir de 'YYYY-MM-DD…', o null. */
export function formatMonthYear(iso) {
  const m = /^(\d{4})-(\d{2})/.exec(String(iso || ''));
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} de ${m[1]}` : null;
}

function cleanLabel(label) {
  const s = String(label || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1).trimEnd()}…` : s;
}

/**
 * @param {object|null} share  fila de portfolio_shares (label, config, expires_at, cached_metrics, snapshot_data)
 * @param {{ now?: Date }} [opts]
 * @returns {{ title: string, description: string, available: boolean }}
 */
export function buildShareMeta(share, { now = new Date() } = {}) {
  if (!share) return { ...UNAVAILABLE, available: false };
  if (share.expires_at && new Date(share.expires_at) < now) return { ...UNAVAILABLE, available: false };

  const label = cleanLabel(share.label);
  const title = label ? `${label} · cartera en Trazza` : 'Cartera compartida en Trazza';

  const cfg = share.config || {};
  // Solo una FOTO FIJA tiene cifras que no cambian: lo que diga la vista previa
  // es lo que enseña la página. En una cartera EN VIVO la página recalcula todo
  // al abrirla y `cached_metrics` es la foto del día en que se creó el enlace
  // (medido: +15,0 % anual en caché de junio frente a +6,32 % en la página).
  // Calcularlo aquí costaría segundos de cotizaciones y los generadores de
  // vistas previas cortan antes, así que en vivo no se da ninguna cifra.
  const isSnapshot = share.mode === 'snapshot';
  const metrics = isSnapshot ? (share.snapshot_data?.metrics || share.cached_metrics || {}) : {};
  const facts = [];

  if (!isSnapshot) facts.push('Cartera en vivo, con los precios de cada día');

  if (isSnapshot && cfg.show_pnl) {
    const annual = formatSignedPct(metrics.annualized_return);
    const twr = formatSignedPct(metrics.twr);
    if (annual) facts.push(`Rentabilidad anualizada ${annual}`);
    if (twr) facts.push(`TWR ${twr}`);
    if (!annual && !twr) {
      const roi = formatSignedPct(metrics.roi_cartera);
      if (roi) facts.push(`Plusvalía actual ${roi}`);
    }
  }
  const since = formatMonthYear(metrics.invested_since || metrics.first_trade_date);
  if (since && facts.length) facts.push(`desde ${since}`);

  const description = facts.length ? `${facts.join(' · ')}. ${CLOSING}` : CLOSING;
  return { title, description, available: true };
}
