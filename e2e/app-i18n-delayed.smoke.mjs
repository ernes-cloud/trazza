// Smoke E2E C2: el chunk i18n de la app (es.app) llega tarde.
//
// Entra en /auth → «Explorar demo» → /app con el chunk retrasado 3 s y comprueba
// que la barra / banner no se quedan con claves crudas (nav.*, demo_mode.*).
//
// Pensado para build + `vite preview` (BASE_URL). También vale con `npm run dev`.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { requireValidationServerUrl } from './requireEnv.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const DELAY_MS = Number(process.env.I18N_CHUNK_DELAY_MS || 3000);
requireValidationServerUrl();
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), 'artifacts');
mkdirSync(SHOTS, { recursive: true });

try {
  await fetch(BASE, { signal: AbortSignal.timeout(5000) });
} catch {
  console.error(`La app no responde en ${BASE}. Arranca preview/dev (o pasa BASE_URL).`);
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: 'es-ES' });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

/** Peticiones del chunk de traducciones de la app (es.app). */
const isAppI18nChunk = (url) =>
  /es\.app/i.test(url) || /locales\/es\.app/i.test(url);

await page.route('**/*', async (route) => {
  const url = route.request().url();
  if (isAppI18nChunk(url)) {
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }
  await route.continue();
});

const RAW_KEY_RE = /\b(?:nav|demo_mode)\.[a-z][a-z0-9_]*\b/g;

const step = async (name, fn) => {
  try {
    const r = await fn();
    console.log('OK   -', name, r !== undefined ? `(${r})` : '');
    return r;
  } catch (e) {
    console.log('FAIL -', name, '::', e.message.split('\n')[0]);
    await page.screenshot({
      path: join(SHOTS, `app-i18n-fail-${name.replace(/\W+/g, '_')}.png`),
      fullPage: true,
    }).catch(() => {});
    throw e;
  }
};

let exitCode = 0;
try {
  await step('entrar en /auth con chunk es.app retrasado', async () => {
    await page.goto(`${BASE}/auth`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.getByRole('button', { name: 'Explorar demo' }).waitFor({ timeout: 20000 });
  });

  await step('Explorar demo → /app', async () => {
    await page.getByRole('button', { name: 'Explorar demo' }).click();
    await page.waitForURL(/\/app/, { timeout: 30000 });
  });

  await step('tras el delay no quedan claves crudas nav.*/demo_mode.*', async () => {
    // El gate debe esperar al chunk; damos margen extra sobre los 3 s.
    await page.waitForTimeout(DELAY_MS + 2500);
    const txt = await page.locator('body').innerText();
    const raw = [...txt.matchAll(RAW_KEY_RE)].map((m) => m[0]);
    const unique = [...new Set(raw)];
    if (unique.length) {
      throw new Error(`claves crudas visibles: ${unique.join(', ')}`);
    }
    // Señales positivas de que la nav se tradujo.
    await page.getByText('Dashboard', { exact: true }).first().waitFor({ timeout: 5000 }).catch(() => {});
    return '0 raw keys';
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
