import { describe, it, expect } from 'vitest';
import { resolveLanguage, isAppRoute, fromNavigator } from './resolveLanguage.js';

describe('resolveLanguage', () => {
  it('el robot de Google (navegador en inglés) ve las páginas públicas en español', () => {
    expect(resolveLanguage({ pathname: '/', navigatorLang: 'en-US' })).toBe('es');
    expect(resolveLanguage({ pathname: '/calculadora-interes-compuesto', navigatorLang: 'en-US' })).toBe('es');
    expect(resolveLanguage({ pathname: '/blog/un-post', navigatorLang: 'en-US' })).toBe('es');
  });

  it('la app sigue al navegador, como antes: no se le cambia el idioma a nadie', () => {
    expect(resolveLanguage({ pathname: '/app', navigatorLang: 'en-GB' })).toBe('en');
    expect(resolveLanguage({ pathname: '/app/brokers', navigatorLang: 'es-ES' })).toBe('es');
  });

  it('lo que el visitante eligió manda en todas partes', () => {
    expect(resolveLanguage({ saved: 'en', pathname: '/', navigatorLang: 'es-ES' })).toBe('en');
    expect(resolveLanguage({ saved: 'es', pathname: '/app', navigatorLang: 'en-US' })).toBe('es');
  });

  it('una preferencia guardada que no es un idioma soportado se ignora', () => {
    expect(resolveLanguage({ saved: 'fr', pathname: '/', navigatorLang: 'en-US' })).toBe('es');
    expect(resolveLanguage({ saved: '', pathname: '/app', navigatorLang: 'en-US' })).toBe('en');
  });
});

describe('isAppRoute / fromNavigator', () => {
  it('solo /app y sus subrutas son la app; /apple o /application no', () => {
    expect(isAppRoute('/app')).toBe(true);
    expect(isAppRoute('/app/brokers')).toBe(true);
    expect(isAppRoute('/application')).toBe(false);
    expect(isAppRoute('/')).toBe(false);
    expect(isAppRoute('/auth')).toBe(false);
  });

  it('cualquier variante de español es español; lo demás, inglés', () => {
    expect(fromNavigator('es-MX')).toBe('es');
    expect(fromNavigator('ES')).toBe('es');
    expect(fromNavigator('de-DE')).toBe('en');
    expect(fromNavigator(undefined)).toBe('en');
  });
});
