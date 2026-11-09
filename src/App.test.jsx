import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('@/lib/customSupabaseClient', () => ({ supabase: {} }));

/** Raíz OSS → AuthPage con lazyPage (+ .preload), misma lista que main.jsx. */
let matchPublicRoute;

beforeAll(async () => {
  ({ matchPublicRoute } = await import('@/App'));
}, 30_000);

describe('App rutas públicas', () => {
  it('/ redirige la precarga a AuthPage (lazy con preload)', () => {
    const hit = matchPublicRoute('/');
    expect(hit).not.toBeNull();
    expect(typeof hit.Page.preload).toBe('function');
  });
});
