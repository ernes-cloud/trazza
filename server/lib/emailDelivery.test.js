import { describe, it, expect } from 'vitest';
import {
  classifyEmailError,
  nextBackoffMs,
  summarizeEmailError,
  MAX_ATTEMPTS,
} from './emailDelivery.js';

describe('classifyEmailError', () => {
  it('reintenta los fallos de red: la conexión ni llegó a completarse', () => {
    for (const code of ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNRESET', 'EDNS']) {
      const out = classifyEmailError({ code });
      expect(out.retryable, code).toBe(true);
      expect(out.reason).toBe(`network:${code}`);
    }
  });

  it('NO reintenta un fallo de autenticación: la API key es la misma las 3 veces', () => {
    expect(classifyEmailError({ code: 'EAUTH' })).toEqual({
      retryable: false,
      reason: 'permanent:EAUTH',
    });
  });

  it('reintenta un 4xx de SMTP — el protocolo dice literalmente "inténtalo luego"', () => {
    // 421 es el rate-limit típico de un proveedor; 450 el buzón ocupado.
    expect(classifyEmailError({ responseCode: 421 }).retryable).toBe(true);
    expect(classifyEmailError({ responseCode: 450 }).retryable).toBe(true);
    expect(classifyEmailError({ responseCode: 452 }).reason).toBe('smtp:452');
  });

  it('NO reintenta un 5xx: el buzón no existe o el mensaje está rechazado', () => {
    expect(classifyEmailError({ responseCode: 550 }).retryable).toBe(false);
    expect(classifyEmailError({ responseCode: 553 }).reason).toBe('smtp:553');
  });

  it('el código de red MANDA sobre el numérico', () => {
    // nodemailer adjunta a veces los dos; un ECONNRESET a mitad de sesión
    // puede arrastrar el último responseCode visto, que no describe el fallo.
    const out = classifyEmailError({ code: 'ECONNRESET', responseCode: 550 });
    expect(out.retryable).toBe(true);
  });

  it('ante un error SIN información, reintenta', () => {
    // Asimetría deliberada: reintentar de más cuesta dos intentos; reintentar
    // de menos cuesta la notificación entera, que es el bug que esto arregla.
    expect(classifyEmailError(new Error('boom')).retryable).toBe(true);
    expect(classifyEmailError(undefined).retryable).toBe(true);
    expect(classifyEmailError(null).reason).toBe('unknown');
  });

  it('ignora un responseCode que no es un número', () => {
    expect(classifyEmailError({ responseCode: 'nope' }).reason).toBe('unknown');
  });
});

describe('nextBackoffMs', () => {
  it('crece exponencialmente', () => {
    const mid = () => 0.5; // jitter 0
    expect(nextBackoffMs(1, mid)).toBe(500);
    expect(nextBackoffMs(2, mid)).toBe(1000);
    expect(nextBackoffMs(3, mid)).toBe(2000);
  });

  it('el jitter se queda dentro de ±25%', () => {
    expect(nextBackoffMs(2, () => 0)).toBe(750);   // -25%
    expect(nextBackoffMs(2, () => 1)).toBe(1250);  // +25%
  });

  it('nunca devuelve un valor negativo', () => {
    expect(nextBackoffMs(0, () => 0)).toBeGreaterThanOrEqual(0);
    expect(nextBackoffMs(-5, () => 0)).toBeGreaterThanOrEqual(0);
  });

  it('el backoff total de los reintentos no bloquea el webhook más de ~2s', () => {
    // emailNotify responde a un webhook de Supabase: si la espera se dispara,
    // el webhook expira y el resultado es peor que no reintentar.
    let total = 0;
    for (let i = 1; i < MAX_ATTEMPTS; i++) total += nextBackoffMs(i, () => 1);
    expect(total).toBeLessThan(2000);
  });
});

describe('summarizeEmailError', () => {
  it('junta código, responseCode y mensaje en una línea', () => {
    const out = summarizeEmailError({ code: 'EAUTH', responseCode: 535, message: 'bad login' });
    expect(out).toBe('EAUTH 535 bad login');
  });

  it('colapsa saltos de línea y recorta', () => {
    const out = summarizeEmailError({ message: 'a\n\n  b' }, 500);
    expect(out).toBe('a b');
    expect(summarizeEmailError({ message: 'x'.repeat(900) }).length).toBe(500);
  });

  it('aguanta un error que no es un Error', () => {
    expect(summarizeEmailError('plain string')).toBe('plain string');
    expect(summarizeEmailError(null)).toBe('unknown error');
  });
});
