import { describe, it, expect } from 'vitest';
import { shouldShowWelcome } from './welcomeSetup';

const now = new Date('2026-10-17T18:00:00Z');
const fresh = { created_at: '2026-10-17T17:55:00Z', user_metadata: {} };

describe('shouldShowWelcome', () => {
  it('una cuenta recién creada la ve', () => {
    expect(shouldShowWelcome({ user: fresh, now })).toBe(true);
  });
  it('una vez hecha, no vuelve (en cualquier dispositivo)', () => {
    expect(shouldShowWelcome({ user: { ...fresh, user_metadata: { welcome_completed_at: '2026-10-17T18:01:00Z' } }, now })).toBe(false);
    expect(shouldShowWelcome({ user: fresh, dismissedLocally: true, now })).toBe(false);
  });
  it('una cuenta antigua no la ve aunque no la hiciera', () => {
    expect(shouldShowWelcome({ user: { ...fresh, created_at: '2026-06-21T10:00:00Z' }, now })).toBe(false);
  });
  it('ni la demo ni mientras cargan las preferencias', () => {
    expect(shouldShowWelcome({ user: fresh, isDemoMode: true, now })).toBe(false);
    expect(shouldShowWelcome({ user: fresh, prefsLoading: true, now })).toBe(false);
    expect(shouldShowWelcome({ user: null, now })).toBe(false);
  });
});
