// E2E smoke del flujo de import (el más delicado de la app) — protege el
// wiring UI → useImportFlow → parsers → preview contra regresiones.
//
// Requisitos:
//   1. dev server en marcha:   npm run dev        (puerto 3000)
//   2. navegador instalado:    npx playwright install chromium
// Ejecución:                    npm run test:e2e   (BASE_URL para otro puerto)
//
// Usa el MODO DEMO (sin credenciales) y navegación client-side: la sesión
// demo vive en memoria — un page.goto() completo la perdería (redirect a /).
// Verifica hasta el preview; el save real (Confirmar) no se ejercita porque
// el cliente mock del demo no implementa .rpc.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { requireValidationServerUrl } from './requireEnv.mjs';

requireValidationServerUrl();

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSV = join(ROOT, 'test-degiro-validation.csv');
const SHOTS = join(ROOT, 'e2e', 'artifacts');

// Preflight: dev server despierto
try {
  await fetch(BASE, { signal: AbortSignal.timeout(5000) });
} catch {
  console.error(`El dev server no responde en ${BASE}. Arranca "npm run dev" primero (o pasa BASE_URL).`);
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
// locale fijado: la app auto-detecta idioma del navegador y los selectores son en ES
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: 'es-ES' });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

const step = async (name, fn) => {
  try {
    await fn();
    console.log('OK  -', name);
  } catch (e) {
    console.log('FAIL -', name, '::', e.message.split('\n')[0]);
    await page.screenshot({ path: join(SHOTS, `fail-${name.replace(/\W+/g, '_')}.png`), fullPage: true }).catch(() => {});
    throw e;
  }
};

try {
  await step('cargar /auth', async () => {
    await page.goto(`${BASE}/auth`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    const cookies = page.getByText('Aceptar todo', { exact: false });
    if (await cookies.count()) await cookies.first().click();
  });

  await step('entrar en modo demo', async () => {
    await page.getByText('Explorar demo', { exact: false }).first().click();
    await page.waitForURL('**/app**', { timeout: 30000 });
    await page.waitForTimeout(2500);
  });

  await step('ir a Brokers por el sidebar (client-side)', async () => {
    await page.getByRole('link', { name: 'Brokers' }).first().click({ timeout: 8000 });
    await page.waitForURL('**/app/brokers**', { timeout: 10000 });
    await page.waitForTimeout(2500);
  });

  await step('seleccionar un broker específico', async () => {
    // `shrink-0` y no `flex-shrink-0`: el migrador de Tailwind 4 renombró la clase.
    const tab = page.locator('.group.shrink-0 button').first();
    // Espera a que aparezca en vez de mirar una sola vez tras 2,5 s: en el CI
    // (vite preview, sin Express) la pantalla tarda más y el conteo daba 0.
    // Si no aparece nunca, sigue fallando.
    await tab.waitFor({ state: 'visible', timeout: 60000 })
      .catch(() => { throw new Error('el modo demo no expone tabs de broker'); });
    await tab.click();
    await page.waitForTimeout(1500);
  });

  await step('abrir diálogo de import', async () => {
    // "Importar" en broker nuevo, "Sincronizar" si ya tiene datos guardados
    await page.getByRole('button', { name: /Importar|Sincronizar/ }).first().click({ timeout: 5000 });
    await page.waitForTimeout(800);
  });

  await step('elegir método CSV/XLSX y broker DEGIRO', async () => {
    await page.getByText('Importar por CSV/XLSX', { exact: false }).first().click({ timeout: 5000 });
    await page.waitForTimeout(600);
    await page.getByText('DEGIRO', { exact: true }).first().click({ timeout: 5000 });
    await page.waitForTimeout(600);
  });

  await step('subir el CSV y llegar al preview', async () => {
    await page.locator('input[type="file"]').first().setInputFiles(CSV, { timeout: 5000 });
    await page.waitForTimeout(4000);
    const summary = await page.getByText(/transacciones encontradas/i).count();
    if (summary === 0) throw new Error('el preview no muestra el resumen de transacciones');
    await page.screenshot({ path: join(SHOTS, 'preview-ok.png'), fullPage: true }).catch(() => {});
  });

  // El cliente MOCK del modo demo no implementa toda la API de supabase-js
  // (.rpc, .gt, …) — esos huecos son limitaciones conocidas del demo, no
  // regresiones del flujo de import: se reportan como warning, no como fallo.
  const isKnownMockGap = (e) => /supabase.*is not a function|\.rpc is not a function/i.test(e);
  const pageErrors = errors.filter(e => e.startsWith('PAGEERROR'));
  const real = pageErrors.filter(e => !isKnownMockGap(e));
  const mockGaps = pageErrors.filter(isKnownMockGap);
  if (mockGaps.length > 0) {
    console.warn(`\n(warning) ${mockGaps.length} huecos conocidos del mock demo ignorados:`);
    console.warn([...new Set(mockGaps)].slice(0, 3).join('\n'));
  }
  if (real.length > 0) {
    console.error('\nErrores de página no controlados durante el flujo:');
    console.error(real.slice(0, 5).join('\n'));
    process.exit(1);
  }

  console.log('\nE2E import smoke: PASS');
} finally {
  await browser.close();
}
