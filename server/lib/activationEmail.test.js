import { describe, it, expect } from 'vitest';
import { selectActivationCandidates, buildActivationEmail, pickGuides, emailLanguage } from './activationEmail.js';

const NOW = new Date('2026-10-04T12:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const authUser = (over = {}) => ({
  id: 'u1', email: 'ana@example.com', email_confirmed_at: hoursAgo(30), created_at: hoursAgo(30),
  app_metadata: {}, user_metadata: {}, ...over,
});
const funnelRow = (over = {}) => ({ user_id: 'u1', transactions: 0, open_positions: 0, brokers: 0, beta_status: 'approved', ...over });
const select = (users, rows, extra = {}) => selectActivationCandidates({ authUsers: users, funnelRows: rows, now: NOW, ...extra });

describe('selectActivationCandidates', () => {
  it('elige a quien se registró hace 24–72 h, confirmó el email y no tiene operaciones', () => {
    expect(select([authUser()], [funnelRow()])).toEqual([{ userId: 'u1', email: 'ana@example.com', lang: 'es' }]);
  });

  it('respeta la ventana: ni antes de 24 h ni las cuentas antiguas', () => {
    expect(select([authUser({ created_at: hoursAgo(10) })], [funnelRow()])).toEqual([]);
    expect(select([authUser({ created_at: hoursAgo(80) })], [funnelRow()])).toEqual([]);
  });

  it('nunca a un email sin confirmar', () => {
    expect(select([authUser({ email_confirmed_at: null })], [funnelRow()])).toEqual([]);
  });

  it('nunca dos veces', () => {
    expect(select([authUser({ app_metadata: { activation_email_at: hoursAgo(1) } })], [funnelRow()])).toEqual([]);
    expect(select([authUser()], [funnelRow()], { alreadySent: new Set(['u1']) })).toEqual([]);
  });

  it('no a quien ya tiene operaciones o posiciones', () => {
    expect(select([authUser()], [funnelRow({ transactions: 3 })])).toEqual([]);
    expect(select([authUser()], [funnelRow({ open_positions: 1 })])).toEqual([]);
  });

  it('sin datos de cartera no se arriesga', () => {
    expect(select([authUser()], [])).toEqual([]);
  });

  it('respeta el interruptor de correos y las cuentas internas', () => {
    const prefsByUser = new Map([['u1', { email_notifications_enabled: false }]]);
    expect(select([authUser()], [funnelRow()], { prefsByUser })).toEqual([]);
    expect(select([authUser()], [funnelRow({ beta_status: 'rejected' })])).toEqual([]);
    expect(select([authUser()], [funnelRow()], { excludeIds: ['u1'] })).toEqual([]);
  });

  it('usa el idioma de Ajustes, si no el del registro', () => {
    expect(select([authUser({ user_metadata: { signup_source: { lang: 'en-US' } } })], [funnelRow()])[0].lang).toBe('en');
    const prefsByUser = new Map([['u1', { language: 'es' }]]);
    expect(select([authUser({ user_metadata: { signup_source: { lang: 'en-US' } } })], [funnelRow()], { prefsByUser })[0].lang).toBe('es');
  });
});

describe('emailLanguage', () => {
  it('por defecto español', () => {
    expect(emailLanguage(null, null)).toBe('es');
    expect(emailLanguage(null, { lang: 'es-ES' })).toBe('es');
  });
});

describe('pickGuides', () => {
  it('enseña los brokers que la persona ya creó', () => {
    expect(pickGuides(['Mi DeGiro', 'Trading212'])).toEqual(['degiro', 'trading212']);
    expect(pickGuides(['Interactive Brokers'])).toEqual(['ibkr']);
  });
  it('sin brokers reconocibles, los tres más habituales', () => {
    expect(pickGuides([])).toEqual(['degiro', 'ibkr', 'trading212']);
    expect(pickGuides(['Cuenta principal'])).toEqual(['degiro', 'ibkr', 'trading212']);
  });
});

describe('buildActivationEmail', () => {
  it('lleva los pasos, un botón al importador y el enlace de Ajustes', () => {
    const { subject, html, text } = buildActivationEmail({ lang: 'es', guides: ['degiro'] });
    expect(subject).toMatch(/cartera/);
    expect(html).toContain('https://example.com/app/brokers');
    expect(html).toContain('https://example.com/app/settings');
    expect(html).toContain('Estado de cuenta');
    expect(html).not.toContain('Trading 212');
    expect(text).toContain('DeGiro: Actividad');
  });
  it('en inglés', () => {
    const { subject, html } = buildActivationEmail({ lang: 'en' });
    expect(subject).toMatch(/portfolio/);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('Account statement');
  });
});
