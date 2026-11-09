/**
 * Caché en localStorage de las series históricas que alimentan el TWR.
 *
 * SE GUARDA SOLO { time, close }, que es literalmente lo único que lee
 * `calculateDailyTWR` (18 accesos, todos `.time` o `.close`). Yahoo devuelve
 * además open/high/low/volume: guardarlos costaba 271 KB por ticker frente a
 * 106 KB, así que con el límite típico de ~5 MB por origen cabían 18 tickers en
 * vez de 48 — y eso ANTES de los pares FX, el S&P y las demás cachés.
 *
 * POR QUÉ ESTO ERA EL FALLO DE RAÍZ: al llenarse la cuota, `setItem` lanza, y el
 * `catch {}` que había lo tragaba. La caché dejaba de completarse EN SILENCIO y
 * cada recarga volvía a descargar la cola de tickers → 429 de Yahoo → el activo
 * sin histórico se valora a CERO en toda la serie → un porcentaje distinto en
 * cada carga (medido por el owner sobre la MISMA cartera y el mismo capital
 * invertido: +17,67%, +18,10% y +42,68%). El pool de `asyncPool` bajó el ritmo
 * de las peticiones; esto quita la necesidad de repetirlas.
 *
 * Vive fuera del hook para poder probarse: el desalojo por cuota es justo la
 * clase de lógica que falla callando, y sin test no hay forma de saber que sigue
 * haciendo sitio en vez de rendirse.
 */

export const PERF_LS_PREFIX = 'wf_perf_hist_';

/** localStorage puede no existir (SSR) o lanzar al tocarlo (modo privado). */
function defaultStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export const slimBars = (data) =>
  (Array.isArray(data) ? data : []).map(({ time, close }) => ({ time, close }));

export function createPerfHistCache({
  storage = defaultStorage(),
  prefix = PERF_LS_PREFIX,
  range = '',
  ttl = 23 * 60 * 60 * 1000,
  now = () => Date.now(),
  warn = (msg) => console.warn(msg),
} = {}) {
  // El rango va DENTRO de la clave: sin él, una serie de 5y guardada ayer se
  // serviría como si fuera de 10y.
  const keyFor = (key) => `${prefix}${key}|${range}`;

  /** Entradas de ESTA caché con su fecha, para desalojar por antigüedad. */
  const entries = () => {
    const out = [];
    if (!storage) return out;
    try {
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (!k || !k.startsWith(prefix)) continue;
        let ts = 0;
        try { ts = JSON.parse(storage.getItem(k))?.ts ?? 0; } catch { /* corrupta → la primera en caer */ }
        out.push({ key: k, ts });
      }
    } catch { /* storage inaccesible */ }
    return out;
  };

  /**
   * Hace sitio: primero lo VENCIDO y, si no hay nada vencido, el cuarto más
   * antiguo. Devuelve si liberó algo, para no reintentar en bucle.
   *
   * Desaloja SOLO claves con nuestro prefijo: el resto de localStorage
   * (preferencias, broker seleccionado, consentimiento) no es nuestro.
   */
  const prune = () => {
    const all = entries();
    if (!all.length) return false;
    const t = now();
    const expired = all.filter(e => t - e.ts > ttl);
    const victims = expired.length
      ? expired
      : all.sort((a, b) => a.ts - b.ts).slice(0, Math.max(1, Math.ceil(all.length / 4)));
    let freed = 0;
    for (const v of victims) {
      try { storage.removeItem(v.key); freed++; } catch { /* ignora */ }
    }
    return freed > 0;
  };

  // Una serie también caduca al CAMBIAR DE DÍA (hora local), no solo por TTL.
  // Con el TTL a secas cada ticker vencía a una hora distinta —según cuándo se
  // descargó— y el TWR mezclaba series que terminaban en días distintos, o con
  // el precio de media sesión de una barra aún abierta guardado como "cierre"
  // hasta 23 h después. Medido el 2026-10-02: el gráfico 1W marcaba -1,64 % y
  // el mismo cálculo con datos frescos daba -0,83 %. Caducando por día, todas
  // las series se refrescan juntas y la barra provisional no pasa de su día.
  const dayOf = (ms) => new Date(ms).toDateString();

  const load = (key) => {
    if (!storage) return null;
    try {
      const raw = storage.getItem(keyFor(key));
      if (!raw) return null;
      const { ts, data } = JSON.parse(raw);
      if (!Array.isArray(data)) return null;
      const t = now();
      return { data, stale: t - ts > ttl || dayOf(ts) !== dayOf(t) };
    } catch { return null; }
  };

  const save = (key, data) => {
    if (!storage) return false;
    const k = keyFor(key);
    const payload = JSON.stringify({ ts: now(), data: slimBars(data) });
    try {
      storage.setItem(k, payload);
      return true;
    } catch {
      // Cuota llena: hacer sitio y reintentar UNA vez. Si tampoco cabe se AVISA
      // en vez de callar — una caché que no guarda condena a redescargar siempre,
      // que es exactamente el bug que esto viene a cerrar.
      if (prune()) {
        try { storage.setItem(k, payload); return true; } catch { /* sigue sin caber */ }
      }
      warn(`[perf] no se pudo cachear ${key}: localStorage lleno — se redescargará en cada carga`);
      return false;
    }
  };

  return { load, save, prune, entries, keyFor };
}
