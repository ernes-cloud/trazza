// E2E smoke del Dashboard y de la regla "una sola definición" entre pantallas.
//
// Lo que protege (y que hoy solo se comprobaba a mano tras cada refactor):
//   1. El Dashboard pinta sus widgets con importes, sin ErrorBoundary ni errores
//      de página.
//   2. El "Invertido" del Dashboard y el "Valor en Mercado" de brokers son la
//      MISMA cifra: salen de computeInvestedMarketValue con los mismos precios.
//      Si alguien vuelve a duplicar la valoración en una pantalla, esto falla.
//   3. Ajustes carga y guarda (la fila compartida de UserPreferencesContext).
//
// No compara cifras absolutas: la demo valora con cotizaciones en vivo.
//
// Requisitos: la app servida en BASE_URL (npm run dev, o vite preview del build)
// y `npx playwright install chromium`. Ejecución: npm run test:e2e:dashboard
//
// Modo demo y navegación client-side: un page.goto() completo perdería la
// sesión demo (vive en memoria).
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { requireValidationServerUrl } from './requireEnv.mjs';

requireValidationServerUrl();

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), 'artifacts');
mkdirSync(SHOTS, { recursive: true });
// Tolerancia entre las dos pantallas: las dos leen la misma caché de quotes
// (1 min), así que en la práctica coinciden al euro; 0,5 % cubre un refresco
// de precio que caiga justo entre una carga y la otra.
const MAX_REL_DIFF = 0.005;

try {
  await fetch(BASE, { signal: AbortSignal.timeout(5000) });
} catch {
  console.error(`La app no responde en ${BASE}. Arranca "npm run dev" (o pasa BASE_URL).`);
  process.exit(2);
}

/** "242.659 €", "€242.659,27" → 242659.27 (formato es-ES). */
export function parseEuro(text) {
  const m = String(text).match(/-?[\d.]+(?:,\d+)?/);
  if (!m) return NaN;
  return Number(m[0].replace(/\./g, '').replace(',', '.'));
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: 'es-ES' });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

const step = async (name, fn) => {
  try {
    const r = await fn();
    console.log('OK   -', name, r !== undefined ? `(${r})` : '');
    return r;
  } catch (e) {
    console.log('FAIL -', name, '::', e.message.split('\n')[0]);
    await page.screenshot({ path: join(SHOTS, `dashboard-fail-${name.replace(/\W+/g, '_')}.png`), fullPage: true }).catch(() => {});
    throw e;
  }
};

const noBoundary = async () => {
  const txt = await page.locator('body').innerText();
  if (/Error en esta sección/.test(txt)) throw new Error('un widget ha caído en su ErrorBoundary');
};

/**
 * Lee un importe hasta que se ESTABILIZA (dos lecturas iguales seguidas): las
 * cotizaciones en vivo pueden tardar y una espera fija haría el test intermitente.
 */
const readStable = async (read, { tries = 30, everyMs = 2000 } = {}) => {
  let prev = NaN;
  for (let i = 0; i < tries; i++) {
    const v = await read();
    if (v > 0 && v === prev) return v;
    prev = v;
    await page.waitForTimeout(everyMs);
  }
  throw new Error(`el importe no se estabilizó (último: ${prev})`);
};
const amountAfter = (txt, labelRe) => {
  const after = txt.split(labelRe)[1];
  return parseEuro(after?.split('\n').find((l) => /€/.test(l)));
};

// Navegación client-side por un enlace del menú (conserva la sesión demo).
const goVia = async (href) => {
  await page.locator(`a[href="${href}"]`).first().click();
  await page.waitForURL(`**${href}`, { timeout: 15000 });
};
const goPush = async (path) => {
  await page.evaluate((p) => { history.pushState({}, '', p); dispatchEvent(new PopStateEvent('popstate')); }, path);
  await page.waitForURL(`**${path}`, { timeout: 15000 });
};

let exitCode = 0;
try {
  await step('entrar en modo demo', async () => {
    await page.goto(`${BASE}/auth`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const cookies = page.getByText('Aceptar todo', { exact: false });
    if (await cookies.count()) await cookies.first().click().catch(() => {});
    await page.getByRole('button', { name: 'Explorar demo' }).click();
    await page.waitForURL('**/app', { timeout: 15000 });
  });

  // El demo puede tener guardado un broker suelto (localStorage): se fuerza la
  // vista de todos para comparar el patrimonio entero con brokers en "general".
  await page.evaluate(() => localStorage.setItem('trazza_selected_broker', 'general'));

  const dashInvested = await step('Dashboard pinta "Invertido"', async () => {
    // Las etiquetas van en mayúsculas por CSS: se lee el texto RENDERIZADO
    // (innerText lo devuelve ya en mayúsculas), no el del DOM.
    // La etiqueta se tradujo ("Portfolio Value" → "Valor total"); en inglés sigue siendo la otra.
    await page.waitForFunction(() => /VALOR TOTAL|PORTFOLIO VALUE/.test(document.body.innerText), null, { timeout: 30000 });
    // El importe es la primera línea con "€" tras la etiqueta de la card.
    const value = await readStable(async () => amountAfter(await page.locator('body').innerText(), /\nINVERTIDO\n/));
    await noBoundary();
    return value;
  });

  const marketValue = await step('brokers pinta "Valor en Mercado"', async () => {
    await goVia('/app/brokers');
    // Margen amplio: sin el Express (dev o vite preview en CI) los calendarios
    // caen al día a día contra Nasdaq y dejan en cola las cotizaciones de esta
    // pantalla; medido, ~25 s hasta pintar. En producción (HTTP/2 + calendario
    // del server) son unos segundos.
    await page.waitForFunction(() => /VALOR EN MERCADO/i.test(document.body.innerText), null, { timeout: 90000 });
    const value = await readStable(async () => amountAfter(await page.locator('body').innerText(), /VALOR EN MERCADO/i));
    await noBoundary();
    return value;
  });

  await step('Dashboard y brokers enseñan la misma cifra', async () => {
    const rel = Math.abs(dashInvested - marketValue) / marketValue;
    if (rel > MAX_REL_DIFF) {
      throw new Error(`Dashboard ${dashInvested} ≠ brokers ${marketValue} (${(rel * 100).toFixed(2)} %)`);
    }
    return `${dashInvested} ≈ ${marketValue}`;
  });

  await step('Ajustes carga y guarda', async () => {
    await goPush('/app/settings');
    const save = page.getByRole('button', { name: /^Guardar/ }).first();
    await save.waitFor({ timeout: 15000 });
    await save.click();
    await page.getByText('Ajustes guardados').first().waitFor({ timeout: 10000 });
  });

  await step('sin errores de página', async () => {
    if (pageErrors.length) throw new Error(pageErrors.join(' | '));
  });
} catch {
  exitCode = 1;
} finally {
  await browser.close();
}
process.exit(exitCode);
