/**
 * T8 (OSS): la versión self-hosted no debe limitar la IA por "plan de pago" —
 * las cuotas tienen que salir de variables de entorno que el self-hoster
 * controla, con un único rol privilegiado (admin, sin límite) resuelto sin
 * tabla de planes.
 *
 * FREE_LIMITS_ACTUALES: los límites del plan "free" TAL CUAL existen HOY en
 * el código (origen: server/routes/rateLimiter.js, const PLAN_LIMITS.free —
 * duplicados en src/hooks/useAiUsage.js). Se copian aquí como referencia para
 * comprobar que el nuevo default (sin plan de pago) es MÁS GENEROSO, sin fijar
 * la cifra nueva (la decide quien implemente server/lib/aiQuota.js):
 *
 *   PLAN_LIMITS.free = {
 *     chat:     { daily: 10, monthly: 50 },
 *     analysis: { daily: 3,  monthly: 10 },
 *     import:   { daily: 5,  monthly: 20 },
 *   }
 *
 * Contrato exigido de server/lib/aiQuota.js:
 *   export function getAiLimits(env, user) → {
 *     enabled: boolean,                      // false si !env.GROQ_API_KEY
 *     chat:     { daily: number, monthly: number },
 *     analysis: { daily: number, monthly: number },
 *     import:   { daily: number, monthly: number },
 *   }
 *   - Sin GROQ_API_KEY: enabled=false (la IA está apagada; los límites no importan).
 *   - admin (ver resolución abajo): daily/monthly = Infinity (o null) en TODAS las features.
 *   - Resolución de admin: si env.ADMIN_EMAILS (CSV) está definida, admin ⇔
 *     user.email está en esa lista (case-insensitive); si NO está definida,
 *     admin ⇔ user.isFirstUser === true (el primer usuario registrado).
 *   - Usuario normal sin overrides de entorno: un default por encima de
 *     FREE_LIMITS_ACTUALES (no se fija la cifra).
 *   - env.AI_DAILY_LIMIT_USER: default genérico para cualquier feature sin
 *     override propio.
 *   - env.AI_DAILY_LIMIT_<FEATURE> (CHAT/ANALYSIS/IMPORT): override específico,
 *     gana sobre AI_DAILY_LIMIT_USER.
 *   - Cero referencias a "free"/"premium"/plan de pago dentro del módulo.
 *
 * Relación con el contrato de `server/oss/degraded.test.js` (validar primero,
 * comprobar la configuración de IA después): ESTE módulo es una función pura
 * — `getAiLimits(env, user)` no recibe un `req` ni valida un body HTTP, así
 * que el orden "400 antes que 503" no aplica aquí directamente. Quien SÍ debe
 * respetarlo es la ruta/middleware que llame a `getAiLimits`: tiene que
 * validar el body de la petición (400 si está mal formado) ANTES de usar
 * `enabled`/los límites de esta función para decidir el 503 `ai_not_configured`
 * o el 429 de cuota agotada. `enabled: false` sin GROQ_API_KEY es, en sí
 * mismo, la señal de la que sale ese 503 — ver degraded.test.js para el
 * contrato HTTP completo con los pares inválido→400 / válido→503.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const AI_QUOTA_PATH = path.join(ROOT, 'server/lib/aiQuota.js');

// Origen: server/routes/rateLimiter.js, const PLAN_LIMITS.free (leído el día
// de este test). NO cambiar sin releer el fichero fuente.
const FREE_LIMITS_ACTUALES = Object.freeze({
  chat:     Object.freeze({ daily: 10, monthly: 50 }),
  analysis: Object.freeze({ daily: 3,  monthly: 10 }),
  import:   Object.freeze({ daily: 5,  monthly: 20 }),
});

const FEATURES = Object.keys(FREE_LIMITS_ACTUALES);

async function loadAiQuota() {
  if (!fs.existsSync(AI_QUOTA_PATH)) return null;
  try {
    return await import(AI_QUOTA_PATH);
  } catch {
    return null;
  }
}

describe('server/lib/aiQuota.js — existe y exporta getAiLimits(env, user)', () => {
  it('existe el módulo', () => {
    expect(fs.existsSync(AI_QUOTA_PATH), 'falta server/lib/aiQuota.js').toBe(true);
  });

  it('exporta getAiLimits como función', async () => {
    const mod = await loadAiQuota();
    expect(mod && typeof mod.getAiLimits, 'falta export getAiLimits(env, user) en server/lib/aiQuota.js').toBe('function');
  });
});

describe('server/lib/aiQuota.js — cero referencias a planes de pago (estático)', () => {
  it('el módulo no menciona free/premium/plan de pago/stripe', () => {
    if (!fs.existsSync(AI_QUOTA_PATH)) {
      expect(false, 'falta server/lib/aiQuota.js').toBe(true);
      return;
    }
    const src = fs.readFileSync(AI_QUOTA_PATH, 'utf8');
    for (const re of [/\bfree\b/i, /\bpremium\b/i, /\bstripe\b/i, /plan de pago/i, /\bPLAN_LIMITS\b/]) {
      expect(re.test(src), `aiQuota.js menciona algo que casa con ${re}`).toBe(false);
    }
  });
});

describe('getAiLimits — IA desactivada sin GROQ_API_KEY', () => {
  it('enabled: false cuando no hay GROQ_API_KEY, sea quien sea el usuario', async () => {
    const mod = await loadAiQuota();
    if (!mod?.getAiLimits) { expect(false, 'falta getAiLimits').toBe(true); return; }
    const out = mod.getAiLimits({}, { email: 'user@example.com' });
    expect(out.enabled).toBe(false);
  });
});

describe('getAiLimits — usuario normal sin overrides: default MAYOR que FREE_LIMITS_ACTUALES', () => {
  it('cada feature tiene un daily limit numérico y finito, estrictamente mayor que el free actual', async () => {
    const mod = await loadAiQuota();
    if (!mod?.getAiLimits) { expect(false, 'falta getAiLimits').toBe(true); return; }
    const env = { GROQ_API_KEY: 'gsk_fixture' };
    const user = { email: 'nobody@example.com', isFirstUser: false };
    const out = mod.getAiLimits(env, user);
    expect(out.enabled).toBe(true);
    for (const feature of FEATURES) {
      const got = out[feature];
      expect(got, `falta out.${feature}`).toBeTruthy();
      expect(Number.isFinite(got.daily), `${feature}.daily no es un número finito (usuario normal, no debería ser ilimitado)`).toBe(true);
      expect(
        got.daily,
        `${feature}.daily (${got.daily}) debe ser MAYOR que el límite free actual (${FREE_LIMITS_ACTUALES[feature].daily}) — la versión OSS no limita por plan de pago`,
      ).toBeGreaterThan(FREE_LIMITS_ACTUALES[feature].daily);
    }
  });
});

describe('getAiLimits — overrides por entorno', () => {
  it('AI_DAILY_LIMIT_USER fija el default genérico para una feature sin override propio', async () => {
    const mod = await loadAiQuota();
    if (!mod?.getAiLimits) { expect(false, 'falta getAiLimits').toBe(true); return; }
    const env = { GROQ_API_KEY: 'gsk_fixture', AI_DAILY_LIMIT_USER: '77' };
    const out = mod.getAiLimits(env, { email: 'nobody@example.com', isFirstUser: false });
    for (const feature of FEATURES) {
      expect(out[feature].daily).toBe(77);
    }
  });

  it('AI_DAILY_LIMIT_<FEATURE> (p. ej. AI_DAILY_LIMIT_CHAT) gana sobre AI_DAILY_LIMIT_USER', async () => {
    const mod = await loadAiQuota();
    if (!mod?.getAiLimits) { expect(false, 'falta getAiLimits').toBe(true); return; }
    const env = {
      GROQ_API_KEY: 'gsk_fixture',
      AI_DAILY_LIMIT_USER: '77',
      AI_DAILY_LIMIT_CHAT: '123',
    };
    const out = mod.getAiLimits(env, { email: 'nobody@example.com', isFirstUser: false });
    expect(out.chat.daily).toBe(123);
    expect(out.analysis.daily).toBe(77);
    expect(out.import.daily).toBe(77);
  });
});

describe('getAiLimits — admin sin límite', () => {
  it('ADMIN_EMAILS definida + email del usuario en la lista → Infinity/null en todas las features', async () => {
    const mod = await loadAiQuota();
    if (!mod?.getAiLimits) { expect(false, 'falta getAiLimits').toBe(true); return; }
    const env = { GROQ_API_KEY: 'gsk_fixture', ADMIN_EMAILS: 'root@example.com, admin@example.com' };
    const out = mod.getAiLimits(env, { email: 'Admin@Example.com', isFirstUser: false });
    for (const feature of FEATURES) {
      const isUnlimited = (v) => v === null || v === Infinity;
      expect(isUnlimited(out[feature].daily), `${feature}.daily no es ilimitado para un admin`).toBe(true);
      expect(isUnlimited(out[feature].monthly), `${feature}.monthly no es ilimitado para un admin`).toBe(true);
    }
  });

  it('ADMIN_EMAILS definida + email del usuario FUERA de la lista → límites normales (no admin)', async () => {
    const mod = await loadAiQuota();
    if (!mod?.getAiLimits) { expect(false, 'falta getAiLimits').toBe(true); return; }
    const env = { GROQ_API_KEY: 'gsk_fixture', ADMIN_EMAILS: 'root@example.com' };
    const out = mod.getAiLimits(env, { email: 'nobody@example.com', isFirstUser: false });
    expect(Number.isFinite(out.chat.daily)).toBe(true);
  });

  it('sin ADMIN_EMAILS: el primer usuario registrado (user.isFirstUser) es admin sin límite', async () => {
    const mod = await loadAiQuota();
    if (!mod?.getAiLimits) { expect(false, 'falta getAiLimits').toBe(true); return; }
    const env = { GROQ_API_KEY: 'gsk_fixture' };
    const out = mod.getAiLimits(env, { email: 'owner@example.com', isFirstUser: true });
    const isUnlimited = (v) => v === null || v === Infinity;
    for (const feature of FEATURES) {
      expect(isUnlimited(out[feature].daily), `${feature}.daily no es ilimitado para isFirstUser`).toBe(true);
    }
  });

  it('sin ADMIN_EMAILS y sin isFirstUser: usuario normal con límites finitos', async () => {
    const mod = await loadAiQuota();
    if (!mod?.getAiLimits) { expect(false, 'falta getAiLimits').toBe(true); return; }
    const env = { GROQ_API_KEY: 'gsk_fixture' };
    const out = mod.getAiLimits(env, { email: 'someone@example.com', isFirstUser: false });
    expect(Number.isFinite(out.chat.daily)).toBe(true);
  });
});
