import { describe, it, expect } from 'vitest';
import { aiHttpErrorMessage } from './aiHttpErrorMessage.js';

const MESSAGES = {
  'cartera.ai_unavailable': 'El servicio de IA no está disponible.',
  'cartera.ai_overloaded': 'El servicio de IA está saturado — espera unos segundos y vuelve a intentarlo.',
  'cartera.ai_region_blocked': 'El proveedor de IA está rechazando las peticiones desde esta red (403). No es tu texto ni tu clave: reintentar no ayuda. Prueba desde otra conexión o revisa si tienes una VPN activa.',
};
const t = (key) => MESSAGES[key] || key;

describe('aiHttpErrorMessage', () => {
  it('mapea cada code a su clave i18n (no colapsa todos los 503)', () => {
    expect(aiHttpErrorMessage({ status: 503, code: 'AI_OVERLOADED', t }))
      .toBe(MESSAGES['cartera.ai_overloaded']);
    expect(aiHttpErrorMessage({ status: 503, code: 'AI_REGION_BLOCKED', t }))
      .toBe(MESSAGES['cartera.ai_region_blocked']);
    expect(aiHttpErrorMessage({ status: 503, code: 'AI_UNAVAILABLE', t }))
      .toBe(MESSAGES['cartera.ai_unavailable']);
    expect(MESSAGES['cartera.ai_overloaded']).not.toBe(MESSAGES['cartera.ai_unavailable']);
    expect(MESSAGES['cartera.ai_region_blocked']).not.toBe(MESSAGES['cartera.ai_unavailable']);
  });

  it('acepta code en error (body { error, code } simétrico)', () => {
    expect(aiHttpErrorMessage({ status: 503, error: 'AI_OVERLOADED', code: 'AI_OVERLOADED', t }))
      .toBe(MESSAGES['cartera.ai_overloaded']);
  });

  it('traduce service_unavailable legacy del rateLimiter', () => {
    expect(aiHttpErrorMessage({ status: 503, error: 'service_unavailable', t }))
      .toBe(MESSAGES['cartera.ai_unavailable']);
  });

  it('503 sin code → genérico (no asume sobrecarga)', () => {
    expect(aiHttpErrorMessage({ status: 503, t }))
      .toBe(MESSAGES['cartera.ai_unavailable']);
  });

  it('no deja pasar snake_case crudo desconocido', () => {
    expect(aiHttpErrorMessage({ status: 500, error: 'internal_error', t }))
      .toBe(MESSAGES['cartera.ai_unavailable']);
  });
});
