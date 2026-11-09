/**
 * T4 (OSS): la versión self-hosted no cobra ni limita por plan — no debe
 * quedar copy ni código de COBRO visible para el self-hoster.
 *
 * Esta prueba YA NO escanea src/ + server/ enteros como antes. Ese barrido
 * amplio producía ruido sin fin con patrones sueltos como /\bpremium\b/i o
 * /suscripci[oó]n/i: "premium" es un adjetivo cualquiera (admin.plan_premium,
 * "{{n}} usuarios premium") y "suscripciones" es una categoría LEGÍTIMA de la
 * feature de Gastos (Netflix, alquiler, nómina — ver es.app.json
 * `form_recurring_hint`/`cat_subscriptions`). El análisis se restringe a dos
 * superficies, las que de verdad ve un self-hoster:
 *
 *   1) UI — src/components/**, src/pages/** (.jsx/.js) y src/App.jsx: el
 *      código que renderiza algo. Falla si no se encuentra ni un fichero.
 *   2) i18n — src/i18n/locales/*.app.json y *.public.json: el copy que esa UI
 *      muestra. Se descubren con `readdir` (nunca una lista a mano); falla si
 *      no aparece ninguno.
 *
 * Los patrones son ESTRICTOS de CONTEXTO DE COBRO, no palabras sueltas:
 *   · plan premium / premium plan / hazte premium / go premium / nivel premium
 *   · upgrade (de plan)
 *   · pricing / precio del plan        (NO "precios" en plural: en este
 *     dataset esa palabra es casi siempre precio de MERCADO — ver
 *     `refresh_prices`, `prices_updated_title`, `prices_update_error_desc`,
 *     "Precios de mercado…" en s4_p1 — el mismo problema que "premium" suelto)
 *   · Stripe
 *   · suscríbete / subscribe           (con guardia para no cazar el patrón
 *     pub/sub de `src/components/ui/use-toast.js`: `subscribe: (listener) =>`
 *     y `.subscribe((state) =>` NO son copy de cobro, son un event emitter)
 *   · suscripción al plan / subscription plan
 *   · checkout
 *   · PLAN_LIMITS · useUserPlan · isPremium
 *
 * Deliberadamente SIN /suscripci[oó]n/i ni /\bpremium\b/i sueltos (ver arriba).
 *
 * ALLOWLIST por CLAVE EXACTA i18n ({clave: 'motivo'}): para cuando una clave
 * cuadra con un patrón de arriba sin ser cobro. Los dos casos de manual que la
 * justificarían — una SUSCRIPCIÓN a participaciones de un FONDO (comprar,
 * no pagar un plan; p. ej. en una guía de MyInvestor) o un gasto de ejemplo
 * "YouTube Premium" dentro de la categoría Gastos → Suscripciones (el nombre
 * de un servicio de terceros, no el plan de pago de Trazza — ver
 * `cat_subscriptions`/`form_recurring_hint`, aunque hoy no mencionan ningún
 * servicio por nombre) — NO existen hoy en el dataset, así que la allowlist
 * está vacía. El mecanismo queda listo (y un test aparte comprueba que cada
 * clave de la allowlist SIGUE existiendo en algún locale; si no, es basura).
 *
 * Exclusiones de fichero: solo para código NO-UI (parsers de broker en
 * src/lib/parsers/, prompts de importación IA en server/prompts/, reglas de
 * categorización de Gastos). Como el escaneo YA está limitado a
 * components/pages/App.jsx, ninguno vive ahí hoy — `NON_UI_EXCLUDED_FILES`
 * queda vacío pero documentado por si algún día entra uno.
 *
 * Fallos listados como fichero:línea (UI) o locale:clave (i18n).
 *
 * ── Coincidencias esperadas HOY (rojo; foto tomada al escribir este test) ──
 *   UI:
 *     src/components/ProtectedRoute.jsx:5  y :12  — useUserPlan
 *     src/components/DashboardLayout.jsx:26 y :66 — useUserPlan
 *     src/pages/AdminDashboard.jsx:6 y :20         — useUserPlan
 *     src/pages/LandingPage.jsx:622                — comentario "Pricing"
 *   i18n:
 *     es.app.json    admin.adoption_premium       → "Con plan Premium"
 *     en.app.json    admin.adoption_premium       → "With Premium plan"
 *     en.app.json    freeform_import.upgrade_cta  → "Upgrade plan"
 *       (OJO: la misma clave en es.app.json dice "Mejorar plan" y NO hace
 *       match — no hay patrón español para "upgrade"; asimetría conocida,
 *       no se inventa un patrón nuevo sin que lo pida el contrato de arriba)
 *     en.public.json landing.pricing_title         → "Simple and honest pricing"
 *     en.public.json landing.eyebrow_pricing       → "Pricing"
 *   ALLOWLIST: ninguna entrada hoy (ver nota arriba).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

// ── Patrones de COBRO (contexto, no palabras sueltas) ───────────────────────
const BILLING_PATTERNS = [
  { re: /\bstripe\b/i, label: 'Stripe' },
  { re: /\bcheckout\b/i, label: 'checkout' },
  // Guardia (?!\s*[:(]) para no cazar el pub/sub de use-toast.js:
  // `subscribe: (listener) => {` / `toastStore.subscribe((state) => {` no son
  // copy de cobro, son nombres de método de un event emitter.
  { re: /\b(subscribe|suscr[ií]bete)\b(?!\s*[:(])/i, label: 'suscríbete / subscribe' },
  { re: /(suscripci[oó]n al plan|subscription plan)/i, label: 'suscripción al plan / subscription plan' },
  { re: /(plan premium|premium plan|hazte premium|go premium|nivel premium)/i, label: 'plan premium / premium plan / hazte premium / go premium / nivel premium' },
  { re: /\bupgrade\b/i, label: 'upgrade (a plan)' },
  // "pricing" (no "precios" en plural — ver cabecera) o la frase exacta.
  { re: /(\bpricing\b|precio del plan)/i, label: 'pricing / precio del plan' },
  // Equivalente en castellano de upgrade_cta ("Mejorar plan") y "premium" como nivel.
  { re: /\bmejora(r)?\s+(tu\s+|el\s+|de\s+)?plan\b/i, label: 'mejorar plan' },
  { re: /\b(free|premium)\s*(tier|plan|vs)\b|\b(plan|nivel|usuarios?)\s+premium\b/i, label: 'premium como nivel' },
  { re: /\bPLAN_LIMITS\b/, label: 'PLAN_LIMITS' },
  { re: /\buseUserPlan\b/, label: 'useUserPlan' },
  { re: /\bisPremium\b/, label: 'isPremium' },
];

function scanLines(relPath, content) {
  const hits = [];
  content.split(/\r?\n/).forEach((line, idx) => {
    for (const { re, label } of BILLING_PATTERNS) {
      if (re.test(line)) hits.push({ file: relPath, line: idx + 1, label, text: line.trim().slice(0, 160) });
    }
  });
  return hits;
}

// ── 1) UI: src/components/**, src/pages/**, src/App.jsx ───────────────────
const UI_DIRS = ['src/components', 'src/pages'].map((d) => path.join(ROOT, d));
const UI_EXTRA_FILES = [path.join(ROOT, 'src/App.jsx')];
const UI_EXT_RE = /\.(jsx|js)$/;
const UI_TEST_RE = /\.test\.(jsx|js)$/;
const SKIP_DIRS = new Set(['node_modules', '.git']);

// Exclusiones SOLO para ficheros no-UI (parsers/prompts/reglas de Gastos) que
// pudieran colarse dentro de components/pages. Hoy vacío: ninguno vive ahí.
const NON_UI_EXCLUDED_FILES = new Set([
  // path.join(ROOT, 'src/components/.../algo.js'), // motivo documentado aquí
]);

function listUiFiles() {
  const out = [];
  const rec = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { rec(abs); continue; }
      if (!UI_EXT_RE.test(e.name) || UI_TEST_RE.test(e.name)) continue;
      if (NON_UI_EXCLUDED_FILES.has(abs)) continue;
      out.push(abs);
    }
  };
  for (const d of UI_DIRS) if (fs.existsSync(d)) rec(d);
  for (const f of UI_EXTRA_FILES) if (fs.existsSync(f) && !NON_UI_EXCLUDED_FILES.has(f)) out.push(f);
  return out;
}

describe('sin copy/código de cobro en la UI (src/components/**, src/pages/**, src/App.jsx)', () => {
  const files = listUiFiles();

  it('hay ficheros UI que escanear', () => {
    expect(
      files.length,
      'no se encontró ningún .jsx/.js bajo src/components, src/pages o src/App.jsx',
    ).toBeGreaterThan(0);
  });

  it('ningún fichero UI menciona Stripe/checkout/suscríbete/suscripción al plan/plan premium/upgrade/pricing/PLAN_LIMITS/useUserPlan/isPremium', () => {
    const hits = files.flatMap((f) => scanLines(path.relative(ROOT, f), fs.readFileSync(f, 'utf8')));
    const msg = hits.map((h) => `${h.file}:${h.line} (${h.label}) — ${h.text}`).join('\n');
    expect(hits.length, `referencias de cobro en la UI:\n${msg}`).toBe(0);
  });
});

// ── 2) i18n: src/i18n/locales/*.app.json y *.public.json ──────────────────
const LOCALES_DIR = path.join(ROOT, 'src/i18n/locales');
const LOCALE_FILE_RE = /\.(app|public)\.json$/;

function listLocaleFiles() {
  let entries;
  try {
    entries = fs.readdirSync(LOCALES_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && LOCALE_FILE_RE.test(e.name))
    .map((e) => e.name)
    .sort();
}

// Aplana { a: { b: { c: 'v' } } } → [['a.b.c', 'v'], ...] (claves en notación
// de puntos, como pide el enunciado).
function flattenEntries(obj, prefix = '') {
  let out = [];
  for (const k of Object.keys(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    const v = obj[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) out = out.concat(flattenEntries(v, full));
    else out.push([full, v]);
  }
  return out;
}

// ALLOWLIST por clave exacta: {clave: 'motivo'} — un comentario por entrada.
// Vacía hoy (ver cabecera del fichero); el mecanismo queda listo para los dos
// casos de manual (suscripción de fondo, gasto de ejemplo "X Premium").
const BILLING_ALLOWLIST = Object.freeze({
  // 'expenses.example_youtube_premium': 'ejemplo de gasto en Gastos → Suscripciones (nombre de un servicio de terceros, YouTube Premium), no el plan de pago de Trazza',
  // 'imports.myinvestor_fund_subscription_note': 'suscripción de PARTICIPACIONES de un fondo (comprar), no una suscripción de pago a Trazza',
});

describe('existe al menos un *.app.json / *.public.json bajo src/i18n/locales', () => {
  it('hay locales que escanear', () => {
    expect(
      listLocaleFiles().length,
      `no se encontró ningún *.app.json/*.public.json en ${LOCALES_DIR}`,
    ).toBeGreaterThan(0);
  });
});

describe('sin copy de cobro en i18n (src/i18n/locales/*.app.json y *.public.json), salvo allowlist', () => {
  const localeFiles = listLocaleFiles();

  for (const name of localeFiles) {
    it(`${name} no contiene copy de cobro fuera de la allowlist`, () => {
      const raw = fs.readFileSync(path.join(LOCALES_DIR, name), 'utf8');
      const data = JSON.parse(raw);
      const entries = flattenEntries(data);
      const hits = [];
      for (const [key, value] of entries) {
        if (typeof value !== 'string') continue;
        if (Object.prototype.hasOwnProperty.call(BILLING_ALLOWLIST, key)) continue;
        for (const { re, label } of BILLING_PATTERNS) {
          if (re.test(value)) hits.push(`${name}:${key} (${label}): "${value}"`);
        }
      }
      expect(hits, hits.join('\n')).toEqual([]);
    });
  }
});

describe('allowlist de cobro i18n — cada clave listada sigue existiendo', () => {
  it('toda clave de BILLING_ALLOWLIST existe en al menos un locale descubierto', () => {
    const localeFiles = listLocaleFiles();
    const allKeys = new Set();
    for (const name of localeFiles) {
      const data = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, name), 'utf8'));
      for (const [key] of flattenEntries(data)) allKeys.add(key);
    }
    const stale = Object.keys(BILLING_ALLOWLIST).filter((k) => !allKeys.has(k));
    expect(stale, `claves de la allowlist que ya no existen en ningún locale: ${stale.join(', ')}`).toEqual([]);
  });
});

// ── Chequeos puntuales fuera del escaneo UI/i18n ───────────────────────────
// Dos asserts muy concretos, NO un barrido amplio de server/: apuntan a los
// dos objetivos de borrado ya nombrados explícitamente en la cabecera de este
// fichero y en CLAUDE.md. Se mantienen aparte del escaneo UI/i18n de arriba.
describe('chequeos puntuales (no son un escaneo de server/)', () => {
  it('server/routes/rateLimiter.js no exporta PLAN_LIMITS por plan (free/premium)', () => {
    const p = path.join(ROOT, 'server/routes/rateLimiter.js');
    const src = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    expect(src.includes('PLAN_LIMITS'), 'rateLimiter.js sigue exportando PLAN_LIMITS').toBe(false);
  });

  it('src/hooks/useUserPlan.js no existe (o no distingue free/premium)', () => {
    const p = path.join(ROOT, 'src/hooks/useUserPlan.js');
    expect(fs.existsSync(p), 'src/hooks/useUserPlan.js sigue existiendo').toBe(false);
  });
});

// ── Paridad i18n es/en por módulo (app y public) — debe ir en VERDE hoy ───
describe('paridad i18n es/en por módulo (app y public) — debe estar en VERDE: ya es una invariante mantenida hoy', () => {
  function flattenKeys(obj, prefix = '') {
    return flattenEntries(obj, prefix).map(([k]) => k);
  }

  const PAIRS = [
    ['es.app.json', 'en.app.json'],
    ['es.public.json', 'en.public.json'],
  ];

  for (const [esName, enName] of PAIRS) {
    it(`${esName} y ${enName} existen y tienen EXACTAMENTE el mismo conjunto de claves`, () => {
      const esPath = path.join(LOCALES_DIR, esName);
      const enPath = path.join(LOCALES_DIR, enName);
      expect(fs.existsSync(esPath), `falta ${esName}`).toBe(true);
      expect(fs.existsSync(enPath), `falta ${enName}`).toBe(true);
      const es = JSON.parse(fs.readFileSync(esPath, 'utf8'));
      const en = JSON.parse(fs.readFileSync(enPath, 'utf8'));
      const esKeys = new Set(flattenKeys(es));
      const enKeys = new Set(flattenKeys(en));
      const onlyEs = [...esKeys].filter((k) => !enKeys.has(k));
      const onlyEn = [...enKeys].filter((k) => !esKeys.has(k));
      expect(onlyEs, `claves solo en ${esName}: ${onlyEs.join(', ')}`).toEqual([]);
      expect(onlyEn, `claves solo en ${enName}: ${onlyEn.join(', ')}`).toEqual([]);
    });
  }
});
