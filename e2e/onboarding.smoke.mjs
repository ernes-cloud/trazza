// Smoke E2E del onboarding: lo que ve una cuenta recién creada.
//
// Entra en modo demo con la persona VACÍA (/auth?demo_persona=empty, solo en
// desarrollo) y comprueba el camino del primer import:
//   - la bienvenida (idioma, divisa con TODAS las de Ajustes, tema, avisos y
//     cómo empezar) aparece y se cierra con "Explorar primero";
//   - el Dashboard enseña UNA guía (la tarjeta de cartera vacía), no dos;
//   - su botón abre directamente el importador en Brokers;
//   - Brokers enseña el estado vacío con sus dos acciones, sin tarjetas a cero;
//   - nada sale en dólares (la divisa por defecto es EUR);
//   - sin errores de página.
//
// Requiere `npm run dev` en marcha (o BASE_URL).
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { requireValidationServerUrl } from './requireEnv.mjs';

requireValidationServerUrl();

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), 'artifacts');
mkdirSync(SHOTS, { recursive: true });

try {
  await fetch(BASE, { signal: AbortSignal.timeout(5000) });
} catch {
  console.error(`La app no responde en ${BASE}. Arranca "npm run dev" (o pasa BASE_URL).`);
  process.exit(2);
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
    await page.screenshot({ path: join(SHOTS, `onboarding-fail-${name.replace(/\W+/g, '_')}.png`), fullPage: true }).catch(() => {});
    throw e;
  }
};

let exitCode = 0;
try {
  await step('entrar con una cuenta vacía', async () => {
    await page.goto(`${BASE}/auth?demo_persona=empty`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.getByRole('button', { name: 'Explorar demo' }).click();
    await page.getByText('Bienvenido a Trazza').waitFor({ timeout: 20000 });
  });

  await step('la bienvenida ofrece todas las divisas y las dos formas de empezar', async () => {
    const options = await page.getByLabel('Otra divisa…').locator('option').count();
    if (options < 20) throw new Error(`solo ${options} divisas en el desplegable`);
    await page.getByRole('button', { name: /Importar mi cartera/ }).waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: /Añadir una posición a mano/ }).waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: 'Explorar primero' }).click();
    await page.getByRole('button', { name: 'Añadir mi cartera' }).waitFor({ timeout: 10000 });
    return `${options} divisas`;
  });

  await step('el Dashboard enseña una sola guía', async () => {
    const checklist = await page.getByText('Primeros pasos').count();
    if (checklist) throw new Error('la lista "Primeros pasos" aparece junto a la tarjeta de cartera vacía');
  });

  await step('el botón abre el importador', async () => {
    await page.getByRole('button', { name: 'Añadir mi cartera' }).click();
    await page.getByText('Importar transacciones').first().waitFor({ timeout: 15000 });
    return new URL(page.url()).pathname;
  });

  await step('Brokers enseña el estado vacío', async () => {
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Importar el extracto de mi broker' }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: 'Añadir una posición a mano' }).waitFor({ timeout: 5000 });
    if (await page.getByText('VALOR EN MERCADO', { exact: false }).count()) {
      throw new Error('siguen las tarjetas de estadísticas a cero');
    }
  });

  await step('nada en dólares', async () => {
    const txt = await page.locator('body').innerText();
    if (/US\$/.test(txt)) throw new Error('la cuenta nueva ve importes en US$');
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
